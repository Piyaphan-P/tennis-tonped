// ============================================================================
// ADGE Tennis — swing-capture gallery (Live overlay strip)
//
// A horizontally-swipeable strip of LARGE captured swing keyframes, newest
// first, each with the colored skeleton drawn over the image (via
// captureRenderer) plus the coach's / local per-frame critique. Tapping a
// card opens it full-screen in CaptureLightbox.
//
// PERF: never re-render per pose frame. We select the STABLE `shots` ref (which
// pushPoseFrame never touches), derive captures with useMemo, and each card
// renders its data-URL once via an effect keyed on the immutable capture.id.
// ============================================================================

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import type { DominantHand, ShotClip, SwingCapture } from '../types';
import { renderCaptureToDataUrl, colorForStatus } from '../analysis/captureRenderer';
import { formatSpeedKmh } from '../analysis/swingSpeed';
import CaptureLightbox from './CaptureLightbox';

interface GalleryItem {
  capture: SwingCapture;
  shotIndex: number;
  clip?: ShotClip;
  /** Shown once per shot (on the contact capture) — approximate km/h. */
  speedKmh?: number;
}

interface CaptureGalleryProps {
  /**
   * 'rail' = compact vertical thumbnail rail docked to the RIGHT edge of the
   * Live screen (small thumbs, no chips/critique — tap opens the lightbox for
   * detail) so captures never cover the player. Default 'strip' keeps the
   * original large swipeable layout.
   */
  variant?: 'strip' | 'rail';
}

export default function CaptureGallery({ variant = 'strip' }: CaptureGalleryProps) {
  const shots = useAppStore((s) => s.shots);
  const dominantHand = useAppStore((s) => s.settings.dominantHand);
  const t = useT();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [openItem, setOpenItem] = useState<GalleryItem | null>(null);
  const rail = variant === 'rail';

  // Newest capture first. Derived only when a shot is added (shots ref changes).
  // Clips are the PRIMARY card: a shot with a clip collapses to ONE item
  // (the contact capture, or the first capture, supplies the chips/critique
  // that render below the video). Shots without a clip (unsupported browser,
  // evicted/old shots) keep the original one-item-per-still fallback.
  const items = useMemo<GalleryItem[]>(() => {
    const out: GalleryItem[] = [];
    for (const shot of shots) {
      if (shot.clip) {
        const capture =
          shot.captures.find((c) => c.phase === 'contact') ?? shot.captures[0];
        if (capture) {
          out.push({ capture, shotIndex: shot.index, clip: shot.clip, speedKmh: shot.speedKmh });
        }
        continue;
      }
      for (const capture of shot.captures) {
        // Show the speed chip once per shot — on the contact keyframe only, so
        // a clip-less multi-capture shot doesn't repeat it on every frame.
        const speedKmh = capture.phase === 'contact' ? shot.speedKmh : undefined;
        out.push({ capture, shotIndex: shot.index, speedKmh });
      }
    }
    return out.reverse();
  }, [shots]);

  // Auto-show the newest capture: whenever a new one lands (items is
  // newest-first, so items[0] changes), scroll the strip back to the start.
  const newestId = items[0]?.capture.id;
  useEffect(() => {
    if (!newestId) return;
    stripRef.current?.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  }, [newestId]);

  // Empty state: show a subtle placeholder so the feature is visibly present
  // and "waiting" before the first capture lands — never a blank void.
  if (items.length === 0) {
    return (
      <div
        className={`capture-gallery capture-gallery-empty${rail ? ' capture-gallery-rail' : ''}`}
      >
        <div className="capture-empty dim">{t('gallery.empty')}</div>
      </div>
    );
  }

  return (
    <div className={`capture-gallery${rail ? ' capture-gallery-rail' : ''}`}>
      <div className="capture-gallery-head">
        <span className="capture-gallery-title">{t('live.captures')}</span>
        <span className="num faint">{items.length}</span>
      </div>
      <div className="capture-strip" ref={stripRef}>
        {items.map((it) => (
          <CaptureCard
            key={it.capture.id}
            capture={it.capture}
            shotIndex={it.shotIndex}
            clip={it.clip}
            speedKmh={it.speedKmh}
            isNewest={it.capture.id === newestId}
            dominantHand={dominantHand}
            compact={rail}
            onOpen={() => setOpenItem(it)}
          />
        ))}
      </div>

      {openItem && (
        <CaptureLightbox
          capture={openItem.capture}
          shotIndex={openItem.shotIndex}
          clip={openItem.clip}
          dominantHand={dominantHand}
          onClose={() => setOpenItem(null)}
        />
      )}
    </div>
  );
}

interface CaptureCardProps {
  capture: SwingCapture;
  shotIndex: number;
  clip?: ShotClip;
  /** Approximate km/h swing speed (undefined = not shown for this card). */
  speedKmh?: number;
  /** Only the newest clip card autoplays — one active decoder at a time. */
  isNewest?: boolean;
  dominantHand: DominantHand;
  /** Rail mode: thumbnail only (no chips/critique) — detail lives in the lightbox. */
  compact?: boolean;
  onOpen: () => void;
}

const CaptureCard = memo(function CaptureCard({
  capture,
  shotIndex,
  clip,
  speedKmh,
  isNewest = false,
  dominantHand,
  compact = false,
  onOpen,
}: CaptureCardProps) {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const speedText = formatSpeedKmh(speedKmh, lang);
  const [url, setUrl] = useState<string | null>(null);
  // Clip failed to decode (codec quirk / revoked URL) → show the rendered
  // still instead of a black <video> box. Mirrors CaptureLightbox's fallback.
  const [clipFailed, setClipFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const showClip = !!clip && !clipFailed;

  // Render the image + skeleton overlay once (capture is immutable by id).
  // Still needed even for clip cards: it supplies the chips/critique below
  // the video, and is the fallback if the clip fails to decode.
  useEffect(() => {
    let cancelled = false;
    renderCaptureToDataUrl(capture, dominantHand)
      .then((dataUrl) => {
        if (!cancelled) setUrl(dataUrl);
      })
      .catch(() => {
        // Decode failed — fall back to the raw jpeg so the card isn't blank.
        if (!cancelled) setUrl(`data:image/jpeg;base64,${capture.jpegBase64}`);
      });
    return () => {
      cancelled = true;
    };
  }, [capture, dominantHand]);

  // Only the newest full-size clip card decodes/plays (one active decoder).
  // Rail/compact clip thumbs never autoplay — they stay paused on frame 1.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !showClip || compact) return;
    if (isNewest) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [showClip, isNewest, compact]);

  const a = capture.angles;
  const s = capture.statuses;
  const elbow = Math.round(dominantHand === 'right' ? a.rightElbowDeg : a.leftElbowDeg);
  const lKnee = Math.round(a.leftKneeDeg);
  const rKnee = Math.round(a.rightKneeDeg);
  const trunk = Math.round(a.trunkLeanDeg);

  const phaseKey = `phase.${capture.phase}` as I18nKey;
  const critique =
    capture.critique ?? (capture.phase === 'contact' ? t('capture.pending') : '');
  const critiquePending = !capture.critique;

  // Rail mode: image-only thumb (phase + shot tags stay); everything else —
  // chips, critique, tap-hint — lives in the lightbox the tap opens.
  if (compact) {
    return (
      <figure className="capture-card capture-card-mini tap" onClick={onOpen} role="button" tabIndex={0}>
        <div className="capture-img-wrap">
          {showClip ? (
            // Rail thumbs never autoplay (many can be visible at once) —
            // paused on frame 1; tapping opens the lightbox to watch.
            <video
              ref={videoRef}
              className="capture-video"
              src={clip!.url}
              muted
              loop
              playsInline
              preload="metadata"
              onError={() => setClipFailed(true)}
            />
          ) : url ? (
            <img className="capture-img" src={url} alt={t(phaseKey)} />
          ) : (
            <div className="capture-img capture-img-loading" />
          )}
          <span className="capture-shot-tag num">
            {t('capture.shot')} {shotIndex}
          </span>
        </div>
      </figure>
    );
  }

  return (
    <figure className="capture-card tap" onClick={onOpen} role="button" tabIndex={0}>
      <div className="capture-img-wrap">
        {showClip ? (
          <video
            ref={videoRef}
            className="capture-video"
            src={clip!.url}
            muted
            loop
            playsInline
            preload="metadata"
            autoPlay={isNewest}
            onError={() => setClipFailed(true)}
          />
        ) : url ? (
          <img className="capture-img" src={url} alt={t(phaseKey)} />
        ) : (
          <div className="capture-img capture-img-loading">{t('common.loading')}</div>
        )}
        {showClip && <span className="capture-clip-badge">{t('clip.badge')}</span>}
        <span className="capture-phase-tag">{t(phaseKey)}</span>
        <span className="capture-shot-tag num">
          {t('capture.shot')} {shotIndex}
        </span>
        <span className="capture-tap-hint">{showClip ? t('gallery.clipHint') : t('capture.tapHint')}</span>
      </div>
      <div className="capture-chips">
        <span className="capture-chip num" style={{ color: colorForStatus(s.domElbow) }}>
          <em>elbow</em> {elbow}°
        </span>
        <span className="capture-chip num" style={{ color: colorForStatus(s.leftKnee) }}>
          <em>L-knee</em> {lKnee}°
        </span>
        <span className="capture-chip num" style={{ color: colorForStatus(s.rightKnee) }}>
          <em>R-knee</em> {rKnee}°
        </span>
        <span className="capture-chip num" style={{ color: colorForStatus(s.trunk) }}>
          <em>trunk</em> {trunk}°
        </span>
        {speedText && (
          <span className="capture-chip num" style={{ color: 'var(--accent)' }}>
            <em>{t('speed.label')}</em> {speedText}
          </span>
        )}
      </div>
      <figcaption className={`capture-critique${critiquePending ? ' capture-pulse' : ''}`}>
        {critique}
      </figcaption>
    </figure>
  );
});

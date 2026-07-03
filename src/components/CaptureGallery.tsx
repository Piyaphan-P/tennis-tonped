// ============================================================================
// ต้นและเพชร Tennis Club — swing-capture gallery (Live overlay strip)
//
// A horizontally-swipeable strip of LARGE captured swing keyframes, newest
// first, each with the colored skeleton drawn over the image (via
// captureRenderer) plus the coach's / local per-frame critique.
//
// PERF: never re-render per pose frame. We select the STABLE `shots` ref (which
// pushPoseFrame never touches), derive captures with useMemo, and each card
// renders its data-URL once via an effect keyed on the immutable capture.id.
// ============================================================================

import { memo, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import type { DominantHand, SwingCapture } from '../types';
import { renderCaptureToDataUrl, colorForStatus } from '../analysis/captureRenderer';

interface GalleryItem {
  capture: SwingCapture;
  shotIndex: number;
}

export default function CaptureGallery() {
  const shots = useAppStore((s) => s.shots);
  const dominantHand = useAppStore((s) => s.settings.dominantHand);
  const t = useT();

  // Newest capture first. Derived only when a shot is added (shots ref changes).
  const items = useMemo<GalleryItem[]>(() => {
    const out: GalleryItem[] = [];
    for (const shot of shots) {
      for (const capture of shot.captures) {
        out.push({ capture, shotIndex: shot.index });
      }
    }
    return out.reverse();
  }, [shots]);

  if (items.length === 0) return null;

  return (
    <div className="capture-gallery">
      <div className="capture-gallery-head">
        <span className="capture-gallery-title">{t('live.captures')}</span>
        <span className="num faint">{items.length}</span>
      </div>
      <div className="capture-strip">
        {items.map((it) => (
          <CaptureCard
            key={it.capture.id}
            capture={it.capture}
            shotIndex={it.shotIndex}
            dominantHand={dominantHand}
          />
        ))}
      </div>
    </div>
  );
}

interface CaptureCardProps {
  capture: SwingCapture;
  shotIndex: number;
  dominantHand: DominantHand;
}

const CaptureCard = memo(function CaptureCard({
  capture,
  shotIndex,
  dominantHand,
}: CaptureCardProps) {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const [url, setUrl] = useState<string | null>(null);

  // Render the image + skeleton overlay once (capture is immutable by id).
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

  return (
    <figure className="capture-card">
      <div className="capture-img-wrap">
        {url ? (
          <img className="capture-img" src={url} alt={t(phaseKey)} />
        ) : (
          <div className="capture-img capture-img-loading">{t('common.loading')}</div>
        )}
        <span className="capture-phase-tag">{t(phaseKey)}</span>
        <span className="capture-shot-tag num">
          {t('capture.shot')} {shotIndex}
        </span>
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
      </div>
      <figcaption className={`capture-critique${critiquePending ? ' capture-pulse' : ''}`}>
        {critique}
      </figcaption>
    </figure>
  );
});

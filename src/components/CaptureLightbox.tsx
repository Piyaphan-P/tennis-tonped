// ============================================================================
// ADGE Tennis — CaptureLightbox
//
// Full-screen scrim rendered ABOVE the live overlay (and above Summary),
// showing one SwingCapture LARGE: the skeleton-overlaid image (same renderer
// as the gallery strip, so it's pixel-identical — just bigger), phase + shot
// tags, the four judged-angle chips, and the critique (or a pending state for
// a contact frame still awaiting the coach). Closes via the scrim, the close
// button, or Escape.
//
// Self-contained: takes the capture + its owning shot index + dominant hand,
// used from both LiveScreen (CaptureGallery) and SummaryScreen.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import type { DominantHand, ShotClip, SwingCapture } from '../types';
import { renderCaptureToDataUrl, colorForStatus } from '../analysis/captureRenderer';

interface CaptureLightboxProps {
  capture: SwingCapture;
  shotIndex: number;
  clip?: ShotClip;
  dominantHand: DominantHand;
  onClose: () => void;
}

export default function CaptureLightbox({
  capture,
  shotIndex,
  clip,
  dominantHand,
  onClose,
}: CaptureLightboxProps) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  // Dropped to true if the clip <video> fails to decode/load (e.g. a
  // revoked blob: URL) — falls back to the still, same as an absent clip.
  const [clipFailed, setClipFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const showClip = !!clip && !clipFailed;

  useEffect(() => {
    let cancelled = false;
    renderCaptureToDataUrl(capture, dominantHand)
      .then((dataUrl) => {
        if (!cancelled) setUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(`data:image/jpeg;base64,${capture.jpegBase64}`);
      });
    return () => {
      cancelled = true;
    };
  }, [capture, dominantHand]);

  const handleReplay = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const a = capture.angles;
  const s = capture.statuses;
  const elbow = Math.round(dominantHand === 'right' ? a.rightElbowDeg : a.leftElbowDeg);
  const lKnee = Math.round(a.leftKneeDeg);
  const rKnee = Math.round(a.rightKneeDeg);
  const trunk = Math.round(a.trunkLeanDeg);

  const phaseKey = `phase.${capture.phase}` as I18nKey;
  const critique = capture.critique ?? (capture.phase === 'contact' ? t('capture.pending') : '');
  const critiquePending = !capture.critique;

  return (
    <div
      className="capture-lightbox-scrim"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t(phaseKey)}
    >
      <div className="capture-lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="capture-lightbox-img-wrap">
          {showClip ? (
            <video
              ref={videoRef}
              className="capture-lightbox-video"
              src={clip!.url}
              muted
              loop
              autoPlay
              playsInline
              onError={() => setClipFailed(true)}
            />
          ) : url ? (
            <img className="capture-lightbox-img" src={url} alt={t(phaseKey)} />
          ) : (
            <div className="capture-lightbox-img capture-img-loading">{t('common.loading')}</div>
          )}
          {showClip && (
            <button
              type="button"
              className="clip-replay-btn tap"
              onClick={(e) => {
                e.stopPropagation();
                handleReplay();
              }}
            >
              {t('clip.replay')}
            </button>
          )}
          <span className="capture-phase-tag">{t(phaseKey)}</span>
          <span className="capture-shot-tag num">
            {t('capture.shot')} {shotIndex}
          </span>
        </div>

        <div className="capture-lightbox-body">
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
          <p className={`capture-critique${critiquePending ? ' capture-pulse' : ''}`}>
            {critique}
          </p>
        </div>

        <button
          type="button"
          className="btn btn-block capture-lightbox-close"
          onClick={onClose}
        >
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}

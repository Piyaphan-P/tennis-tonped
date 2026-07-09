// ============================================================================
// ADGE Tennis — StoryShareButton
//
// Thin wrapper around the storyRenderer contract. One tap:
//   1. render a 9:16 story — VIDEO from the shot's clip when available
//      (renderStoryVideo), automatic fallback to a 1080x1920 image
//      (renderStoryImage) when there's no clip / MediaRecorder is unsupported
//      / the clip won't decode;
//   2. hand the resulting Blob to shareStory, which opens the native
//      IG / Facebook / TikTok share sheet (navigator.share) or, when that's
//      unavailable, downloads the file and we surface a bilingual "saved" note.
//
// The button owns only its busy + toast state; all StoryData is built by the
// caller (DevPlanScreen). Rendering is async (canvas + MediaRecorder), so the
// UI thread is never visibly blocked — the button just shows a busy label.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { DominantHand, ShotClip, SwingCapture } from '../types';
import type { StoryData } from '../share/storyRenderer';
import { renderStoryImage, renderStoryVideo, shareStory } from '../share/storyRenderer';

interface StoryShareButtonProps {
  capture: SwingCapture;
  hand: DominantHand;
  data: StoryData;
  /** Optional swing clip — when present, a video story is attempted first. */
  clip?: ShotClip;
  /** Filename stem (no extension); the extension follows the produced blob. */
  filenameBase: string;
  /** Button copy (defaults to the generic "share" label). */
  label?: string;
  /** Visual weight. 'primary' for the session highlight, 'ghost' on cards. */
  variant?: 'primary' | 'ghost';
}

type ToastKind = 'saved' | 'error' | null;

function extForBlob(blob: Blob): string {
  const type = blob.type || '';
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('webm')) return 'webm';
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  return 'png';
}

export default function StoryShareButton({
  capture,
  hand,
  data,
  clip,
  filenameBase,
  label,
  variant = 'ghost',
}: StoryShareButtonProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastKind>(null);
  // Track mount so async render/share never setState after unmount.
  const aliveRef = useRef(true);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const flashToast = (kind: ToastKind) => {
    if (!aliveRef.current) return;
    setToast(kind);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      if (aliveRef.current) setToast(null);
    }, 6000);
  };

  const onShare = async () => {
    if (busy) return;
    setBusy(true);
    setToast(null);
    try {
      // Prefer a video story when the shot has a session clip; fall back to
      // the still image if the renderer declines (null) or there's no clip.
      let blob: Blob | null = null;
      if (clip) {
        try {
          blob = await renderStoryVideo(clip, capture, hand, data);
        } catch {
          blob = null;
        }
      }
      if (!blob) {
        blob = await renderStoryImage(capture, hand, data);
      }
      const filename = `${filenameBase}.${extForBlob(blob)}`;
      const result = await shareStory(blob, filename);
      if (result === 'downloaded') flashToast('saved');
    } catch {
      flashToast('error');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const cls = variant === 'primary' ? 'btn btn-primary' : 'btn btn-ghost';

  return (
    <div className="story-share">
      <button
        type="button"
        className={`${cls} story-share-btn tap`}
        onClick={onShare}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? (
          <>
            <span className="story-spinner" aria-hidden="true" />
            {t('devplan.sharing')}
          </>
        ) : (
          <>
            <span aria-hidden="true">↗</span>
            {label ?? t('devplan.share')}
          </>
        )}
      </button>
      {toast && (
        <p
          className={`story-toast ${toast === 'error' ? 'story-toast-err' : ''}`}
          role="status"
        >
          {toast === 'saved' ? t('devplan.savedToast') : t('devplan.shareError')}
        </p>
      )}
    </div>
  );
}

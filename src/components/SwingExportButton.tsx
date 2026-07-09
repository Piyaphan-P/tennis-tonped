// ============================================================================
// ADGE Tennis — SwingExportButton (v1.0 history share-a-swing)
//
// Per-shot Save/Share on a history clip card. Renders a 9:16 export video (the
// swing clip + coach voice + score/radar/fix chrome) via swingExportRenderer,
// then lets the player SAVE (anchor download) or SHARE (native IG/FB sheet).
//
// TWO-STEP, activation-safe (v0.8 lesson): a long realtime render can outlive
// the tap's user-activation, so navigator.share() would silently degrade. So
// the FIRST tap only renders → "พร้อมแล้ว"; Save/Share then act on the cached
// Blob under a fresh gesture. Reuses the shipped shareStory() (native sheet +
// download fallback + hang watchdog) unchanged. Never throws to the UI.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { shareStory } from '../share/storyRenderer';
import {
  exportSwingVideo,
  saveSwingVideo,
  exportFilename,
  type SwingExportOpts,
} from '../share/swingExportRenderer';

interface Props {
  opts: SwingExportOpts;
}

type Status = 'idle' | 'rendering' | 'ready' | 'error';

export default function SwingExportButton({ opts }: Props) {
  const t = useT();
  const [status, setStatus] = useState<Status>('idle');
  const blobRef = useRef<Blob | null>(null);
  // Guard async setState after unmount (render can take clip-length seconds).
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // A change to the shot/language invalidates any cached render. Keyed on the
  // STABLE clipSrc string (per-shot blob:/api URL) + lang — never on the audio
  // Blob identity, which may be a fresh reference each render and would nuke the
  // cache on every HistoryScreen re-render. The audio PRESENCE flag is a dep,
  // though: a swing exported while the coach was still speaking caches a SILENT
  // video; when the voice lands moments later the cache must re-render with it.
  const hasAudio = opts.audioSrc != null;
  useEffect(() => {
    blobRef.current = null;
    setStatus('idle');
  }, [opts.clipSrc, opts.lang, hasAudio]);

  /** Render the export video into blobRef; resolves the ready Blob or null. */
  const ensureBlob = async (): Promise<Blob | null> => {
    if (blobRef.current) return blobRef.current;
    setStatus('rendering');
    let blob: Blob | null = null;
    try {
      blob = await exportSwingVideo(opts);
    } catch {
      blob = null;
    }
    if (!aliveRef.current) return blob;
    if (blob) {
      blobRef.current = blob;
      setStatus('ready');
    } else {
      setStatus('error');
    }
    return blob;
  };

  const onSave = async () => {
    if (status === 'rendering') return;
    const blob = blobRef.current;
    if (blob) {
      saveSwingVideo(blob, exportFilename(opts.shotIndex, blob.type));
      return;
    }
    await ensureBlob(); // first tap just renders → "ready"; tap again to save
  };

  const onShare = async () => {
    if (status === 'rendering') return;
    const blob = blobRef.current;
    if (blob) {
      try {
        await shareStory(blob, exportFilename(opts.shotIndex, blob.type));
      } catch {
        if (aliveRef.current) setStatus('error');
      }
      return;
    }
    await ensureBlob(); // first tap just renders → "ready"; tap again to share
  };

  const rendering = status === 'rendering';

  return (
    <div className="swing-export">
      <div className="swing-export-row">
        <button
          type="button"
          className="btn btn-primary swing-export-btn tap"
          onClick={onSave}
          disabled={rendering}
          aria-busy={rendering}
        >
          {rendering ? (
            <>
              <span className="story-spinner" aria-hidden="true" />
              {t('history.export.rendering')}
            </>
          ) : (
            <>
              <span aria-hidden="true">⬇</span>
              {t('history.export.save')}
            </>
          )}
        </button>
        <button
          type="button"
          className="btn btn-ghost swing-export-btn tap"
          onClick={onShare}
          disabled={rendering}
          aria-busy={rendering}
        >
          <span aria-hidden="true">↗</span>
          {t('history.export.share')}
        </button>
      </div>
      {status === 'ready' && (
        <p className="swing-export-note t-good" role="status">
          {t('history.export.ready')}
        </p>
      )}
      {status === 'error' && (
        <p className="swing-export-note t-fault" role="status">
          {t('history.export.failed')}
        </p>
      )}
    </div>
  );
}

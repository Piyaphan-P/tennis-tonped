// ============================================================================
// ADGE Tennis — DevPlanShareButton (v2.4)
//
// Save/Share the development-PLAN card (1080×1920 PNG from devPlanRenderer) —
// the fix for "the share showed the player's swing photo instead of the plan".
// TWO-STEP, activation-safe (same pattern as StatsShareButton): first tap
// renders → "พร้อมแล้ว"; Save/Share then act on the cached Blob under a fresh
// gesture. Reuses shareStory() (native sheet + download + hang watchdog) and
// saveSwingVideo() (anchor download) unchanged. Never throws to the UI.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { shareStory } from '../share/storyRenderer';
import { saveSwingVideo } from '../share/swingExportRenderer';
import {
  renderDevPlanCard,
  devPlanCardFilename,
  type DevPlanCardData,
} from '../share/devPlanRenderer';

interface Props {
  data: DevPlanCardData;
}

type Status = 'idle' | 'rendering' | 'ready' | 'error';

export default function DevPlanShareButton({ data }: Props) {
  const t = useT();
  const [status, setStatus] = useState<Status>('idle');
  const blobRef = useRef<Blob | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Invalidate any cached render when the plan content / language changes.
  const cacheKey = JSON.stringify([
    data.lang,
    data.playerName,
    data.dateLabel,
    data.areas.map((a) => [a.title, a.shots, a.cue]),
  ]);
  useEffect(() => {
    blobRef.current = null;
    setStatus('idle');
  }, [cacheKey]);

  const ensureBlob = async (): Promise<Blob | null> => {
    if (blobRef.current) return blobRef.current;
    setStatus('rendering');
    let blob: Blob | null = null;
    try {
      const b = await renderDevPlanCard(data);
      blob = b && b.size > 0 ? b : null;
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
      saveSwingVideo(blob, devPlanCardFilename());
      return;
    }
    await ensureBlob(); // first tap renders → "ready"; tap again to save
  };

  const onShare = async () => {
    if (status === 'rendering') return;
    const blob = blobRef.current;
    if (blob) {
      try {
        await shareStory(blob, devPlanCardFilename());
      } catch {
        if (aliveRef.current) setStatus('error');
      }
      return;
    }
    await ensureBlob(); // first tap renders → "ready"; tap again to share
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
              {t('stats.share.rendering')}
            </>
          ) : (
            <>
              <span aria-hidden="true">⬇</span>
              {t('devplan.shareSummary')}
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
          {t('stats.share.share')}
        </button>
      </div>
      {status === 'ready' && (
        <p className="swing-export-note t-good" role="status">
          {t('stats.share.ready')}
        </p>
      )}
      {status === 'error' && (
        <p className="swing-export-note t-fault" role="status">
          {t('stats.share.failed')}
        </p>
      )}
    </div>
  );
}

// ============================================================================
// ADGE Tennis — StatsShareButton (v1.8 session-stats widget + share)
//
// Save/Share the session-stats card (1080×1920 PNG from statsCardRenderer).
// TWO-STEP, activation-safe (same lesson as SwingExportButton): the first tap
// renders → "พร้อมแล้ว"; Save/Share then act on the cached Blob under a fresh
// gesture. Reuses the shipped shareStory() (native IG/FB/TikTok sheet + download
// fallback + hang watchdog) and saveSwingVideo() (generic anchor download)
// unchanged. Never throws to the UI.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { shareStory } from '../share/storyRenderer';
import { saveSwingVideo } from '../share/swingExportRenderer';
import {
  renderStatsCard,
  statsCardFilename,
  type StatsCardData,
} from '../share/statsCardRenderer';

interface Props {
  data: StatsCardData;
}

type Status = 'idle' | 'rendering' | 'ready' | 'error';

export default function StatsShareButton({ data }: Props) {
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

  // Invalidate any cached render when the underlying figures/language change.
  const cacheKey = JSON.stringify([
    data.lang,
    data.minutes,
    data.shots,
    data.avgSpeedKmh,
    data.kcal,
    data.spin,
    data.cumMinutes,
    data.cumShots,
    data.cumAvgSpeedKmh,
    data.cumKcal,
  ]);
  useEffect(() => {
    blobRef.current = null;
    setStatus('idle');
  }, [cacheKey]);

  /** Render the stats card into blobRef; resolves the ready Blob or null. */
  const ensureBlob = async (): Promise<Blob | null> => {
    if (blobRef.current) return blobRef.current;
    setStatus('rendering');
    let blob: Blob | null = null;
    try {
      const b = await renderStatsCard(data);
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
      saveSwingVideo(blob, statsCardFilename());
      return;
    }
    await ensureBlob(); // first tap renders → "ready"; tap again to save
  };

  const onShare = async () => {
    if (status === 'rendering') return;
    const blob = blobRef.current;
    if (blob) {
      try {
        await shareStory(blob, statsCardFilename());
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
              {t('stats.share.save')}
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

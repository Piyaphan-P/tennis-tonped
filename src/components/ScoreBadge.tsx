import { useAppStore, selectLatestShot } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';

/** Color a 0–100 score by the court-night semantic palette. */
function scoreColor(score: number): string {
  if (score >= 80) return 'var(--good)';
  if (score >= 60) return 'var(--warn)';
  return 'var(--fault)';
}

interface ScoreBadgeProps {
  /** Compact pill for the Live overlay (big number + shot type only). */
  compact?: boolean;
}

/**
 * Live score badge for the most recently completed shot. `compact` renders a
 * small overlay pill (number + type); the default is the full card (number +
 * type + worst-issue callout).
 */
export default function ScoreBadge({ compact = false }: ScoreBadgeProps) {
  const latest = useAppStore(selectLatestShot);
  const lang = useAppStore((s) => s.lang);
  const t = useT();

  if (!latest) {
    if (compact) {
      return (
        <span className="score-pill" aria-live="polite">
          <span className="dim" style={{ fontSize: '0.72rem' }}>
            {t('score.waiting')}
          </span>
        </span>
      );
    }
    return (
      <div className="score-badge" aria-live="polite">
        <span className="dim">{t('score.waiting')}</span>
      </div>
    );
  }

  const color = scoreColor(latest.score);
  const typeKey = `shot.${latest.type}` as I18nKey;

  if (compact) {
    return (
      <span className="score-pill" aria-live="polite">
        <span className="score-pill-num num" style={{ color }}>
          {Math.round(latest.score)}
        </span>
        <span className="dim" style={{ fontSize: '0.72rem' }}>
          {t(typeKey)}
        </span>
      </span>
    );
  }

  // Worst issue first (fault > warn > good) for the one-line callout.
  const rank = { fault: 0, warn: 1, good: 2 } as const;
  const topIssue = [...latest.issues].sort(
    (a, b) => rank[a.severity] - rank[b.severity],
  )[0];
  const issueText = topIssue ? (lang === 'th' ? topIssue.messageTH : topIssue.messageEN) : '';

  return (
    <div className="score-badge" aria-live="polite">
      <div className="score-badge-num" style={{ color }}>
        {Math.round(latest.score)}
      </div>
      <div className="col" style={{ gap: 2, minWidth: 0 }}>
        <span className="dim" style={{ fontSize: '0.75rem' }}>
          {t('score.latest')} · {t(typeKey)}
        </span>
        <span
          style={{
            fontSize: '0.85rem',
            color,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {issueText}
        </span>
      </div>
    </div>
  );
}

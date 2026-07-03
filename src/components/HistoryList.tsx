// ============================================================================
// ต้นและเพชร Tennis Club — Session history list
//
// Lists finished sessions persisted to localStorage (StoredSession[]), which
// auto-expire after 3 days (HISTORY_TTL_MS, pruned in the store on load and
// on every save). Newest session first, with a tiny sparkline showing the
// avgScore trend across stored sessions (oldest -> newest, left to right).
// ============================================================================

import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { Lang, StoredSession } from '../types';

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--good)';
  if (score >= 60) return 'var(--warn)';
  return 'var(--fault)';
}

function fmtWhen(tsMs: number, lang: Lang): string {
  const locale = lang === 'th' ? 'th-TH' : 'en-US';
  return new Date(tsMs).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Tiny inline sparkline of session avgScore, oldest -> newest, left -> right. */
function TrendSparkline({ sessions }: { sessions: StoredSession[] }) {
  const W = 120;
  const H = 28;
  const pad = 3;
  if (sessions.length < 2) return null;

  // sessions here are oldest-first (chronological)
  const pts = sessions.map((s, i) => {
    const x = pad + (i * (W - pad * 2)) / (sessions.length - 1);
    const y = pad + ((100 - s.avgScore) / 100) * (H - pad * 2);
    return [x, y] as const;
  });
  const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="session score trend"
      style={{ display: 'block' }}
    >
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--accent)" />
    </svg>
  );
}

/** Session history with the 3-day auto-expiry note. */
export default function HistoryList() {
  const history = useAppStore((s) => s.history);
  const lang = useAppStore((s) => s.lang);
  const t = useT();

  // store.history is oldest-first; show newest-first, keep chronological for the trend.
  const newestFirst = [...history].reverse();

  return (
    <div className="history-list card col" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{t('history.title')}</h3>
        {history.length >= 2 && <TrendSparkline sessions={history} />}
      </div>

      {newestFirst.length === 0 ? (
        <p className="dim" style={{ fontSize: '0.85rem' }}>
          {t('history.empty')}
        </p>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          {newestFirst.map((s) => (
            <div key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span className="dim" style={{ fontSize: '0.85rem' }}>
                {fmtWhen(s.tsMs, lang)}
              </span>
              <span className="num" style={{ fontSize: '0.85rem' }}>
                {s.shotCount} {t('history.shots')} ·{' '}
                <span style={{ color: scoreColor(s.avgScore), fontWeight: 700 }}>
                  {s.avgScore.toFixed(0)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      <span className="faint" style={{ fontSize: '0.75rem' }}>
        {t('history.expiryNote')}
      </span>
    </div>
  );
}

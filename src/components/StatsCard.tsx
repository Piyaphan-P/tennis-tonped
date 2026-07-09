// ============================================================================
// ADGE Tennis — Your Stats card
//
// Cross-session aggregate stats (avg score, shot count, % good form, best
// speed) shown on Home. Data comes from selectUserStats, derived from the
// 3-day-pruned history (store.ts / deriveStats). Hidden entirely until the
// player has at least one stored session.
// ============================================================================

import { useAppStore, selectUserStats } from '../store';
import { useT } from '../i18n';

/** Cross-session "Your Stats" summary card for Home. */
export default function StatsCard() {
  const stats = useAppStore(selectUserStats);
  const t = useT();

  if (stats.sessions === 0) return null;

  const row = (label: string, value: string) => (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span className="dim" style={{ fontSize: '0.85rem' }}>
        {label}
      </span>
      <span className="num" style={{ fontWeight: 700 }}>
        {value}
      </span>
    </div>
  );

  return (
    <div className="stats-card card col" style={{ gap: 8 }}>
      <h3>{t('stats.title')}</h3>
      {row(t('stats.sessions'), String(stats.sessions))}
      {row(t('stats.totalShots'), String(stats.totalShots))}
      {row(t('stats.avgScore'), stats.avgScore.toFixed(0))}
      {row(t('stats.goodForm'), `${stats.goodFormPct.toFixed(0)}%`)}
      {row(t('stats.bestSpeed'), `${stats.bestPeakWristSpeed.toFixed(1)} u/s`)}
    </div>
  );
}

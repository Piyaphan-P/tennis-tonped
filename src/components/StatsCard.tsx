// ============================================================================
// ADGE Tennis — Your Stats card
//
// Cross-session aggregate stats (avg score, shot count, % good form, best
// speed) shown on Home — for the CURRENT player only (selectUserStats filters
// the shared-device history by userName; players must never merge). Hidden
// entirely until this player has at least one stored session.
// ============================================================================

import { useAppStore, selectUserStats } from '../store';
import { useT } from '../i18n';

/** Cross-session "Your Stats" summary card for Home (current player only). */
export default function StatsCard() {
  const stats = useAppStore(selectUserStats);
  const userName = useAppStore((s) => s.settings.userName);
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
      <h3>
        {t('stats.title')}
        {userName.trim() ? ` — ${userName.trim()}` : ''}
      </h3>
      {row(t('stats.sessions'), String(stats.sessions))}
      {row(t('stats.totalShots'), String(stats.totalShots))}
      {row(t('stats.avgScore'), stats.avgScore.toFixed(0))}
      {row(t('stats.goodForm'), `${stats.goodFormPct.toFixed(0)}%`)}
      {row(t('stats.bestSpeed'), `${stats.bestPeakWristSpeed.toFixed(1)} u/s`)}
    </div>
  );
}

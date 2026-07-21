// ============================================================================
// ADGE Tennis — Admin daily overview (Home, admin accounts only)
//
// Replaces the player stats/history widgets on Home when the signed-in role
// is admin: instead of a merged session list, admins see per-DAY aggregates —
// how many distinct players came, how many sessions/shots, and which hours of
// the day they played (distinct players per hour).
//
// Data = GET /api/history (admin receives ALL players' sessions, 3-day TTL);
// grouping is pure (deriveAdminDaily) and uses device-local time.
// ============================================================================

import { useEffect, useState } from 'react';
import { fetchHistory } from '../data/api';
import { deriveAdminDaily, type AdminDayRow } from '../history/playerStats';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { Lang } from '../types';

function fmtDay(dayStartMs: number, lang: Lang): string {
  const locale = lang === 'th' ? 'th-TH' : 'en-US';
  return new Date(dayStartMs).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function fmtHour(hour: number): string {
  const h = String(hour).padStart(2, '0');
  const next = String((hour + 1) % 24).padStart(2, '0');
  return `${h}:00–${next}:00`;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; days: AdminDayRow[] };

/** Daily player-traffic overview for admins (Home). */
export default function AdminDailyStats() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const lang = useAppStore((s) => s.lang);
  const t = useT();

  const load = () => {
    setState({ kind: 'loading' });
    void fetchHistory(3).then((rows) => {
      if (rows === null) setState({ kind: 'error' });
      else setState({ kind: 'ready', days: deriveAdminDaily(rows) });
    });
  };
  useEffect(load, []);

  const maxHourPlayers =
    state.kind === 'ready'
      ? Math.max(1, ...state.days.flatMap((d) => d.hours.map((h) => h.players)))
      : 1;

  return (
    <div className="card col" style={{ gap: 10 }}>
      <h3>{t('adminDaily.title')}</h3>

      {state.kind === 'loading' && (
        <p className="dim" style={{ fontSize: '0.85rem' }}>
          {t('history.loading')}
        </p>
      )}

      {state.kind === 'error' && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="dim" style={{ fontSize: '0.85rem' }}>
            {t('history.loadFailed')}
          </span>
          <button className="btn btn-ghost tap" onClick={load}>
            {t('history.retry')}
          </button>
        </div>
      )}

      {state.kind === 'ready' && state.days.length === 0 && (
        <p className="dim" style={{ fontSize: '0.85rem' }}>
          {t('adminDaily.empty')}
        </p>
      )}

      {state.kind === 'ready' &&
        state.days.map((day) => (
          <div key={day.dayKey} className="col" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 700 }}>{fmtDay(day.dayStartMs, lang)}</span>
              <span className="num" style={{ fontSize: '0.85rem' }}>
                {day.players} {t('adminDaily.people')} · {day.sessions} {t('adminDaily.sessions')} ·{' '}
                {day.shots} {t('history.shots')}
              </span>
            </div>
            <div className="col" style={{ gap: 4 }}>
              {day.hours.map((h) => (
                <div
                  key={h.hour}
                  className="row"
                  style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                >
                  <span className="dim num" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                    {fmtHour(h.hour)}
                  </span>
                  <div
                    aria-hidden
                    style={{
                      flex: 1,
                      height: 8,
                      borderRadius: 4,
                      background: 'var(--surface-2, rgba(255,255,255,0.08))',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${(h.players / maxHourPlayers) * 100}%`,
                        height: '100%',
                        borderRadius: 4,
                        background: 'var(--accent)',
                      }}
                    />
                  </div>
                  <span className="num" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                    {h.players} {t('adminDaily.people')} · {h.shots} {t('history.shots')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

      <span className="faint" style={{ fontSize: '0.75rem' }}>
        {t('adminDaily.note')}
      </span>
    </div>
  );
}

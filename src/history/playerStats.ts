// ============================================================================
// ADGE Tennis — per-player history breakdown + admin daily overview (pure)
//
// The Home history/stats used to aggregate localStorage history ACROSS every
// player who ever played on the device (shared club phone → everyone's
// sessions merged into one "Your Stats"). These helpers split it back apart:
//
//   • playerKey / filterHistoryByPlayer — identity = trimmed lowercased
//     userName (the same free-text name the leaderboard keys on; there is no
//     per-player account — devices share one login).
//   • derivePlayerBreakdown — "แต่ละคนตีกี่ครั้ง": per-player session/shot
//     totals for the Home summary block.
//   • deriveAdminDaily — admin view: per LOCAL day, how many distinct players
//     came and in which hours (from the cloud /api/history rows).
//
// Pure — no store, no DOM, no I/O. Date grouping uses the DEVICE-local
// timezone on purpose (club devices run Asia/Bangkok; tests construct their
// ISO inputs from local Date parts so they hold in any TZ).
// ============================================================================

import type { History } from '../types';

/** Canonical player identity from the free-text name ('' = unnamed). */
export function playerKey(name: string | undefined | null): string {
  return (name ?? '').trim().toLowerCase();
}

/** Only the sessions played by `userName` (case/whitespace-insensitive). */
export function filterHistoryByPlayer(history: History, userName: string): History {
  const key = playerKey(userName);
  return history.filter((s) => playerKey(s.userName) === key);
}

export interface PlayerBreakdownRow {
  /** Normalized identity ('' = unnamed). */
  key: string;
  /** Display name as first typed (trimmed; '' = unnamed → i18n label). */
  name: string;
  sessions: number;
  totalShots: number;
  /** Shot-weighted mean score across the player's sessions. */
  avgScore: number;
}

/** Per-player totals from stored history, most shots first. */
export function derivePlayerBreakdown(history: History): PlayerBreakdownRow[] {
  const byKey = new Map<string, PlayerBreakdownRow & { weightedScore: number }>();
  for (const s of history) {
    const key = playerKey(s.userName);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        name: (s.userName ?? '').trim(),
        sessions: 0,
        totalShots: 0,
        avgScore: 0,
        weightedScore: 0,
      };
      byKey.set(key, row);
    }
    row.sessions += 1;
    row.totalShots += Number.isFinite(s.shotCount) ? s.shotCount : 0;
    row.weightedScore += (Number.isFinite(s.avgScore) ? s.avgScore : 0) * s.shotCount;
  }
  return [...byKey.values()]
    .map(({ weightedScore, ...r }) => ({
      ...r,
      avgScore: r.totalShots > 0 ? weightedScore / r.totalShots : 0,
    }))
    .sort((a, b) => b.totalShots - a.totalShots || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Admin daily overview (from cloud history rows)
// ---------------------------------------------------------------------------

/** The subset of a /api/history row this module needs (keep it narrow so the
 *  tests don't have to fabricate full CloudSessionSummary objects). */
export interface AdminHistoryRow {
  userName?: string;
  ownerEmail?: string | null;
  /** ISO string (nullable on malformed rows — skipped). */
  startedAt: string | null;
  shotCount: number;
}

export interface AdminHourRow {
  /** Local hour 0–23. */
  hour: number;
  /** Distinct players who STARTED a session in this hour. */
  players: number;
  sessions: number;
  shots: number;
}

export interface AdminDayRow {
  /** Local-date key 'YYYY-MM-DD' (stable sort/group key). */
  dayKey: string;
  /** Midnight-local ms of the day — for locale date formatting in the UI. */
  dayStartMs: number;
  /** Distinct players across the whole day. */
  players: number;
  sessions: number;
  shots: number;
  /** Only hours that had at least one session, ascending. */
  hours: AdminHourRow[];
}

/** Player identity for admin rows: name first, else owning account, else a
 *  shared "unknown" bucket (legacy rows with neither). */
function adminIdentity(r: AdminHistoryRow): string {
  return playerKey(r.userName) || (r.ownerEmail ?? '').trim().toLowerCase() || '(unknown)';
}

/** Group cloud history rows into per-local-day / per-hour admin stats,
 *  newest day first. Rows without a parseable startedAt are skipped. */
export function deriveAdminDaily(rows: AdminHistoryRow[]): AdminDayRow[] {
  interface DayAcc {
    dayStartMs: number;
    players: Set<string>;
    sessions: number;
    shots: number;
    hours: Map<number, { players: Set<string>; sessions: number; shots: number }>;
  }
  const days = new Map<string, DayAcc>();

  for (const r of rows) {
    const ms = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (!Number.isFinite(ms)) continue;
    const d = new Date(ms);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    let day = days.get(dayKey);
    if (!day) {
      day = {
        dayStartMs: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
        players: new Set(),
        sessions: 0,
        shots: 0,
        hours: new Map(),
      };
      days.set(dayKey, day);
    }
    const who = adminIdentity(r);
    const shots = Number.isFinite(r.shotCount) ? r.shotCount : 0;
    day.players.add(who);
    day.sessions += 1;
    day.shots += shots;

    const hour = d.getHours();
    let h = day.hours.get(hour);
    if (!h) {
      h = { players: new Set(), sessions: 0, shots: 0 };
      day.hours.set(hour, h);
    }
    h.players.add(who);
    h.sessions += 1;
    h.shots += shots;
  }

  return [...days.entries()]
    .map(([dayKey, day]) => ({
      dayKey,
      dayStartMs: day.dayStartMs,
      players: day.players.size,
      sessions: day.sessions,
      shots: day.shots,
      hours: [...day.hours.entries()]
        .map(([hour, h]) => ({
          hour,
          players: h.players.size,
          sessions: h.sessions,
          shots: h.shots,
        }))
        .sort((a, b) => a.hour - b.hour),
    }))
    .sort((a, b) => b.dayStartMs - a.dayStartMs);
}

import { describe, it, expect } from 'vitest';
import {
  playerKey,
  filterHistoryByPlayer,
  derivePlayerBreakdown,
  deriveAdminDaily,
  type AdminHistoryRow,
} from './playerStats';
import type { StoredSession } from '../types';

function stored(patch: Partial<StoredSession>): StoredSession {
  return {
    id: `sess-${Math.random()}`,
    tsMs: Date.now(),
    userName: 'p',
    durationMs: 10 * 60 * 1000,
    shotCount: 5,
    avgScore: 80,
    goodFormPct: 60,
    bestPeakWristSpeed: 1.5,
    totalCostTHB: 0,
    focusShot: 'forehand',
    improvements: [],
    ...patch,
  };
}

/** Local-time ISO input so day/hour grouping is timezone-independent. */
function isoLocal(y: number, m1: number, d: number, h: number, min = 0): string {
  return new Date(y, m1 - 1, d, h, min).toISOString();
}

describe('playerKey / filterHistoryByPlayer', () => {
  it('normalizes case + whitespace and treats missing names as unnamed', () => {
    expect(playerKey('  Ton ')).toBe('ton');
    expect(playerKey(undefined)).toBe('');
  });

  it('filters to only the named player, case-insensitively', () => {
    const history = [
      stored({ userName: 'Ton', shotCount: 10 }),
      stored({ userName: 'ton ', shotCount: 4 }),
      stored({ userName: 'Phet', shotCount: 7 }),
    ];
    const mine = filterHistoryByPlayer(history, ' TON');
    expect(mine).toHaveLength(2);
    expect(mine.every((s) => playerKey(s.userName) === 'ton')).toBe(true);
  });
});

describe('derivePlayerBreakdown', () => {
  it('counts sessions/shots separately per player, most shots first', () => {
    const rows = derivePlayerBreakdown([
      stored({ userName: 'Ton', shotCount: 10, avgScore: 80 }),
      stored({ userName: 'ton', shotCount: 10, avgScore: 60 }),
      stored({ userName: 'Phet', shotCount: 30, avgScore: 90 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'Phet', sessions: 1, totalShots: 30, avgScore: 90 });
    // Ton: 2 sessions merged (case-insensitive), shot-weighted avg = 70.
    expect(rows[1]).toMatchObject({ name: 'Ton', sessions: 2, totalShots: 20, avgScore: 70 });
  });

  it('keeps unnamed sessions in their own bucket and never crashes on 0 shots', () => {
    const rows = derivePlayerBreakdown([
      stored({ userName: '', shotCount: 0, avgScore: 0 }),
      stored({ userName: 'Ton', shotCount: 3 }),
    ]);
    expect(rows).toHaveLength(2);
    const unnamed = rows.find((r) => r.key === '');
    expect(unnamed).toMatchObject({ sessions: 1, totalShots: 0, avgScore: 0 });
  });
});

describe('deriveAdminDaily', () => {
  it('groups by local day + hour and counts DISTINCT players', () => {
    const rows: AdminHistoryRow[] = [
      { userName: 'Ton', startedAt: isoLocal(2026, 7, 21, 9, 5), shotCount: 10 },
      { userName: 'ton', startedAt: isoLocal(2026, 7, 21, 9, 40), shotCount: 6 },
      { userName: 'Phet', startedAt: isoLocal(2026, 7, 21, 10, 0), shotCount: 20 },
      { userName: 'Ton', startedAt: isoLocal(2026, 7, 20, 18, 0), shotCount: 8 },
    ];
    const days = deriveAdminDaily(rows);
    expect(days).toHaveLength(2);
    // Newest day first.
    expect(days[0].dayKey).toBe('2026-07-21');
    expect(days[0]).toMatchObject({ players: 2, sessions: 3, shots: 36 });
    expect(days[0].hours).toEqual([
      { hour: 9, players: 1, sessions: 2, shots: 16 },
      { hour: 10, players: 1, sessions: 1, shots: 20 },
    ]);
    expect(days[1]).toMatchObject({ dayKey: '2026-07-20', players: 1, sessions: 1, shots: 8 });
  });

  it('falls back to ownerEmail for unnamed rows and skips unparseable dates', () => {
    const rows: AdminHistoryRow[] = [
      { userName: '', ownerEmail: 'a@x.com', startedAt: isoLocal(2026, 7, 21, 9), shotCount: 1 },
      { userName: '', ownerEmail: 'b@x.com', startedAt: isoLocal(2026, 7, 21, 9), shotCount: 1 },
      { userName: 'c', startedAt: null, shotCount: 99 },
    ];
    const days = deriveAdminDaily(rows);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ players: 2, sessions: 2, shots: 2 });
  });
});

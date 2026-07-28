// ============================================================================
// Pure tests for the v2.5 History-detail stats resolver.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { resolveDetailStats, matchLocalSession } from './detailStats';
import type { CloudSessionDetail, StoredSession } from '../types';

// --- minimal factories -----------------------------------------------------

function detail(over: Partial<CloudSessionDetail> = {}): CloudSessionDetail {
  return {
    id: 'sess-1',
    userName: 'Ton',
    startedAt: '2026-07-28T10:00:00.000Z',
    endedAt: '2026-07-28T10:30:00.000Z',
    avgScore: 70,
    shotCount: 12,
    summary: null,
    shots: [],
    ...over,
  } as CloudSessionDetail;
}

function local(over: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'local-1',
    tsMs: Date.parse('2026-07-28T10:30:00.000Z'), // ended-at
    userName: 'Ton',
    durationMs: 30 * 60000, // 30 min → start = tsMs - dur = 10:00:00
    shotCount: 12,
    avgScore: 70,
    goodFormPct: 50,
    bestPeakWristSpeed: 2.4,
    totalCostTHB: 1.2,
    focusShot: 'forehand',
    improvements: [],
    ...over,
  } as StoredSession;
}

describe('resolveDetailStats — precedence', () => {
  it('(a) summary wins over local + shot recompute', () => {
    const d = detail({
      shotCount: 12,
      summary: {
        durationMs: 20 * 60000,
        goodFormPct: 40,
        bestPeakWristSpeed: 2,
        totalCostTHB: 0,
        focusShot: 'forehand',
        improvements: [],
        avgSpeedKmh: 88,
        kcal: 150,
        spin: { topspin: 5, backspin: 2, flat: 1 },
      },
      shots: [{ speedKmh: 40 } as never],
    });
    const stats = resolveDetailStats(d, [local({ avgSpeedKmh: 10, kcal: 10 })], 65);
    expect(stats.minutes).toBe(20);
    expect(stats.shots).toBe(12);
    expect(stats.avgSpeedKmh).toBe(88);
    expect(stats.kcal).toBe(150);
    expect(stats.spin).toEqual({ topspin: 5, backspin: 2, flat: 1 });
  });

  it('(b) local NOT matched (start drifts out of window) → summary absent → undefined', () => {
    const d = detail({ summary: null });
    // durationMs 25min shifts local start to 10:05 (tsMs 10:30 − 25min); detail
    // start is 10:00 → 300s > 120s window → no match → nothing to fall back to.
    const stats = resolveDetailStats(
      d,
      [local({ durationMs: 25 * 60000, avgSpeedKmh: 77, kcal: 200, spin: { topspin: 3, backspin: 0, flat: 4 } })],
      65,
    );
    expect(stats.avgSpeedKmh).toBeUndefined();
  });

  it('(b2) summary absent → local fallback (matched)', () => {
    const d = detail({ summary: null });
    const stats = resolveDetailStats(
      d,
      [local({ avgSpeedKmh: 77, kcal: 200, spin: { topspin: 3, backspin: 0, flat: 4 } })],
      65,
    );
    expect(stats.minutes).toBe(30);
    expect(stats.avgSpeedKmh).toBe(77);
    expect(stats.kcal).toBe(200);
    expect(stats.spin).toEqual({ topspin: 3, backspin: 0, flat: 4 });
  });

  it('(c) both absent → kcal recompute from duration+weight, avgSpeed undefined, spin undefined', () => {
    // No local match, no summary; but detail carries no per-shot speed and no
    // duration → duration 0 → kcal 0. Give it a duration via a matched local WITHOUT
    // stats so kcal recomputes: instead we test the pure recompute using summary.durationMs.
    const d = detail({
      summary: {
        durationMs: 60 * 60000, // 1 hour
        goodFormPct: 0,
        bestPeakWristSpeed: 0,
        totalCostTHB: 0,
        focusShot: 'forehand',
        improvements: [],
        // no avgSpeedKmh / kcal / spin
      },
      shots: [],
    });
    const stats = resolveDetailStats(d, [], 70);
    // 1 hour * MET 5 * 70kg = 350 kcal
    expect(stats.minutes).toBe(60);
    expect(stats.kcal).toBe(350);
    expect(stats.avgSpeedKmh).toBeUndefined();
    expect(stats.spin).toBeUndefined();
  });

  it('(c2) avgSpeed from per-shot speeds when summary/local lack it', () => {
    const d = detail({
      summary: null,
      shots: [{ speedKmh: 80 } as never, { speedKmh: 90 } as never, { speedKmh: 0 } as never],
    });
    const stats = resolveDetailStats(d, [], 65);
    expect(stats.avgSpeedKmh).toBe(85); // mean of 80,90 (0 excluded)
  });

  it('(d) summary=null never throws', () => {
    const d = detail({ summary: null, shots: [] });
    expect(() => resolveDetailStats(d, [], null)).not.toThrow();
  });

  it('(e) all-empty → minutes 0, shots n, avgSpeed undefined, kcal 0, spin undefined', () => {
    const d = detail({ summary: null, shots: [], shotCount: 7, startedAt: '2026-07-28T10:00:00.000Z' });
    const stats = resolveDetailStats(d, [], undefined);
    expect(stats).toEqual({ minutes: 0, shots: 7, avgSpeedKmh: undefined, kcal: 0, spin: undefined });
  });
});

describe('matchLocalSession', () => {
  const d = detail({ userName: 'Ton', startedAt: '2026-07-28T10:00:00.000Z' });

  it('playerKey mismatch → undefined', () => {
    expect(matchLocalSession([local({ userName: 'Somchai' })], d)).toBeUndefined();
  });

  it('case/space-insensitive name matches', () => {
    const m = matchLocalSession([local({ userName: '  ton  ' })], d);
    expect(m).toBeDefined();
  });

  it('±120s window — just inside vs just outside', () => {
    // start = tsMs - durationMs. Fix durationMs = 30min so start ≈ tsMs - 30min.
    // Inside: shift tsMs by +120s so start is +120s from detail start.
    const inside = local({
      id: 'in',
      tsMs: Date.parse('2026-07-28T10:30:00.000Z') + 120_000,
    });
    const outside = local({
      id: 'out',
      tsMs: Date.parse('2026-07-28T10:30:00.000Z') + 121_000,
    });
    expect(matchLocalSession([inside], d)?.id).toBe('in');
    expect(matchLocalSession([outside], d)).toBeUndefined();
  });

  it('closest-wins among two candidates', () => {
    const near = local({ id: 'near', tsMs: Date.parse('2026-07-28T10:30:00.000Z') + 10_000 });
    const far = local({ id: 'far', tsMs: Date.parse('2026-07-28T10:30:00.000Z') + 90_000 });
    expect(matchLocalSession([far, near], d)?.id).toBe('near');
  });

  it('a live-… row with partial (NaN) duration still matches when tsMs aligns', () => {
    // durationMs NaN → treated as 0 → start = tsMs. Set tsMs = detail start.
    const live = local({
      id: 'live-123',
      durationMs: Number.NaN as unknown as number,
      tsMs: Date.parse('2026-07-28T10:00:00.000Z'),
    });
    expect(matchLocalSession([live], d)?.id).toBe('live-123');
  });
});

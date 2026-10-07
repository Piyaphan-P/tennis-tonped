// ============================================================================
// ADGE Tennis — session stats derivation (v1.8 stats widget + share)
//
// ONE source of truth for the SummaryScreen stats widget and the durable
// StoredSession fields: `deriveSessionStats` runs over the live session's Shots
// (so the widget shows exactly what gets persisted), and `deriveCumulativeStats`
// aggregates the persisted history (so the "รวมทุกครั้ง / all-time" line agrees
// with what each session stored).
//
// Metrics: minutes played · total shots · avg swing speed (≈ km/h) · estimated
// kcal burned · topspin/backspin/flat mix. Spin + calories are ESTIMATES (no
// ball sensor / MET model) — captions in the UI say so.
//
// Thin by design: imports ONLY spin, calories, and types so store.ts can pull
// it in without dragging the CloudShot/scoring/derive graph into the store's
// module cycle. Pure — no DOM, no store, no I/O.
// ============================================================================

import type { DominantHand, Shot, StoredSession } from '../types';
import {
  classifySpin,
  emptySpinCounts,
  addSpinCounts,
  type SpinCounts,
} from '../analysis/spin';
import { estimateCalories } from '../analysis/calories';

/** Per-session figures — also the durable subset persisted on StoredSession. */
export interface SessionStats {
  /** (endedAt − startedAt) in ms. */
  durationMs: number;
  shotCount: number;
  /** Mean of shots' ≈km/h swing speed over shots that HAVE a speed; undefined
   *  when no shot produced a speed estimate (all out-of-frame / low-vis). */
  avgSpeedKmh: number | undefined;
  /** ≈ kcal burned (MET model). */
  kcal: number;
  /** topspin/backspin/flat tally over completed shots. */
  spin: SpinCounts;
}

/** Cross-session aggregate for the "all-time" line (3-day localStorage window). */
export interface CumulativeStats {
  sessions: number;
  /** Sum of session durations, in whole minutes. */
  totalMinutes: number;
  totalShots: number;
  /** Shot-weighted mean session avg speed (≈ km/h); undefined if none stored. */
  avgSpeedKmh: number | undefined;
  /** Sum of ≈ kcal across sessions. */
  totalKcal: number;
  spin: SpinCounts;
}

/**
 * Derive one session's stats from its live Shots + session duration. Pure.
 * `hand` is threaded because a bare Shot carries no dominant hand (needed to
 * pick the dominant wrist for spin). `weightKg` drives the calorie estimate.
 */
export function deriveSessionStats(
  shots: Shot[],
  durationMs: number,
  weightKg: number | undefined | null,
  hand: DominantHand,
): SessionStats {
  const shotCount = shots.length;

  const speeds = shots
    .map((s) => s.speedKmh)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const avgSpeedKmh =
    speeds.length === 0
      ? undefined
      : Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length);

  const spin = shots.reduce<SpinCounts>((acc, s) => {
    const kind = classifySpin(s, hand);
    return { ...acc, [kind]: acc[kind] + 1 };
  }, emptySpinCounts());

  return {
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
    shotCount,
    avgSpeedKmh,
    kcal: estimateCalories(durationMs, weightKg),
    spin,
  };
}

/** Read a stored session's spin tally, defaulting cleanly for pre-v1.8 rows. */
function storedSpin(s: StoredSession): SpinCounts {
  const sp = s.spin;
  if (!sp) return emptySpinCounts();
  return {
    topspin: Number.isFinite(sp.topspin) ? sp.topspin : 0,
    backspin: Number.isFinite(sp.backspin) ? sp.backspin : 0,
    flat: Number.isFinite(sp.flat) ? sp.flat : 0,
  };
}

/**
 * Aggregate the persisted history into all-time figures. Backward-compatible:
 * pre-v1.8 StoredSessions lack avgSpeedKmh/kcal/spin — those default to
 * undefined/0/empty and simply don't contribute, never crash.
 *
 * The all-time avg speed weights each session's stored avgSpeedKmh by its
 * shotCount (a slight approximation — the per-session mean was over
 * speed-defined shots only — fine for an ≈ figure).
 */
export function deriveCumulativeStats(history: StoredSession[]): CumulativeStats {
  let totalDurationMs = 0;
  let totalShots = 0;
  let totalKcal = 0;
  let spin = emptySpinCounts();
  let speedWeight = 0;
  let speedWeightedSum = 0;

  for (const s of history) {
    totalDurationMs += Number.isFinite(s.durationMs) ? s.durationMs : 0;
    totalShots += Number.isFinite(s.shotCount) ? s.shotCount : 0;
    totalKcal += typeof s.kcal === 'number' && Number.isFinite(s.kcal) ? s.kcal : 0;
    spin = addSpinCounts(spin, storedSpin(s));
    if (
      typeof s.avgSpeedKmh === 'number' &&
      Number.isFinite(s.avgSpeedKmh) &&
      s.avgSpeedKmh > 0 &&
      Number.isFinite(s.shotCount) &&
      s.shotCount > 0
    ) {
      speedWeight += s.shotCount;
      speedWeightedSum += s.avgSpeedKmh * s.shotCount;
    }
  }

  return {
    sessions: history.length,
    totalMinutes: Math.round(totalDurationMs / 60000),
    totalShots,
    avgSpeedKmh: speedWeight > 0 ? Math.round(speedWeightedSum / speedWeight) : undefined,
    totalKcal,
    spin,
  };
}

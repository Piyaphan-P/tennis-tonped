// ============================================================================
// ADGE Tennis — History-detail stats resolver (v2.5, pure).
//
// The History detail screen shows ≈avg swing speed / ≈kcal / spin for a session.
// Those live in three places with a precedence order:
//   1. the cloud session's `summary` (persisted at session-end since v2.5 — the
//      canonical source that survives the device),
//   2. a matching LOCAL StoredSession (same-device fallback for rows a device
//      itself ended — carries the same fields), and finally
//   3. a live recompute from whatever the detail carries (durationMs → kcal;
//      per-shot speedKmh → avg) for pre-v2.5 rows with none of the above.
//
// resolveDetailStats is TOTAL: every input may be null/undefined and it never
// throws. matchLocalSession pairs a cloud detail with its local row by player
// identity + start-time proximity (±120s), tolerating partial durations.
//
// Pure — no store, no DOM, no I/O. UI (HistoryScreen) imports this.
// ============================================================================

import type { CloudSessionDetail, CloudSessionSummary, StoredSession } from '../types';
import { estimateCalories } from '../analysis/calories';
import type { SpinCounts } from '../analysis/spin';
import { playerKey } from './playerStats';

export interface DetailStats {
  /** Whole minutes played; 0 when unknown. */
  minutes: number;
  /** Session shot count (= detail.shotCount always). */
  shots: number;
  /** ≈ km/h; undefined → UI shows "—". */
  avgSpeedKmh: number | undefined;
  /** ≈ kcal; 0 when not derivable. */
  kcal: number;
  /** topspin/backspin/flat COUNTS; undefined (or all-zero) → UI hides spin rows. */
  spin: SpinCounts | undefined;
}

/** Read a summary/stored spin blob into a clean SpinCounts, guarding each field
 *  (mirrors sessionStats.storedSpin). Returns undefined when the blob is absent. */
function readSpin(
  sp: { topspin?: number; backspin?: number; flat?: number } | null | undefined,
): SpinCounts | undefined {
  if (!sp) return undefined;
  return {
    topspin: Number.isFinite(sp.topspin) ? (sp.topspin as number) : 0,
    backspin: Number.isFinite(sp.backspin) ? (sp.backspin as number) : 0,
    flat: Number.isFinite(sp.flat) ? (sp.flat as number) : 0,
  };
}

/** A finite, positive number, else undefined. */
function posFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Find the LOCAL StoredSession that corresponds to a cloud session detail.
 * Match = same player identity (trim+lowercase userName) AND session start
 * within ±120s. A local row's start is `tsMs − durationMs` (tsMs = ended-at).
 * Returns the CLOSEST match, or undefined when none is within the window.
 */
export function matchLocalSession(
  localHistory: StoredSession[],
  detail: CloudSessionSummary,
): StoredSession | undefined {
  const detailStartMs = Date.parse(detail.startedAt ?? '');
  if (!Number.isFinite(detailStartMs)) return undefined;
  const key = playerKey(detail.userName);

  let best: StoredSession | undefined;
  let bestDiff = Infinity;
  for (const s of localHistory ?? []) {
    if (playerKey(s.userName) !== key) continue;
    const dur = Number.isFinite(s.durationMs) ? s.durationMs : 0;
    const startMs = (Number.isFinite(s.tsMs) ? s.tsMs : NaN) - dur;
    if (!Number.isFinite(startMs)) continue;
    const diff = Math.abs(startMs - detailStartMs);
    if (diff <= 120_000 && diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * Resolve the display stats for a History-detail view. TOTAL over null inputs.
 * Precedence per field: cloud `summary` → matched local row → live recompute.
 */
export function resolveDetailStats(
  detail: CloudSessionDetail,
  localHistory: StoredSession[],
  viewerWeightKg: number | undefined | null,
): DetailStats {
  const summary = detail?.summary ?? null;
  const local = matchLocalSession(localHistory ?? [], detail);

  // durationMs: summary → local → 0.
  const durationMs =
    posFinite(summary?.durationMs) ??
    posFinite(local?.durationMs) ??
    0;
  const minutes = Math.round(durationMs / 60000);

  const shots = Number.isFinite(detail?.shotCount) ? detail.shotCount : 0;

  // avgSpeedKmh: summary → local → mean of shot speeds (usually absent) → undefined.
  let avgSpeedKmh = posFinite(summary?.avgSpeedKmh) ?? posFinite(local?.avgSpeedKmh);
  if (avgSpeedKmh === undefined) {
    const speeds = (detail?.shots ?? [])
      .map((sh) => sh?.speedKmh)
      .filter((v): v is number => posFinite(v) !== undefined);
    if (speeds.length > 0) {
      avgSpeedKmh = Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length);
    }
  }

  // kcal: summary → local → recompute from duration + viewer weight (or 0).
  const kcal =
    posFinite(summary?.kcal) ??
    posFinite(local?.kcal) ??
    (durationMs > 0 ? estimateCalories(durationMs, viewerWeightKg) : 0);

  // spin: summary → local → undefined.
  const spin = readSpin(summary?.spin) ?? readSpin(local?.spin);

  return { minutes, shots, avgSpeedKmh, kcal, spin };
}

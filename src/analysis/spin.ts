// ============================================================================
// ADGE Tennis — swing SPIN estimator (v1.8 session-stats widget)
//
// Estimates topspin / backspin / flat from the DOMINANT WRIST'S VERTICAL PATH
// through the swing. This is a SWING-PATH estimate only — the app has NO ball
// sensor and cannot measure real spin. Always caption it as estimated.
//
// ── The sign, stated physically (independent of the code below) ─────────────
// MediaPipe landmarks are normalized image coords where **y grows DOWNWARD**
// (0 = top of frame, 1 = bottom). Topspin is a LOW-TO-HIGH brush: the racquet /
// hand travels physically UPWARD from backswing to follow-through, so in image
// space the wrist's y DECREASES (moves toward 0). Backspin is high-to-low: the
// hand travels DOWN, so image y INCREASES. Therefore:
//     deltaY = yFollowThrough − yBackswing
//     deltaY < −band  → wrist went UP   → 'topspin'
//     deltaY > +band  → wrist went DOWN → 'backspin'
//     |deltaY| ≤ band → negligible      → 'flat'
//
// Pure math only — no DOM, no store, no app imports beyond Landmark + LM + Shot.
// ============================================================================

import type { Landmark, Shot, SwingCapture, DominantHand, ShotPhase } from '../types';
import { LM } from '../types';

export type SpinType = 'topspin' | 'backspin' | 'flat';

/**
 * Vertical-travel deadband (normalized frame-height units). A wrist that moves
 * less than this between backswing and follow-through is treated as a FLAT
 * swing path rather than a confident top/back-spin. ~3% of frame height:
 * comfortably above pose jitter, below a deliberate low-to-high brush.
 */
export const SPIN_FLAT_BAND = 0.03;

/** Below this landmark visibility the wrist point is not usable for spin. */
const MIN_VISIBILITY = 0.5;

/** Canonical swing order — earliest → latest — used to pick path endpoints. */
const PHASE_ORDER: ShotPhase[] = [
  'preparation',
  'backswing',
  'forward-swing',
  'contact',
  'follow-through',
];

function phaseRank(phase: ShotPhase): number {
  const i = PHASE_ORDER.indexOf(phase);
  return i < 0 ? PHASE_ORDER.length : i;
}

function domWristY(capture: SwingCapture, hand: DominantHand): number | undefined {
  const idx = hand === 'right' ? LM.RIGHT_WRIST : LM.LEFT_WRIST;
  const lm = capture.landmarks?.[idx];
  if (!lm) return undefined;
  if ((lm.visibility ?? 1) < MIN_VISIBILITY) return undefined;
  return lm.y;
}

/**
 * Classify one completed shot's spin from the dominant wrist's vertical path.
 *
 * Uses the EARLIEST and LATEST captured keyframes (by canonical phase order):
 * ideally backswing → follow-through, but any two usable frames work. Falls
 * back to 'flat' when fewer than two captures carry a wrist-visible landmark
 * (e.g. a shot with only the guaranteed contact frame).
 *
 * `hand` is required because a bare Shot carries no dominant hand — the
 * dominant wrist landmark index depends on it.
 */
export function classifySpin(
  shot: Shot,
  hand: DominantHand,
  flatBand: number = SPIN_FLAT_BAND,
): SpinType {
  const usable = (shot.captures ?? [])
    .map((c) => ({ rank: phaseRank(c.phase), y: domWristY(c, hand) }))
    .filter((c): c is { rank: number; y: number } => c.y !== undefined)
    .sort((a, b) => a.rank - b.rank);

  if (usable.length < 2) return 'flat';

  const yStart = usable[0].y;
  const yEnd = usable[usable.length - 1].y;
  const deltaY = yEnd - yStart; // <0 = wrist moved UP (image y is top-down)

  if (deltaY < -flatBand) return 'topspin';
  if (deltaY > flatBand) return 'backspin';
  return 'flat';
}

/** Zeroed spin tally. */
export interface SpinCounts {
  topspin: number;
  backspin: number;
  flat: number;
}

export function emptySpinCounts(): SpinCounts {
  return { topspin: 0, backspin: 0, flat: 0 };
}

/** Sum two spin tallies (for cumulative aggregation). */
export function addSpinCounts(a: SpinCounts, b: SpinCounts): SpinCounts {
  return {
    topspin: a.topspin + b.topspin,
    backspin: a.backspin + b.backspin,
    flat: a.flat + b.flat,
  };
}

/**
 * Percentages over the total classified shots (0–100, each rounded). Returns
 * all-zero when there are no shots. topspin+backspin+flat may not sum to exactly
 * 100 after independent rounding — this is a display figure, not an invariant.
 */
export function spinPercentages(c: SpinCounts): { topspin: number; backspin: number; flat: number } {
  const total = c.topspin + c.backspin + c.flat;
  if (total <= 0) return { topspin: 0, backspin: 0, flat: 0 };
  return {
    topspin: Math.round((c.topspin / total) * 100),
    backspin: Math.round((c.backspin / total) * 100),
    flat: Math.round((c.flat / total) * 100),
  };
}

// ============================================================================
// ADGE Tennis — shotDetector v0.9 tests
//
// Covers the v0.9 detector-correctness work (companion to the capture
// regression suite in shotDetector.capture.test.ts):
//   1. HANDEDNESS-ANCHORED shot typing — classifyShotType is anchored on the
//      stated dominant hand and is MIRROR-INVARIANT (raw video coords; the
//      cameraFacing/PoseCanvas mirror is display-only). Both hands × both
//      sides × mirrored coords, plus near-center / side-on / low-vis → unknown.
//   2. POST-SHOT COOLDOWN — a would-be swing that starts inside the cooldown
//      window is suppressed (no new shot) and surfaced once as a 'cooldown'
//      discard event; a swing after the window completes normally.
//   3. FULL-SWING-ONLY completion — a swing that stalls mid-phase (never
//      traverses through follow-through) is discarded 'no-contact', never
//      dispatched; a full-cycle swing completes.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { ShotDetector, classifyShotType, SHOT_THRESHOLDS } from './shotDetector';
import { appStore } from '../store';
import type { DominantHand, JointAngles, Landmark, PoseFrame, Shot } from '../types';

// ---------------------------------------------------------------------------
// Landmark / frame / angle helpers
// ---------------------------------------------------------------------------

interface PosePositions {
  /** shoulders */
  Lsh: number;
  Rsh: number;
  /** hips */
  Lhip: number;
  Rhip: number;
  /** dominant-side wrists (only the one matching the tested hand matters) */
  Lwr: number;
  Rwr: number;
  vis?: number;
}

/** Build a full 33-landmark pose with the given x positions (y fixed, visible). */
function poseWith(p: PosePositions): Landmark[] {
  const v = p.vis ?? 1;
  const lm: Landmark[] = [];
  for (let i = 0; i < 33; i++) lm.push({ x: 0.5, y: 0.5, z: 0, visibility: v });
  lm[11] = { x: p.Lsh, y: 0.3, z: 0, visibility: v }; // LEFT_SHOULDER
  lm[12] = { x: p.Rsh, y: 0.3, z: 0, visibility: v }; // RIGHT_SHOULDER
  lm[15] = { x: p.Lwr, y: 0.6, z: 0, visibility: v }; // LEFT_WRIST
  lm[16] = { x: p.Rwr, y: 0.6, z: 0, visibility: v }; // RIGHT_WRIST
  lm[23] = { x: p.Lhip, y: 0.6, z: 0, visibility: v }; // LEFT_HIP
  lm[24] = { x: p.Rhip, y: 0.6, z: 0, visibility: v }; // RIGHT_HIP
  return lm;
}

/** Mirror every landmark horizontally (x -> 1-x), as a display mirror WOULD —
 *  except the pipeline never does this to landmarks, so classification MUST be
 *  invariant to it. */
function mirrorX(lm: Landmark[]): Landmark[] {
  return lm.map((p) => ({ ...p, x: 1 - p.x }));
}

function mkAngles(ts: number, wristSpeed: number, wristVelX: number): JointAngles {
  return {
    timestampMs: ts,
    leftElbowDeg: 140,
    rightElbowDeg: 140,
    leftShoulderDeg: 80,
    rightShoulderDeg: 80,
    leftKneeDeg: 150,
    rightKneeDeg: 150,
    leftHipDeg: 160,
    rightHipDeg: 160,
    trunkLeanDeg: 5,
    wristSpeed,
    wristVelX,
  };
}

/** A neutral fully-visible pose for the FSM traces (positions irrelevant there). */
function mkFrame(ts: number): PoseFrame {
  return {
    timestampMs: ts,
    landmarks: poseWith({ Lsh: 0.4, Rsh: 0.6, Lhip: 0.45, Rhip: 0.55, Lwr: 0.3, Rwr: 0.8 }),
  };
}

// ---------------------------------------------------------------------------
// 1. HANDEDNESS-ANCHORED, MIRROR-INVARIANT shot typing
// ---------------------------------------------------------------------------

describe('classifyShotType — handedness-anchored & mirror-invariant (v0.9 bug fix)', () => {
  // RIGHT-HANDED, RAW front-camera orientation (player faces camera; anatomical
  // right lands at LOW x). Forehand = dominant wrist on the dominant side.
  const rhRawForehand = poseWith({
    Lsh: 0.65, Rsh: 0.35, Lhip: 0.6, Rhip: 0.4, Lwr: 0.7, Rwr: 0.2,
  });
  const rhRawBackhand = poseWith({
    Lsh: 0.65, Rsh: 0.35, Lhip: 0.6, Rhip: 0.4, Lwr: 0.7, Rwr: 0.8,
  });

  it('right-handed, ball on the dominant side = forehand (โฟร์แฮนด์แน่ ๆ)', () => {
    expect(classifyShotType(rhRawForehand, 'right')).toBe('forehand');
  });

  it('right-handed, wrist crossed to the off side = backhand', () => {
    expect(classifyShotType(rhRawBackhand, 'right')).toBe('backhand');
  });

  it('is mirror-invariant: mirroring the coords keeps the same forehand/backhand', () => {
    // The pipeline never mirrors landmarks; classification must not flip when
    // fed mirrored coords (e.g. a mirrored capture).
    expect(classifyShotType(mirrorX(rhRawForehand), 'right')).toBe('forehand');
    expect(classifyShotType(mirrorX(rhRawBackhand), 'right')).toBe('backhand');
  });

  it('right-handed, MIRRORED orientation (anatomical right at high x) still resolves correctly', () => {
    const fore = poseWith({ Lsh: 0.35, Rsh: 0.65, Lhip: 0.4, Rhip: 0.6, Lwr: 0.3, Rwr: 0.8 });
    const back = poseWith({ Lsh: 0.35, Rsh: 0.65, Lhip: 0.4, Rhip: 0.6, Lwr: 0.3, Rwr: 0.2 });
    expect(classifyShotType(fore, 'right')).toBe('forehand');
    expect(classifyShotType(back, 'right')).toBe('backhand');
  });

  it('left-handed: forehand/backhand mirror the right-handed cases', () => {
    // Left-hander facing camera (raw): anatomical left at HIGH x.
    const fore = poseWith({ Lsh: 0.65, Rsh: 0.35, Lhip: 0.6, Rhip: 0.4, Lwr: 0.8, Rwr: 0.3 });
    const back = poseWith({ Lsh: 0.65, Rsh: 0.35, Lhip: 0.6, Rhip: 0.4, Lwr: 0.2, Rwr: 0.3 });
    expect(classifyShotType(fore, 'left')).toBe('forehand');
    expect(classifyShotType(back, 'left')).toBe('backhand');
    // And invariant under a coordinate mirror.
    expect(classifyShotType(mirrorX(fore), 'left')).toBe('forehand');
    expect(classifyShotType(mirrorX(back), 'left')).toBe('backhand');
  });

  it('near-center contact (wrist ≈ body midline) → unknown, not a wrong guess', () => {
    const nearCenter = poseWith({
      Lsh: 0.35, Rsh: 0.65, Lhip: 0.4, Rhip: 0.6, Lwr: 0.5, Rwr: 0.51,
    });
    expect(classifyShotType(nearCenter, 'right')).toBe('unknown');
  });

  it('side-on stance (shoulders stacked in x) → unknown (x-based method cannot resolve)', () => {
    const sideOn = poseWith({
      Lsh: 0.5, Rsh: 0.52, Lhip: 0.5, Rhip: 0.51, Lwr: 0.7, Rwr: 0.8,
    });
    expect(classifyShotType(sideOn, 'right')).toBe('unknown');
  });

  it('low dominant-wrist visibility → unknown', () => {
    const lowVis = poseWith({
      Lsh: 0.65, Rsh: 0.35, Lhip: 0.6, Rhip: 0.4, Lwr: 0.7, Rwr: 0.2,
      vis: SHOT_THRESHOLDS.minVisibilityForType - 0.1,
    });
    expect(classifyShotType(lowVis, 'right')).toBe('unknown');
  });

  it('fewer than 33 landmarks → unknown', () => {
    expect(classifyShotType([], 'right')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// FSM trace helpers (15fps EMA-smoothed cadence, matching the capture suite)
// ---------------------------------------------------------------------------

const DT = 1000 / 15;

/** A full swing that traverses prep→backswing→forward-swing→contact→
 *  follow-through→idle and completes as a shot (peak ~1.3, no velX flip; the
 *  forwardBypass chain carries it through). 20 frames. */
const FULL_SWING: Array<[number, number]> = [
  [0.35, 0.1], [0.35, 0.1], [0.35, 0.1], // prep
  [0.55, 0.1],                            // -> backswing
  [1.05, 0.1], [1.2, 0.1],                // bypass -> forward-swing
  [1.3, 0.1],                             // rising peak (>contactMinPeakSpeed)
  [0.6, 0.1],                             // drop -> contact
  [0.4, 0.1],                             // -> follow-through
  [0.2, 0], [0.2, 0], [0.2, 0], [0.2, 0], [0.2, 0],
  [0.2, 0], [0.2, 0], [0.2, 0], [0.2, 0], [0.2, 0], // 10 idle -> finalize
];

/** A partial swing that arms then STALLS in backswing (never locks contact,
 *  never reaches follow-through). Should be discarded, never dispatched. */
const STALLED_SWING: Array<[number, number]> = [
  [0.35, 0.1], [0.35, 0.1], [0.35, 0.1], // prep
  [0.6, 0.1],                             // -> backswing
  [0.7, 0.1], [0.6, 0.1],                 // dawdle in backswing (no bypass, no flip)
  [0.2, 0], [0.2, 0], [0.2, 0], [0.2, 0], [0.2, 0],
  [0.2, 0], [0.2, 0], [0.2, 0], [0.2, 0], [0.2, 0], // 10 idle -> finalize
];

/** Feed a trace starting at `startTs`; returns the ts just past the last frame. */
function feed(detector: ShotDetector, trace: Array<[number, number]>, startTs: number): number {
  trace.forEach(([speed, velX], i) => {
    const ts = startTs + i * DT;
    detector.onFrame(mkFrame(ts), mkAngles(ts, speed, velX), undefined);
  });
  return startTs + trace.length * DT;
}

// ---------------------------------------------------------------------------
// 2. POST-SHOT COOLDOWN
// ---------------------------------------------------------------------------

describe('shotDetector post-shot cooldown (v0.9 — stop capturing รัว)', () => {
  beforeEach(() => {
    appStore.getState().startSession();
  });

  it('cooldown is a long spacing constant (~2.5s), not the old 800ms', () => {
    expect(SHOT_THRESHOLDS.cooldownMs).toBeGreaterThanOrEqual(2000);
  });

  it('a swing starting inside the cooldown window is suppressed and surfaced as a "cooldown" discard', () => {
    let completed = 0;
    const detector = new ShotDetector({ onShotCompleted: () => { completed += 1; } });
    detector.reset();

    // Swing #1 completes and opens a cooldown window.
    const afterFirst = feed(detector, FULL_SWING, 0);
    expect(completed).toBe(1);
    expect(appStore.getState().detection.shotsCompleted).toBe(1);

    // Swing #2 starts immediately (well inside cooldownMs) — must NOT complete,
    // and must surface exactly one 'cooldown' discard event.
    expect(afterFirst).toBeLessThan(SHOT_THRESHOLDS.cooldownMs);
    feed(detector, FULL_SWING, afterFirst);

    expect(completed).toBe(1); // no second shot
    const det = appStore.getState().detection;
    expect(det.shotsCompleted).toBe(1);
    expect(det.swingsDiscarded).toBe(1);
    expect(det.lastEvent?.kind).toBe('swing-discarded');
    expect(det.lastEvent?.reason).toBe('cooldown');
  });

  it('a swing after the cooldown window elapses completes normally', () => {
    let completed = 0;
    const detector = new ShotDetector({ onShotCompleted: () => { completed += 1; } });
    detector.reset();

    feed(detector, FULL_SWING, 0);
    expect(completed).toBe(1);

    // Start well past the cooldown window (relative to swing #1's finalize).
    feed(detector, FULL_SWING, SHOT_THRESHOLDS.cooldownMs + 2000);
    expect(completed).toBe(2);
    expect(appStore.getState().detection.shotsCompleted).toBe(2);
    expect(appStore.getState().detection.lastEvent?.kind).toBe('shot-completed');
  });
});

// ---------------------------------------------------------------------------
// 2b. SPEAK-TO-COMPLETION CAPTURE GATE (holdArm, v1.2)
// ---------------------------------------------------------------------------

describe('shotDetector holdArm gate (v1.2 — no new capture while the coach is speaking)', () => {
  beforeEach(() => {
    appStore.getState().startSession();
  });

  it('a swing while holdArm=true never arms, surfaces ONE coach-speaking discard, and arms again once released', () => {
    let hold = true;
    let completed = 0;
    let swingStarted = 0;
    const detector = new ShotDetector({
      onShotCompleted: () => { completed += 1; },
      onSwingStarted: () => { swingStarted += 1; },
      holdArm: () => hold,
    });
    detector.reset();

    // Two full swings while the coach is "speaking": nothing arms/completes,
    // exactly ONE HUD event per hold window (latched, not spammed).
    const afterFirst = feed(detector, FULL_SWING, 0);
    const afterSecond = feed(detector, FULL_SWING, afterFirst + SHOT_THRESHOLDS.cooldownMs + 4000);
    expect(completed).toBe(0);
    expect(swingStarted).toBe(0);
    const det = appStore.getState().detection;
    expect(det.swingsDiscarded).toBe(1);
    expect(det.lastEvent?.reason).toBe('coach-speaking');

    // Coach finished — the very next swing arms and completes normally.
    hold = false;
    feed(detector, FULL_SWING, afterSecond + SHOT_THRESHOLDS.cooldownMs + 4000);
    expect(swingStarted).toBe(1);
    expect(completed).toBe(1);
    expect(appStore.getState().detection.lastEvent?.kind).toBe('shot-completed');
  });

  it('holdArm turning true MID-swing does not abort the swing in flight (checked only at the idle gate)', () => {
    let hold = false;
    let completed = 0;
    const detector = new ShotDetector({
      onShotCompleted: () => { completed += 1; },
      holdArm: () => hold,
    });
    detector.reset();

    // Arm the swing with the first few frames, then flip the hold on while the
    // FSM is mid-phase — the swing must still complete.
    const armFrames = FULL_SWING.slice(0, SHOT_THRESHOLDS.prepEnterFrames + 2);
    const rest = FULL_SWING.slice(SHOT_THRESHOLDS.prepEnterFrames + 2);
    const mid = feed(detector, armFrames, 0);
    hold = true;
    feed(detector, rest, mid);
    expect(completed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. FULL-SWING-ONLY completion
// ---------------------------------------------------------------------------

describe('shotDetector full-swing-only completion (v0.9 — only complete swings go to the coach)', () => {
  beforeEach(() => {
    appStore.getState().startSession();
  });

  it('a full-cycle swing (through follow-through) completes and dispatches', () => {
    const holder: { shot: Shot | null } = { shot: null };
    const detector = new ShotDetector({ onShotCompleted: (s) => { holder.shot = s; } });
    detector.reset();

    feed(detector, FULL_SWING, 0);

    expect(holder.shot).not.toBeNull();
    expect(appStore.getState().detection.shotsCompleted).toBe(1);
    expect(appStore.getState().detection.lastEvent?.kind).toBe('shot-completed');
  });

  it('a partial swing that stalls before follow-through is discarded, never dispatched', () => {
    let completed = 0;
    const detector = new ShotDetector({ onShotCompleted: () => { completed += 1; } });
    detector.reset();

    feed(detector, STALLED_SWING, 0);

    expect(completed).toBe(0);
    const det = appStore.getState().detection;
    expect(det.shotsCompleted).toBe(0);
    expect(det.swingsDiscarded).toBe(1);
    expect(det.lastEvent?.kind).toBe('swing-discarded');
    expect(det.lastEvent?.reason).toBe('no-contact');
  });
});

// Cross-check that the two hand settings resolve types differently for the same
// wrist position — the whole point of the anchoring: dominantHand is the anchor.
describe('classifyShotType — dominantHand is the anchor (same pose, different hand)', () => {
  it('same wrist-out-to-high-x pose is forehand for one hand and backhand for the other', () => {
    // Symmetric shoulders/hips; a right wrist far to the +x side.
    // Right-hander (dom shoulder at +x here) → forehand; but flip the anchor to
    // left and the same +x wrist reads as the left-hander's off side → not forehand.
    const pose = poseWith({ Lsh: 0.35, Rsh: 0.65, Lhip: 0.4, Rhip: 0.6, Lwr: 0.85, Rwr: 0.85 });
    const asRight = classifyShotType(pose, 'right');
    const asLeft = classifyShotType(pose, 'left');
    expect(asRight).toBe('forehand'); // dom(right) shoulder at +x, wrist at +x
    expect(asLeft).toBe('backhand'); // dom(left) shoulder at -x, wrist crossed to +x
  });
});

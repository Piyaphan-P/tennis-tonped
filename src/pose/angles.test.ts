import { describe, it, expect } from 'vitest';
import {
  angleDeg,
  angleDeg3D,
  computeJointAngles,
  ema,
  SHOULDER_STATUS_EMA_ALPHA,
} from './angles';
import { LM } from '../types';
import type { Landmark, PoseFrame } from '../types';

// --- 33-landmark frame builder --------------------------------------------
// Front-facing right-hander. Torso landmarks visible; overrides passed per test.
function frame(overrides: Record<number, Landmark>): PoseFrame {
  const lm: Landmark[] = [];
  for (let i = 0; i < 33; i++) lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  // sensible torso defaults
  lm[LM.LEFT_SHOULDER] = { x: 0.58, y: 0.3, z: 0, visibility: 1 };
  lm[LM.RIGHT_SHOULDER] = { x: 0.42, y: 0.3, z: 0, visibility: 1 };
  lm[LM.LEFT_HIP] = { x: 0.56, y: 0.55, z: 0, visibility: 1 };
  lm[LM.RIGHT_HIP] = { x: 0.44, y: 0.55, z: 0, visibility: 1 };
  for (const [idx, v] of Object.entries(overrides)) lm[Number(idx)] = v;
  return { timestampMs: 0, landmarks: lm };
}

describe('angleDeg3D', () => {
  it('reduces EXACTLY to the 2D angleDeg when all z are 0 (graceful degradation)', () => {
    const a = { x: 0.4, y: 0.2, z: 0 };
    const b = { x: 0.4, y: 0.5, z: 0 };
    const c = { x: 0.7, y: 0.5, z: 0 };
    expect(angleDeg3D(a, b, c)).toBeCloseTo(angleDeg(a, b, c), 10);
  });

  it('measures the true angle through depth where the 2D projection cannot', () => {
    // b at origin; a straight down in image (z=0), c straight toward camera (−z).
    const a = { x: 0.5, y: 0.8, z: 0 };
    const b = { x: 0.5, y: 0.5, z: 0 };
    const c = { x: 0.5, y: 0.5, z: -0.3 }; // pure camera-axis: 2D projection vanishes
    expect(angleDeg3D(a, b, c)).toBeCloseTo(90, 1); // real right angle
    expect(angleDeg(a, b, c)).toBe(0); // 2D sees a zero-length vector → degenerate
  });

  it('returns 0 for a degenerate (zero-length) vector', () => {
    const p = { x: 0.5, y: 0.5, z: 0.1 };
    expect(angleDeg3D(p, p, { x: 0.6, y: 0.6, z: 0.2 })).toBe(0);
  });
});

describe('computeJointAngles — shoulder foreshortening fix (Suspect 2)', () => {
  it('REGRESSION: front-facing contact, arm extended toward camera → shoulder in the 60–110 good window', () => {
    // Right elbow reaches forward-toward-camera at contact (strong −z).
    const elbow: Landmark = { x: 0.41, y: 0.34, z: -0.28, visibility: 1 };
    const f = frame({
      [LM.RIGHT_ELBOW]: elbow,
      [LM.RIGHT_WRIST]: { x: 0.4, y: 0.36, z: -0.5, visibility: 1 },
    });
    const angles = computeJointAngles(f, null, 'right');

    // 3D shoulder angle is the true ~82° abduction — inside 60–110 (good).
    expect(angles.rightShoulderDeg).toBeGreaterThanOrEqual(60);
    expect(angles.rightShoulderDeg).toBeLessThanOrEqual(110);

    // Prove the bug the fix removes: the OLD 2D angle on the same three points
    // is ~19° — far outside 60–110, so the legacy path warned on good form.
    const shoulder = f.landmarks[LM.RIGHT_SHOULDER];
    const hip = f.landmarks[LM.RIGHT_HIP];
    const twoD = angleDeg(hip, shoulder, elbow);
    expect(twoD).toBeLessThan(60);
  });

  it('genuinely un-abducted arm (hanging low) still reads OUT of range → coloring does not lie', () => {
    const f = frame({
      [LM.RIGHT_ELBOW]: { x: 0.42, y: 0.42, z: -0.02, visibility: 1 },
      [LM.RIGHT_WRIST]: { x: 0.42, y: 0.55, z: -0.02, visibility: 1 },
    });
    const angles = computeJointAngles(f, null, 'right');
    expect(angles.rightShoulderDeg).toBeLessThan(60); // ~10° → correctly warns
  });

  it('arm raised overhead still reads OUT of range (> 110) → coloring does not lie', () => {
    const f = frame({
      [LM.RIGHT_ELBOW]: { x: 0.42, y: 0.12, z: -0.02, visibility: 1 },
      [LM.RIGHT_WRIST]: { x: 0.42, y: 0.02, z: -0.02, visibility: 1 },
    });
    const angles = computeJointAngles(f, null, 'right');
    expect(angles.rightShoulderDeg).toBeGreaterThan(110); // ~172° → correctly warns
  });
});

describe('ema (live shoulder-status smoothing, pure)', () => {
  it('seeds with next when prev is null/undefined/non-finite (identity on first sample)', () => {
    expect(ema(null, 87, 0.35)).toBe(87);
    expect(ema(undefined, 87, 0.35)).toBe(87);
    expect(ema(NaN, 87, 0.35)).toBe(87);
  });

  it('is the standard one-step EMA: alpha*next + (1-alpha)*prev', () => {
    expect(ema(100, 200, 0.35)).toBeCloseTo(0.35 * 200 + 0.65 * 100, 10);
    // alpha=1 tracks the input exactly; alpha=0 freezes at prev.
    expect(ema(100, 200, 1)).toBe(200);
    expect(ema(100, 200, 0)).toBe(100);
  });

  it('damps a single-frame z-noise spike (the flicker we are killing)', () => {
    // Angle sits at 100° (good), one frame jumps to 40° (would flip to warn),
    // then returns. The smoothed value must stay well inside the 60–110 window.
    let v = ema(null, 100, SHOULDER_STATUS_EMA_ALPHA);
    v = ema(v, 40, SHOULDER_STATUS_EMA_ALPHA); // the noise spike
    expect(v).toBeGreaterThan(60); // did NOT flip to warn on one bad frame
    v = ema(v, 100, SHOULDER_STATUS_EMA_ALPHA);
    expect(v).toBeGreaterThan(60);
  });

  it('converges toward a sustained new level', () => {
    let v = 100;
    for (let i = 0; i < 20; i++) v = ema(v, 70, SHOULDER_STATUS_EMA_ALPHA);
    expect(v).toBeCloseTo(70, 1);
  });
});

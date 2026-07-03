// ============================================================================
// ต้นและเพชร Tennis Club — joint angle computation (pure, local, free)
//
// Consumes a PoseFrame, produces JointAngles in degrees. Real 2D vector math,
// no side effects, unit-testable. Safe to call ~30x/s. The shot detector reuses
// EMA_ALPHA and MIN_VISIBILITY exported from here.
// ============================================================================

import { LM } from '../types';
import type { DominantHand, JointAngles, Landmark, PoseFrame } from '../types';

/** EMA smoothing factor for dominant-wrist speed/velocity. */
export const EMA_ALPHA = 0.4;

/** Minimum landmark visibility to trust a joint for angle math. */
export const MIN_VISIBILITY = 0.3;

/** Core torso landmarks that must be visible for any angle to be meaningful. */
const KEY_LANDMARKS: number[] = [
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
];

const EMPTY_ANGLES: JointAngles = {
  timestampMs: 0,
  leftElbowDeg: 0,
  rightElbowDeg: 0,
  leftShoulderDeg: 0,
  rightShoulderDeg: 0,
  leftKneeDeg: 0,
  rightKneeDeg: 0,
  leftHipDeg: 0,
  rightHipDeg: 0,
  trunkLeanDeg: 0,
  wristSpeed: 0,
  wristVelX: 0,
};

/**
 * Interior angle at vertex `b` (degrees), formed by the vectors b->a and b->c.
 * Uses acos of the normalized dot product; clamped to [0, 180]. Returns a
 * NaN-safe 0 if either vector is degenerate (zero length).
 */
export function angleDeg(a: Landmark, b: Landmark, c: Landmark): number {
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const magBa = Math.hypot(bax, bay);
  const magBc = Math.hypot(bcx, bcy);
  const denom = magBa * magBc;
  if (denom < 1e-6) return 0;
  const cos = Math.max(-1, Math.min(1, (bax * bcx + bay * bcy) / denom));
  const deg = (Math.acos(cos) * 180) / Math.PI;
  return Number.isFinite(deg) ? Math.max(0, Math.min(180, deg)) : 0;
}

/**
 * Angle (degrees) of the segment `bottom`->`top` measured from the vertical
 * axis. 0 = perfectly upright, 90 = horizontal. Image coordinates (y grows
 * downward) are handled via absolute components, so lean is always non-negative.
 */
export function verticalLeanDeg(top: Landmark, bottom: Landmark): number {
  const dx = top.x - bottom.x;
  const dy = top.y - bottom.y;
  const deg = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
  return Number.isFinite(deg) ? deg : 0;
}

function midpoint(a: Landmark, b: Landmark): Landmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/** True if the frame has a full landmark set and the torso is confidently seen. */
function torsoVisible(lm: Landmark[]): boolean {
  if (!lm || lm.length < 33) return false;
  for (const idx of KEY_LANDMARKS) {
    const p = lm[idx];
    if (!p) return false;
    if (p.visibility !== undefined && p.visibility < MIN_VISIBILITY) return false;
  }
  return true;
}

/**
 * Compute joint angles for one frame.
 *
 * Angle definitions (interior angle at the middle joint):
 *   - elbow    : shoulder -> elbow -> wrist
 *   - shoulder : hip      -> shoulder -> elbow  (abduction)
 *   - knee     : hip      -> knee -> ankle
 *   - hip      : shoulder -> hip  -> knee
 *   - trunk    : lean of mid-shoulder over mid-hip from vertical
 *
 * Dominant-wrist speed (normalized units/s) and signed horizontal velocity are
 * derived from the previous frame's wrist position and EMA-smoothed (alpha
 * EMA_ALPHA) against the previous angles.
 *
 * If landmarks are empty/incomplete or the key torso landmarks fall below
 * MIN_VISIBILITY, the previous angles are returned with the current timestamp
 * (or all-zero angles if there is no previous frame) so downstream consumers
 * always receive a stable, timestamped snapshot.
 */
export function computeJointAngles(
  frame: PoseFrame,
  prev: { frame: PoseFrame; angles: JointAngles } | null,
  dominantHand: DominantHand,
): JointAngles {
  const lm = frame.landmarks;

  if (!torsoVisible(lm)) {
    return prev
      ? { ...prev.angles, timestampMs: frame.timestampMs }
      : { ...EMPTY_ANGLES, timestampMs: frame.timestampMs };
  }

  const leftElbowDeg = angleDeg(lm[LM.LEFT_SHOULDER], lm[LM.LEFT_ELBOW], lm[LM.LEFT_WRIST]);
  const rightElbowDeg = angleDeg(lm[LM.RIGHT_SHOULDER], lm[LM.RIGHT_ELBOW], lm[LM.RIGHT_WRIST]);
  const leftShoulderDeg = angleDeg(lm[LM.LEFT_HIP], lm[LM.LEFT_SHOULDER], lm[LM.LEFT_ELBOW]);
  const rightShoulderDeg = angleDeg(lm[LM.RIGHT_HIP], lm[LM.RIGHT_SHOULDER], lm[LM.RIGHT_ELBOW]);
  const leftKneeDeg = angleDeg(lm[LM.LEFT_HIP], lm[LM.LEFT_KNEE], lm[LM.LEFT_ANKLE]);
  const rightKneeDeg = angleDeg(lm[LM.RIGHT_HIP], lm[LM.RIGHT_KNEE], lm[LM.RIGHT_ANKLE]);
  const leftHipDeg = angleDeg(lm[LM.LEFT_SHOULDER], lm[LM.LEFT_HIP], lm[LM.LEFT_KNEE]);
  const rightHipDeg = angleDeg(lm[LM.RIGHT_SHOULDER], lm[LM.RIGHT_HIP], lm[LM.RIGHT_KNEE]);

  const midShoulder = midpoint(lm[LM.LEFT_SHOULDER], lm[LM.RIGHT_SHOULDER]);
  const midHip = midpoint(lm[LM.LEFT_HIP], lm[LM.RIGHT_HIP]);
  const trunkLeanDeg = verticalLeanDeg(midShoulder, midHip);

  // --- dominant-wrist kinematics ---
  const wristIdx = dominantHand === 'left' ? LM.LEFT_WRIST : LM.RIGHT_WRIST;
  const wrist = lm[wristIdx];

  let wristSpeed = 0;
  let wristVelX = 0;

  if (prev) {
    const prevSpeed = prev.angles.wristSpeed ?? 0;
    const prevVelX = prev.angles.wristVelX ?? 0;
    const dt = (frame.timestampMs - prev.frame.timestampMs) / 1000;
    const prevWrist = prev.frame.landmarks[wristIdx];

    if (dt > 1e-4 && prevWrist && wrist) {
      const dx = wrist.x - prevWrist.x;
      const dy = wrist.y - prevWrist.y;
      const instSpeed = Math.hypot(dx, dy) / dt;
      const instVelX = dx / dt;
      wristSpeed = EMA_ALPHA * instSpeed + (1 - EMA_ALPHA) * prevSpeed;
      wristVelX = EMA_ALPHA * instVelX + (1 - EMA_ALPHA) * prevVelX;
    } else {
      // No usable delta this frame — carry the smoothed values forward.
      wristSpeed = prevSpeed;
      wristVelX = prevVelX;
    }
  }

  return {
    timestampMs: frame.timestampMs,
    leftElbowDeg,
    rightElbowDeg,
    leftShoulderDeg,
    rightShoulderDeg,
    leftKneeDeg,
    rightKneeDeg,
    leftHipDeg,
    rightHipDeg,
    trunkLeanDeg,
    wristSpeed,
    wristVelX,
  };
}

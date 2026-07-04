// ============================================================================
// ต้นและเพชร Tennis Club — shotDetector capture regression tests
//
// PERMANENT proof that swing captures are REAL, not just "code exists":
//   (a) a full synthetic swing with a working getJpeg produces captures for
//       backswing + contact + follow-through, and the emitted shot lands in
//       the store;
//   (b) getJpeg failing throughout the swing but succeeding at finalize()
//       still yields a synthesized 'contact' capture, built from the
//       detector's OWN peak-frame angles (verified by reference equality,
//       not a re-derived copy);
//   (c) getJpeg permanently unavailable still lets the shot complete
//       gracefully with an empty (but present) captures array.
//
// The synthetic swing (fixed 50ms-per-frame cadence) walks the exact phase
// thresholds in SHOT_THRESHOLDS:
//   idle    speed 0.5 x3            -> preparation (prepEnterFrames=3)
//   prep    speed 1.0 velX+         -> backswing   (backswingMinSpeed=0.8)
//   backsw  speed 1.5 velX-         -> forward-swing (forwardSwingMinSpeed=1.2,
//                                      opposite sign of backswingSign)
//   fwd     speed 1.8, 2.2, 2.6     -> 3 rising frames (contactMinRisingFrames=2)
//   fwd     speed 1.0 (drop)        -> contact locked at the 2.6 peak
//                                      (contactMinPeakSpeed=2.0)
//   contact speed 0.8               -> follow-through
//   follow  speed 0.1 x10           -> idleReturnFrames=10 -> finalize()
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { ShotDetector } from './shotDetector';
import type { CaptureContext, GetJpeg } from './shotDetector';
import { appStore } from '../store';
import type { JointAngles, Landmark, PoseFrame, Shot } from '../types';

// ---------------------------------------------------------------------------
// Synthetic pose data helpers
// ---------------------------------------------------------------------------

/** A plausible, fully-visible 33-landmark pose (values don't affect thresholds). */
function mkLandmarks(): Landmark[] {
  const lm: Landmark[] = [];
  for (let i = 0; i < 33; i++) {
    lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  }
  // Distinct-ish positions for the joints classifyShotType/scoring actually read.
  lm[11] = { x: 0.4, y: 0.3, z: 0, visibility: 1 }; // left shoulder
  lm[12] = { x: 0.6, y: 0.3, z: 0, visibility: 1 }; // right shoulder
  lm[13] = { x: 0.35, y: 0.45, z: 0, visibility: 1 }; // left elbow
  lm[14] = { x: 0.7, y: 0.45, z: 0, visibility: 1 }; // right elbow
  lm[15] = { x: 0.3, y: 0.6, z: 0, visibility: 1 }; // left wrist
  lm[16] = { x: 0.8, y: 0.6, z: 0, visibility: 1 }; // right wrist (dominant, right hand)
  lm[23] = { x: 0.45, y: 0.6, z: 0, visibility: 1 }; // left hip
  lm[24] = { x: 0.55, y: 0.6, z: 0, visibility: 1 }; // right hip
  lm[25] = { x: 0.45, y: 0.8, z: 0, visibility: 1 }; // left knee
  lm[26] = { x: 0.55, y: 0.8, z: 0, visibility: 1 }; // right knee
  lm[27] = { x: 0.45, y: 0.95, z: 0, visibility: 1 }; // left ankle
  lm[28] = { x: 0.55, y: 0.95, z: 0, visibility: 1 }; // right ankle
  return lm;
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

function mkFrame(ts: number): PoseFrame {
  return { timestampMs: ts, landmarks: mkLandmarks() };
}

/** The fixed swing script: [speed, velX] per frame, 50ms apart, starting at ts=0. */
const SWING_SPEEDS: Array<[number, number]> = [
  [0.5, 0], // idle prep streak 1
  [0.5, 0], // idle prep streak 2
  [0.5, 0], // idle prep streak 3 -> preparation
  [1.0, 1], // preparation -> backswing
  [1.5, -1], // backswing -> forward-swing (captures 'backswing')
  [1.8, -1], // forward-swing rising 1
  [2.2, -1], // forward-swing rising 2
  [2.6, -1], // forward-swing rising 3 (peak)
  [1.0, -1], // drop -> contact locked at 2.6 (captures 'contact')
  [0.8, -1], // contact -> follow-through (captures 'follow-through')
  [0.1, 0], // follow-through low-speed streak 1
  [0.1, 0], // 2
  [0.1, 0], // 3
  [0.1, 0], // 4
  [0.1, 0], // 5
  [0.1, 0], // 6
  [0.1, 0], // 7
  [0.1, 0], // 8
  [0.1, 0], // 9
  [0.1, 0], // 10 -> idleReturnFrames reached -> finalize()
];

const DT_MS = 50;

/** Feed the fixed synthetic swing into a detector, returning the peak-frame
 * (contact) angles object by reference, for capture-identity assertions. */
function runSyntheticSwing(detector: ShotDetector, getJpeg?: GetJpeg): JointAngles {
  const peak: { angles: JointAngles | null } = { angles: null };
  SWING_SPEEDS.forEach(([speed, velX], i) => {
    const ts = i * DT_MS;
    const angles = mkAngles(ts, speed, velX);
    if (speed === 2.6) peak.angles = angles; // the local peak frame -> becomes contact
    detector.onFrame(mkFrame(ts), angles, getJpeg);
  });
  if (!peak.angles) throw new Error('synthetic swing script never reached its peak frame');
  return peak.angles;
}

function mkCtx(tag: string): CaptureContext {
  return {
    jpegBase64: `jpeg-${tag}`,
    landmarks: mkLandmarks(),
    angles: mkAngles(999_999, 0, 0), // deliberately NOT the peak-frame angles
    tsMs: 999_999,
  };
}

/** Runs a detector callback that captures the completed Shot without TS
 * narrowing the holder to `null` across the closure boundary. */
function captureCompletedShot(): {
  onShotCompleted: (shot: Shot) => void;
  get: () => Shot;
} {
  const holder: { shot: Shot | null } = { shot: null };
  return {
    onShotCompleted: (shot) => {
      holder.shot = shot;
    },
    get: () => {
      if (!holder.shot) throw new Error('onShotCompleted was never called');
      return holder.shot;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shotDetector capture generation (regression: captures must be real)', () => {
  beforeEach(() => {
    appStore.getState().startSession(); // resets shots: [] and settings stay default
  });

  it('(a) a working getJpeg captures backswing + contact + follow-through, and the shot lands in the store', () => {
    const completed = captureCompletedShot();
    const detector = new ShotDetector({ onShotCompleted: completed.onShotCompleted });
    detector.reset();

    let calls = 0;
    const getJpeg: GetJpeg = () => {
      calls += 1;
      return mkCtx(`ok-${calls}`);
    };

    runSyntheticSwing(detector, getJpeg);

    const shot = completed.get();
    expect(shot.captures.length).toBe(3);
    expect(shot.captures.map((c) => c.phase).sort()).toEqual(
      ['backswing', 'contact', 'follow-through'].sort(),
    );
    // Every capture is real (non-empty jpeg, owning shotId set).
    for (const c of shot.captures) {
      expect(c.jpegBase64.length).toBeGreaterThan(0);
      expect(c.shotId).toBe(shot.id);
    }

    const stored = appStore.getState().shots.find((s) => s.id === shot.id);
    expect(stored).toBeDefined();
    expect(stored?.captures.length).toBe(3);
  });

  it('(b) getJpeg fails throughout the swing but succeeds at finalize -> synthesizes a contact capture from the detector\'s OWN peak-frame angles', () => {
    const completed = captureCompletedShot();
    const detector = new ShotDetector({ onShotCompleted: completed.onShotCompleted });
    detector.reset();

    // Fails on the first 3 attempts (backswing, contact-at-peak, follow-through
    // keyframe attempts during the swing), succeeds on the 4th (finalize's retry).
    let calls = 0;
    const getJpeg: GetJpeg = () => {
      calls += 1;
      if (calls <= 3) return undefined;
      return mkCtx('finalize-retry');
    };

    const peakAngles = runSyntheticSwing(detector, getJpeg);

    const shot = completed.get();
    expect(calls).toBeGreaterThanOrEqual(4);

    expect(shot.captures.length).toBe(1);
    const contact = shot.captures[0];
    expect(contact.phase).toBe('contact');
    expect(contact.jpegBase64).toBe('jpeg-finalize-retry');
    // The defining assertion: the synthesized capture's angles are the exact
    // SAME object the detector locked in at the swing's peak — never a
    // re-derived copy from the late getJpeg() call's (irrelevant) pose.
    expect(contact.angles).toBe(peakAngles);
    expect(contact.shotId).toBe(shot.id);

    const stored = appStore.getState().shots.find((s) => s.id === shot.id);
    expect(stored?.captures[0]?.angles).toBe(peakAngles);
  });

  it('(c) getJpeg always undefined -> the shot still completes gracefully with captures []', () => {
    const completed = captureCompletedShot();
    const detector = new ShotDetector({ onShotCompleted: completed.onShotCompleted });
    detector.reset();

    const getJpeg: GetJpeg = () => undefined;

    runSyntheticSwing(detector, getJpeg);

    const shot = completed.get();
    expect(shot.captures).toEqual([]);
    expect(shot.contactFrameJpegBase64).toBeUndefined();

    const stored = appStore.getState().shots.find((s) => s.id === shot.id);
    expect(stored?.captures).toEqual([]);
  });

  it('(d) no getJpeg at all (camera/pose unavailable) -> the shot still completes with captures []', () => {
    const completed = captureCompletedShot();
    const detector = new ShotDetector({ onShotCompleted: completed.onShotCompleted });
    detector.reset();

    runSyntheticSwing(detector, undefined);

    const shot = completed.get();
    expect(shot.captures).toEqual([]);
  });
});

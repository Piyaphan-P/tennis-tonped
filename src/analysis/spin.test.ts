import { describe, it, expect } from 'vitest';
import {
  classifySpin,
  spinPercentages,
  addSpinCounts,
  emptySpinCounts,
  SPIN_FLAT_BAND,
} from './spin';
import { LM } from '../types';
import type { JointAngles, Landmark, Shot, SwingCapture, ShotPhase, AngleStatuses } from '../types';

// --- builders ---------------------------------------------------------------

function angles(): JointAngles {
  return {
    timestampMs: 0,
    leftElbowDeg: 140,
    rightElbowDeg: 140,
    leftShoulderDeg: 85,
    rightShoulderDeg: 85,
    leftKneeDeg: 140,
    rightKneeDeg: 140,
    leftHipDeg: 170,
    rightHipDeg: 170,
    trunkLeanDeg: 5,
    wristSpeed: 1,
    wristVelX: 0,
  };
}

const GOOD_STATUSES: AngleStatuses = {
  domElbow: 'good',
  domShoulder: 'good',
  leftKnee: 'good',
  rightKnee: 'good',
  trunk: 'good',
};

/** 33 landmarks all at (0.5,0.5); override the RIGHT_WRIST y (visibility 1). */
function landmarksWithRightWristY(y: number, visibility = 1): Landmark[] {
  const lms: Landmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 1,
  }));
  lms[LM.RIGHT_WRIST] = { x: 0.5, y, z: 0, visibility };
  return lms;
}

function capture(phase: ShotPhase, wristY: number, visibility = 1): SwingCapture {
  return {
    id: `cap-${phase}-${wristY}`,
    shotId: 'shot',
    phase,
    jpegBase64: '',
    atMs: 0,
    angles: angles(),
    landmarks: landmarksWithRightWristY(wristY, visibility),
    statuses: GOOD_STATUSES,
  };
}

function shot(captures: SwingCapture[]): Shot {
  return {
    id: 'shot',
    index: 1,
    type: 'forehand',
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    contactAngles: angles(),
    peakWristSpeed: 1.2,
    score: 80,
    issues: [],
    captures,
  };
}

describe('classifySpin — vertical wrist path (image y is TOP-DOWN)', () => {
  it('topspin: hand brushes UP (physically) → image y DECREASES backswing→follow-through', () => {
    // Physical statement: backswing wrist is LOW (near the ground) = LARGE y
    // (bottom of frame); follow-through wrist is HIGH (near the head) = SMALL y
    // (top of frame). A low-to-high brush is topspin.
    const s = shot([capture('backswing', 0.8), capture('follow-through', 0.3)]);
    expect(classifySpin(s, 'right')).toBe('topspin');
  });

  it('backspin: hand chops DOWN (physically) → image y INCREASES backswing→follow-through', () => {
    // Backswing wrist HIGH (small y), follow-through LOW (large y): high-to-low.
    const s = shot([capture('backswing', 0.3), capture('follow-through', 0.8)]);
    expect(classifySpin(s, 'right')).toBe('backspin');
  });

  it('flat: negligible vertical travel (< flat band)', () => {
    const s = shot([capture('backswing', 0.5), capture('follow-through', 0.5 + SPIN_FLAT_BAND / 2)]);
    expect(classifySpin(s, 'right')).toBe('flat');
  });

  it('uses earliest→latest by canonical phase order regardless of array order', () => {
    // Follow-through listed first; earliest (backswing, y=0.8) → latest
    // (follow-through, y=0.3) still reads as an upward brush = topspin.
    const s = shot([capture('follow-through', 0.3), capture('backswing', 0.8)]);
    expect(classifySpin(s, 'right')).toBe('topspin');
  });

  it('flat when fewer than two usable captures (contact-only shot)', () => {
    expect(classifySpin(shot([capture('contact', 0.5)]), 'right')).toBe('flat');
    expect(classifySpin(shot([]), 'right')).toBe('flat');
  });

  it('ignores low-visibility wrist points (drops below the 2-usable floor → flat)', () => {
    const s = shot([capture('backswing', 0.8, 0.1), capture('follow-through', 0.3)]);
    expect(classifySpin(s, 'right')).toBe('flat');
  });

  it('respects dominant hand — reads the LEFT wrist for a left-hander', () => {
    // Right wrist stays flat; left wrist brushes up. A right-hand read would
    // say flat, a left-hand read says topspin.
    const mk = (leftY: number, phase: ShotPhase): SwingCapture => {
      const c = capture(phase, 0.5);
      c.landmarks[LM.LEFT_WRIST] = { x: 0.5, y: leftY, z: 0, visibility: 1 };
      return c;
    };
    const s = shot([mk(0.8, 'backswing'), mk(0.3, 'follow-through')]);
    expect(classifySpin(s, 'right')).toBe('flat');
    expect(classifySpin(s, 'left')).toBe('topspin');
  });
});

describe('spin count helpers', () => {
  it('spinPercentages splits over the total classified shots', () => {
    expect(spinPercentages({ topspin: 3, backspin: 1, flat: 0 })).toEqual({
      topspin: 75,
      backspin: 25,
      flat: 0,
    });
  });

  it('spinPercentages returns all-zero for an empty tally', () => {
    expect(spinPercentages(emptySpinCounts())).toEqual({ topspin: 0, backspin: 0, flat: 0 });
  });

  it('addSpinCounts sums field-wise', () => {
    expect(addSpinCounts({ topspin: 1, backspin: 2, flat: 3 }, { topspin: 4, backspin: 5, flat: 6 })).toEqual(
      { topspin: 5, backspin: 7, flat: 9 },
    );
  });
});

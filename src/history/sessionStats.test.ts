import { describe, it, expect } from 'vitest';
import { deriveSessionStats, deriveCumulativeStats } from './sessionStats';
import { TENNIS_PRACTICE_MET } from '../analysis/calories';
import { LM } from '../types';
import type {
  JointAngles,
  Landmark,
  Shot,
  StoredSession,
  SwingCapture,
  ShotPhase,
  AngleStatuses,
} from '../types';

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

const GOOD: AngleStatuses = {
  domElbow: 'good',
  domShoulder: 'good',
  leftKnee: 'good',
  rightKnee: 'good',
  trunk: 'good',
};

function lmsRightWristY(y: number): Landmark[] {
  const lms: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  lms[LM.RIGHT_WRIST] = { x: 0.5, y, z: 0, visibility: 1 };
  return lms;
}

function cap(phase: ShotPhase, y: number): SwingCapture {
  return {
    id: `${phase}-${y}`,
    shotId: 's',
    phase,
    jpegBase64: '',
    atMs: 0,
    angles: angles(),
    landmarks: lmsRightWristY(y),
    statuses: GOOD,
  };
}

function shot(opts: { speedKmh?: number; captures?: SwingCapture[] } = {}): Shot {
  return {
    id: `s${Math.random()}`,
    index: 1,
    type: 'forehand',
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    contactAngles: angles(),
    peakWristSpeed: 1.2,
    speedKmh: opts.speedKmh,
    score: 80,
    issues: [],
    captures: opts.captures ?? [],
  };
}

describe('deriveSessionStats', () => {
  it('computes duration, shots, avg speed, kcal and spin from live shots', () => {
    const shots = [
      shot({ speedKmh: 50, captures: [cap('backswing', 0.8), cap('follow-through', 0.3)] }), // topspin
      shot({ speedKmh: 70, captures: [cap('backswing', 0.3), cap('follow-through', 0.8)] }), // backspin
      shot({ speedKmh: undefined, captures: [cap('contact', 0.5)] }), // flat (contact-only), no speed
    ];
    const durationMs = 30 * 60 * 1000; // 30 min
    const s = deriveSessionStats(shots, durationMs, 70, 'right');

    expect(s.shotCount).toBe(3);
    expect(s.durationMs).toBe(durationMs);
    expect(s.avgSpeedKmh).toBe(60); // mean of 50 & 70; undefined ignored
    expect(s.spin).toEqual({ topspin: 1, backspin: 1, flat: 1 });
    expect(s.kcal).toBe(Math.round(TENNIS_PRACTICE_MET * 70 * 0.5)); // 30 min = 0.5h
  });

  it('avgSpeedKmh is undefined when no shot has a speed', () => {
    const s = deriveSessionStats([shot({ speedKmh: undefined })], 60000, 65, 'right');
    expect(s.avgSpeedKmh).toBeUndefined();
  });

  it('handles an empty session without crashing', () => {
    const s = deriveSessionStats([], 0, 65, 'right');
    expect(s).toEqual({
      durationMs: 0,
      shotCount: 0,
      avgSpeedKmh: undefined,
      kcal: 0,
      spin: { topspin: 0, backspin: 0, flat: 0 },
    });
  });
});

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

describe('deriveCumulativeStats', () => {
  it('aggregates minutes, shots, kcal, spin and shot-weighted avg speed', () => {
    const history: StoredSession[] = [
      stored({
        durationMs: 20 * 60 * 1000,
        shotCount: 10,
        avgSpeedKmh: 60,
        kcal: 100,
        spin: { topspin: 6, backspin: 3, flat: 1 },
      }),
      stored({
        durationMs: 10 * 60 * 1000,
        shotCount: 30,
        avgSpeedKmh: 40,
        kcal: 50,
        spin: { topspin: 10, backspin: 15, flat: 5 },
      }),
    ];
    const c = deriveCumulativeStats(history);
    expect(c.sessions).toBe(2);
    expect(c.totalMinutes).toBe(30);
    expect(c.totalShots).toBe(40);
    expect(c.totalKcal).toBe(150);
    expect(c.spin).toEqual({ topspin: 16, backspin: 18, flat: 6 });
    // shot-weighted: (60*10 + 40*30) / (10+30) = 1800/40 = 45
    expect(c.avgSpeedKmh).toBe(45);
  });

  it('is backward-compatible: pre-v1.8 rows missing new fields never crash', () => {
    const old = stored({}); // no avgSpeedKmh / kcal / spin
    delete (old as Partial<StoredSession>).avgSpeedKmh;
    delete (old as Partial<StoredSession>).kcal;
    delete (old as Partial<StoredSession>).spin;
    const c = deriveCumulativeStats([old]);
    expect(c.sessions).toBe(1);
    expect(c.totalKcal).toBe(0);
    expect(c.avgSpeedKmh).toBeUndefined();
    expect(c.spin).toEqual({ topspin: 0, backspin: 0, flat: 0 });
    expect(c.totalShots).toBe(5);
  });

  it('empty history yields zeros / undefined speed', () => {
    const c = deriveCumulativeStats([]);
    expect(c).toEqual({
      sessions: 0,
      totalMinutes: 0,
      totalShots: 0,
      avgSpeedKmh: undefined,
      totalKcal: 0,
      spin: { topspin: 0, backspin: 0, flat: 0 },
    });
  });
});

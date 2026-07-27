import { describe, it, expect } from 'vitest';
import { scoreShot, RULES, SPEED_GOOD, SPEED_WARN } from './scoring';
import { SHOT_THRESHOLDS } from './shotDetector';
import type { JointAngles } from '../types';

// A well-formed contact snapshot: every angle rule in its "good" window.
function goodAngles(patch: Partial<JointAngles> = {}): JointAngles {
  return {
    timestampMs: 0,
    leftElbowDeg: 140,
    rightElbowDeg: 140, // 120–160 good
    leftShoulderDeg: 85,
    rightShoulderDeg: 85, // 60–110 good
    leftKneeDeg: 140,
    rightKneeDeg: 140, // 125–160 good
    leftHipDeg: 170,
    rightHipDeg: 170,
    trunkLeanDeg: 5, // ≤15 good
    wristSpeed: 0,
    wristVelX: 0,
    ...patch,
  };
}

const has = (r: ReturnType<typeof scoreShot>, key: string) =>
  r.issues.some((i) => i.key === key);

describe('scoreShot — peak wrist speed (v1.0.4 stale-tuning fix)', () => {
  it('SPEED_GOOD stays anchored to the detector contact gate (drift lock)', () => {
    // The peak handed to the scorer is prevSpeed at the gated contact tick, so a
    // completed shot's peak is ALWAYS >= contactMinPeakSpeed. If the "good" bar
    // ever rises above the gate, every real swing eats a permanent penalty —
    // the exact bug this fix removes. This assertion fails loudly if they drift.
    expect(SPEED_GOOD).toBe(SHOT_THRESHOLDS.contactMinPeakSpeed);
    expect(SPEED_WARN).toBeLessThan(SPEED_GOOD);
  });

  it('REGRESSION: a real swing peak above the gate is NOT penalized', () => {
    // v2.2: speeds are body-lengths/s; a normal completed swing peaks ≥ the
    // contact gate (2.0) by construction, so it must be clean (no false
    // "สวิงช้าไป" fault — the v1.0.4 regression, preserved in the new unit).
    const r = scoreShot({
      type: 'forehand',
      contactAngles: goodAngles(),
      peakWristSpeed: 2.3,
      dominantHand: 'right',
    });
    expect(has(r, 'swing-faster')).toBe(false);
    expect(r.score).toBe(100); // all rules good → clean
    expect(r.issues).toEqual([expect.objectContaining({ key: 'clean-contact', severity: 'good' })]);
  });

  it('peak exactly at the gate (SPEED_GOOD) is "good" — no penalty floor', () => {
    const r = scoreShot({
      type: 'forehand',
      contactAngles: goodAngles(),
      peakWristSpeed: SPEED_GOOD,
      dominantHand: 'right',
    });
    expect(has(r, 'swing-faster')).toBe(false);
    expect(r.score).toBe(100);
  });

  it('below the gate but above SPEED_WARN → warn (half penalty)', () => {
    const r = scoreShot({
      type: 'forehand',
      contactAngles: goodAngles(),
      peakWristSpeed: 1.6, // between SPEED_WARN (1.45) and SPEED_GOOD (2.0)
      dominantHand: 'right',
    });
    const issue = r.issues.find((i) => i.key === 'swing-faster');
    expect(issue?.severity).toBe('warn');
    expect(r.score).toBe(93); // 100 - 15*0.5 = 92.5 → round 93
  });

  it('a genuinely limp swing (< SPEED_WARN) → full fault', () => {
    const r = scoreShot({
      type: 'forehand',
      contactAngles: goodAngles(),
      peakWristSpeed: 0.5,
      dominantHand: 'right',
    });
    const issue = r.issues.find((i) => i.key === 'swing-faster');
    expect(issue?.severity).toBe('fault');
    expect(r.score).toBe(85); // 100 - 15
  });

  it('RULES table + issue target strings advertise the retuned target', () => {
    const rule = RULES.find((r) => r.key === 'swing-faster')!;
    expect(rule.target).toBe('≥2.0 body-lengths/s');
    const r = scoreShot({
      type: 'forehand',
      contactAngles: goodAngles(),
      peakWristSpeed: 0.5,
      dominantHand: 'right',
    });
    expect(r.issues.find((i) => i.key === 'swing-faster')!.target).toBe('≥2.0 body-lengths/s');
  });
});

describe('scoreShot — shoulder rule 4 still guards the 60–110 window', () => {
  it('shoulder angle out of range warns; the rest of the shot stays clean', () => {
    const r = scoreShot({
      type: 'forehand',
      contactAngles: goodAngles({ rightShoulderDeg: 40 }),
      peakWristSpeed: 2.3, // ≥ SPEED_GOOD so only the shoulder rule fires
      dominantHand: 'right',
    });
    const issue = r.issues.find((i) => i.key === 'shoulder-angle');
    expect(issue?.severity).toBe('warn');
    expect(issue?.target).toBe('60–110°');
    expect(r.score).toBe(93); // 100 - 15*0.5
  });

  it('in-range shoulder (85°) → no shoulder issue', () => {
    const r = scoreShot({
      type: 'forehand',
      contactAngles: goodAngles({ rightShoulderDeg: 85 }),
      peakWristSpeed: 1.3,
      dominantHand: 'right',
    });
    expect(has(r, 'shoulder-angle')).toBe(false);
  });
});

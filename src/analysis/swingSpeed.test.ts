// ============================================================================
// ADGE Tennis — swingSpeed calibration tests (synthetic landmarks, known geom).
// Verifies the normalized-body-length measurement, the height→km/h conversion,
// the visibility / out-of-frame guards, height clamping, and the chip format.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  NOSE_ANKLE_FRACTION,
  DEFAULT_HEIGHT_CM,
  HEIGHT_MIN_CM,
  HEIGHT_MAX_CM,
  SPEED_FACTOR_MIN,
  SPEED_FACTOR_MAX,
  DEFAULT_SPEED_FACTOR,
  clampHeightCm,
  clampSpeedFactor,
  normalizedBodyLength,
  estimateSpeedKmh,
  formatSpeedKmh,
} from './swingSpeed';
import type { Landmark } from '../types';
import { LM } from '../types';

/** 33-landmark frame with everything at origin/visible=1; caller overrides. */
function frame(overrides: Record<number, Partial<Landmark>>): Landmark[] {
  const lms: Landmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 1,
  }));
  for (const [idx, o] of Object.entries(overrides)) {
    lms[Number(idx)] = { ...lms[Number(idx)], ...o };
  }
  return lms;
}

/** Nose at top, ankles at bottom: a clean vertical body of known length. */
function standingFrame(noseY: number, ankleY: number, vis = 1): Landmark[] {
  return frame({
    0: { x: 0.5, y: noseY, visibility: vis },
    [LM.LEFT_ANKLE]: { x: 0.48, y: ankleY, visibility: vis },
    [LM.RIGHT_ANKLE]: { x: 0.52, y: ankleY, visibility: vis },
  });
}

describe('clampHeightCm', () => {
  it('defaults on null/NaN/undefined', () => {
    expect(clampHeightCm(undefined)).toBe(DEFAULT_HEIGHT_CM);
    expect(clampHeightCm(null)).toBe(DEFAULT_HEIGHT_CM);
    expect(clampHeightCm(NaN)).toBe(DEFAULT_HEIGHT_CM);
  });
  it('clamps to the supported range', () => {
    expect(clampHeightCm(50)).toBe(HEIGHT_MIN_CM);
    expect(clampHeightCm(300)).toBe(HEIGHT_MAX_CM);
    expect(clampHeightCm(180)).toBe(180);
  });
});

describe('normalizedBodyLength', () => {
  it('measures nose→ankle-midpoint with the hypot convention', () => {
    // nose y=0.1, ankles y=0.9, x aligned → length ≈ 0.8
    const len = normalizedBodyLength(standingFrame(0.1, 0.9));
    expect(len).toBeCloseTo(0.8, 5);
  });

  it('averages both ankles for the midpoint', () => {
    const lms = frame({
      0: { x: 0.5, y: 0.1 },
      [LM.LEFT_ANKLE]: { x: 0.5, y: 0.7 },
      [LM.RIGHT_ANKLE]: { x: 0.5, y: 0.9 },
    });
    // midpoint y = 0.8 → length 0.7
    expect(normalizedBodyLength(lms)).toBeCloseTo(0.7, 5);
  });

  it('returns undefined when the nose is low-visibility', () => {
    expect(normalizedBodyLength(standingFrame(0.1, 0.9, 0.2))).toBeUndefined();
  });

  it('returns undefined when both ankles are out of frame (low visibility)', () => {
    const lms = standingFrame(0.1, 0.9);
    lms[LM.LEFT_ANKLE].visibility = 0.1;
    lms[LM.RIGHT_ANKLE].visibility = 0.1;
    expect(normalizedBodyLength(lms)).toBeUndefined();
  });

  it('still works with only one visible ankle', () => {
    const lms = standingFrame(0.1, 0.9);
    lms[LM.LEFT_ANKLE].visibility = 0.1; // only right ankle usable (x=0.52,y=0.9)
    expect(normalizedBodyLength(lms)).toBeCloseTo(Math.hypot(0.02, 0.8), 5);
  });

  it('returns undefined for an implausibly small body length', () => {
    expect(normalizedBodyLength(standingFrame(0.5, 0.55))).toBeUndefined();
  });

  it('returns undefined for empty/absent input', () => {
    expect(normalizedBodyLength([])).toBeUndefined();
    expect(normalizedBodyLength(null)).toBeUndefined();
  });
});

describe('estimateSpeedKmh', () => {
  it('applies scaleMeters = heightM × fraction / bodyLen, ×3.6', () => {
    // bodyLen 0.8, height 170cm=1.7m, peak 1.1 units/s
    const bodyLen = 0.8;
    const heightM = 1.7;
    const peak = 1.1;
    const expected = Math.round(peak * ((heightM * NOSE_ANKLE_FRACTION) / bodyLen) * 3.6);
    expect(estimateSpeedKmh(standingFrame(0.1, 0.9), peak, 170)).toBe(expected);
  });

  it('scales linearly with wrist speed', () => {
    const lms = standingFrame(0.1, 0.9);
    const a = estimateSpeedKmh(lms, 1.0, 170) as number;
    const b = estimateSpeedKmh(lms, 2.0, 170) as number;
    // integer-rounded, so allow ±1 around the exact 2× relationship
    expect(Math.abs(b - 2 * a)).toBeLessThanOrEqual(1);
  });

  it('scales with player height', () => {
    const lms = standingFrame(0.1, 0.9);
    const tall = estimateSpeedKmh(lms, 1.1, 200) as number;
    const short = estimateSpeedKmh(lms, 1.1, 150) as number;
    expect(tall).toBeGreaterThan(short);
  });

  it('returns undefined when calibration is impossible (body out of frame)', () => {
    const lms = standingFrame(0.1, 0.9, 0.1);
    expect(estimateSpeedKmh(lms, 1.1, 170)).toBeUndefined();
  });

  it('returns undefined for non-positive or non-finite speed', () => {
    const lms = standingFrame(0.1, 0.9);
    expect(estimateSpeedKmh(lms, 0, 170)).toBeUndefined();
    expect(estimateSpeedKmh(lms, -1, 170)).toBeUndefined();
    expect(estimateSpeedKmh(lms, NaN, 170)).toBeUndefined();
  });

  it('clamps an out-of-range height rather than exploding', () => {
    const lms = standingFrame(0.1, 0.9);
    // height 0 → clamps to HEIGHT_MIN_CM, still a finite positive estimate
    const v = estimateSpeedKmh(lms, 1.1, 0) as number;
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });
});

describe('formatSpeedKmh', () => {
  it('formats with the ≈ prefix and localized unit', () => {
    expect(formatSpeedKmh(62, 'en')).toBe('≈ 62 km/h');
    expect(formatSpeedKmh(62, 'th')).toBe('≈ 62 กม./ชม.');
  });
  it('returns empty string for undefined/non-finite', () => {
    expect(formatSpeedKmh(undefined, 'th')).toBe('');
    expect(formatSpeedKmh(NaN, 'en')).toBe('');
  });
});

describe('clampSpeedFactor (PO-tunable km/h calibration multiplier)', () => {
  it('defaults to 1.0 (identity) for absent/garbage values', () => {
    expect(DEFAULT_SPEED_FACTOR).toBe(1.0);
    expect(clampSpeedFactor(undefined)).toBe(1.0);
    expect(clampSpeedFactor(null)).toBe(1.0);
    expect(clampSpeedFactor(NaN)).toBe(1.0);
  });
  it('clamps to [0.5, 3.0]', () => {
    expect(clampSpeedFactor(0.1)).toBe(SPEED_FACTOR_MIN);
    expect(clampSpeedFactor(10)).toBe(SPEED_FACTOR_MAX);
    expect(clampSpeedFactor(1.7)).toBe(1.7);
  });
});

describe('estimateSpeedKmh — correction factor', () => {
  const lms = standingFrame(0.1, 0.9); // body length 0.8

  it('factor 1.0 is identical to the default (no silent shift)', () => {
    const base = estimateSpeedKmh(lms, 1.5, 170) as number;
    expect(estimateSpeedKmh(lms, 1.5, 170, 1.0)).toBe(base);
    expect(estimateSpeedKmh(lms, 1.5, 170, undefined)).toBe(base);
  });

  it('scales the km/h by the factor (2× factor ≈ 2× speed)', () => {
    const base = estimateSpeedKmh(lms, 1.5, 170) as number;
    const doubled = estimateSpeedKmh(lms, 1.5, 170, 2.0) as number;
    // integer-rounded, so allow ±1 around the exact 2× relationship
    expect(Math.abs(doubled - 2 * base)).toBeLessThanOrEqual(1);
  });

  it('out-of-range factors are clamped before applying', () => {
    const base = estimateSpeedKmh(lms, 1.5, 170) as number;
    // 10 clamps to 3.0, 0.1 clamps to 0.5 (±1 rounding tolerance)
    expect(Math.abs((estimateSpeedKmh(lms, 1.5, 170, 10) as number) - base * SPEED_FACTOR_MAX)).toBeLessThanOrEqual(1);
    expect(Math.abs((estimateSpeedKmh(lms, 1.5, 170, 0.1) as number) - base * SPEED_FACTOR_MIN)).toBeLessThanOrEqual(1);
  });
});

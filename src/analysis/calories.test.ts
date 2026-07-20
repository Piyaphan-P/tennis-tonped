import { describe, it, expect } from 'vitest';
import {
  clampWeightKg,
  estimateCalories,
  TENNIS_PRACTICE_MET,
  DEFAULT_WEIGHT_KG,
  WEIGHT_MIN_KG,
  WEIGHT_MAX_KG,
} from './calories';

describe('clampWeightKg', () => {
  it('passes through an in-range weight', () => {
    expect(clampWeightKg(72)).toBe(72);
  });
  it('clamps below/above the supported range', () => {
    expect(clampWeightKg(10)).toBe(WEIGHT_MIN_KG);
    expect(clampWeightKg(500)).toBe(WEIGHT_MAX_KG);
  });
  it('defaults on NaN / null / undefined', () => {
    expect(clampWeightKg(NaN)).toBe(DEFAULT_WEIGHT_KG);
    expect(clampWeightKg(null)).toBe(DEFAULT_WEIGHT_KG);
    expect(clampWeightKg(undefined)).toBe(DEFAULT_WEIGHT_KG);
  });
});

describe('estimateCalories — MET × weight × hours', () => {
  it('matches the MET formula for exactly one hour', () => {
    // 1 hour, 70 kg → MET × 70 × 1
    expect(estimateCalories(3_600_000, 70)).toBe(Math.round(TENNIS_PRACTICE_MET * 70 * 1));
  });

  it('scales linearly with time (half an hour = half the burn)', () => {
    const full = estimateCalories(3_600_000, 80);
    const half = estimateCalories(1_800_000, 80);
    expect(half).toBe(Math.round(full / 2));
  });

  it('re-clamps a garbage weight before computing', () => {
    // weight 5 kg clamps to WEIGHT_MIN_KG
    expect(estimateCalories(3_600_000, 5)).toBe(Math.round(TENNIS_PRACTICE_MET * WEIGHT_MIN_KG));
  });

  it('returns 0 for non-positive / non-finite durations', () => {
    expect(estimateCalories(0, 70)).toBe(0);
    expect(estimateCalories(-100, 70)).toBe(0);
    expect(estimateCalories(NaN, 70)).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import {
  computeBreakdown,
  deltaTHB,
  tokensToTHB,
  formatTHB,
  formatTokens,
  DEFAULT_RATES,
} from './pricing';
import type { TokenTotals, UsageDelta } from '../types';

describe('pricing math', () => {
  it('tokensToTHB: 1M tokens at $1/1M and 36.5 THB/USD = 36.5 THB', () => {
    expect(tokensToTHB(1_000_000, 1, 36.5)).toBeCloseTo(36.5, 6);
  });

  it('computeBreakdown sums per-modality THB into thbTotal', () => {
    const tokens: TokenTotals = {
      textIn: 1_000_000,
      audioIn: 0,
      videoIn: 0,
      textOut: 0,
      audioOut: 0,
      thoughts: 0,
      total: 1_000_000,
    };
    const b = computeBreakdown(tokens, { ...DEFAULT_RATES, usdToThb: 36.5 });
    // textInPer1M = 0.5 USD -> 0.5 * 36.5 = 18.25 THB
    expect(b.textInTHB).toBeCloseTo(18.25, 6);
    expect(b.thbTotal).toBeCloseTo(18.25, 6);
  });

  it('deltaTHB prices thoughts at the text-output rate', () => {
    const d: UsageDelta = {
      atMs: 0,
      promptTokens: {},
      responseTokens: {},
      thoughtsTokens: 1_000_000,
      totalTokens: 1_000_000,
    };
    const rates = { ...DEFAULT_RATES, usdToThb: 36.5 };
    // textOutPer1M = 2.0 USD -> 2 * 36.5 = 73 THB
    expect(deltaTHB(d, rates)).toBeCloseTo(73, 6);
  });
});

describe('formatTHB', () => {
  it('uses 4 decimals below 0.1 THB', () => {
    expect(formatTHB(0.01234)).toBe('฿0.0123');
  });
  it('uses 3 decimals below 10 THB', () => {
    expect(formatTHB(1.23456)).toBe('฿1.235');
  });
  it('uses 2 decimals at or above 10 THB', () => {
    expect(formatTHB(123.456)).toBe('฿123.46');
  });
});

describe('formatTokens', () => {
  it('shows raw integers below 1000', () => {
    expect(formatTokens(42)).toBe('42');
  });
  it('formats thousands with a k suffix', () => {
    expect(formatTokens(1234)).toBe('1.2k');
  });
  it('formats millions with an M suffix', () => {
    expect(formatTokens(3_450_000)).toBe('3.5M');
  });
});

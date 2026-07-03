// ============================================================================
// ต้นและเพชร Tennis Club (Ton & Phet Tennis Club) — pricing utilities
// (pure, standalone)
//
// SOURCE OF TRUTH for the billing math (computeBreakdown / deltaTHB) is
// src/store.ts — this module re-exports those two functions rather than
// duplicating the formulas, so there is exactly one place that can drift
// from Google's pricing page.
//
// NOTE: DEFAULT_RATES below are editable ESTIMATES entered at build time
// (USD per 1M tokens for gemini-2.5-flash-native-audio-preview Live API).
// Check them against https://ai.google.dev/gemini-api/docs/pricing before
// trusting them for real budgeting — Google can change prices without
// notice. Users can also override them live in SettingsSheet.
// ============================================================================

import type { PricingRates } from '../types';

export { computeBreakdown, deltaTHB } from '../store';

/** Reads VITE_USD_TO_THB (default 36.5); mirrors store.ts's envUsdToThb(). */
function envUsdToThb(): number {
  try {
    const raw = (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_USD_TO_THB;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 36.5;
  } catch {
    return 36.5;
  }
}

/**
 * Default USD-per-1M-token rates for gemini-2.5-flash-native-audio (Live API).
 * Identical values to DEFAULT_RATES in src/store.ts — keep the two in sync.
 */
export const DEFAULT_RATES: PricingRates = {
  textInPer1M: 0.5,
  audioInPer1M: 3.0,
  videoInPer1M: 3.0,
  textOutPer1M: 2.0,
  audioOutPer1M: 12.0,
  usdToThb: envUsdToThb(),
};

/** THB cost of `tokens` at a USD-per-1M rate and a USD→THB exchange rate. */
export function tokensToTHB(tokens: number, usdPer1M: number, usdToThb: number): number {
  return (tokens * usdPer1M * usdToThb) / 1_000_000;
}

/**
 * Format a THB amount for display. Tabular alignment (fixed-width digits) is
 * a CSS concern (font-variant-numeric: tabular-nums on the mono font) — this
 * function only decides precision:
 *   < 0.1 THB  -> 4 decimals (sub-satang costs still show something non-zero)
 *   < 10 THB   -> 3 decimals
 *   otherwise  -> 2 decimals (normal currency display)
 */
export function formatTHB(v: number): string {
  const abs = Math.abs(v);
  const decimals = abs < 0.1 ? 4 : abs < 10 ? 3 : 2;
  return '฿' + v.toFixed(decimals);
}

/** Format a token count compactly, e.g. 1234 -> '1.2k', 3_450_000 -> '3.5M'. */
export function formatTokens(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

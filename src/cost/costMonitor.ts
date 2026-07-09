// ============================================================================
// ADGE Tennis — cost monitor
// Bridges raw Gemini Live usageMetadata into the store's cost accounting.
// SOURCE OF TRUTH for cost (see CLAUDE.md): every usageMetadata message that
// arrives on the Live session is parsed here and folded into cumulative
// THB via appStore.addUsage. parseUsage() is the pure, unit-testable core;
// record() = parseUsage() + dispatch to the store (the only side effect).
// ============================================================================

import { appStore } from '../store';
import type { TokenModality, UsageDelta } from '../types';

/** Shape of one entry in usageMetadata.*TokensDetails. */
interface ModalityDetail {
  modality?: string;
  tokenCount?: number;
}

/** Loose shape of the server usageMetadata object (defensive — raw may be partial). */
export interface RawUsageMetadata {
  promptTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: ModalityDetail[];
  responseTokensDetails?: ModalityDetail[];
  /**
   * RAW WIRE NAMES (Vertex relay path): the Live wire calls the response side
   * `candidatesTokenCount`/`candidatesTokensDetails`; the SDK renames it to
   * `response*` client-side — but the relay feeds raw wire JSON straight into
   * costMonitor, bypassing the SDK. Without these fallbacks every coach reply's
   * AUDIO-out tokens ($12/1M — the most expensive modality) go unbilled.
   */
  candidatesTokenCount?: number;
  candidatesTokensDetails?: ModalityDetail[];
}

const MODALITIES: TokenModality[] = ['TEXT', 'AUDIO', 'VIDEO'];

/**
 * Map a raw usageMetadata modality string to one of our billing buckets.
 *
 * VERTEX QUIRK (empirically verified, see CLAUDE.md): the Vertex Live API
 * reports still-image frames sent via sendRealtimeInput({video}) under the
 * modality string **"IMAGE"** (they are ~93% of prompt tokens on a per-shot
 * turn that sends several JPEGs). Image input is priced identically to video
 * input ($3 / 1M tokens), so we fold IMAGE into the VIDEO ("visual input")
 * bucket rather than adding a first-class modality — this keeps a single
 * $3/1M visual bucket in the THB breakdown UI (token.videoIn) and, critically,
 * stops silently DROPPING the dominant cost on every coached shot. (The old
 * code kept only TEXT/AUDIO/VIDEO, so IMAGE was discarded → THB under-count.)
 */
function normalizeModality(m: string | undefined): TokenModality | null {
  if (!m) return null;
  const upper = m.toUpperCase();
  if (upper === 'IMAGE') return 'VIDEO';
  return (MODALITIES as string[]).includes(upper) ? (upper as TokenModality) : null;
}

/** Sum a details[] array into a per-modality token map, keeping only TEXT/AUDIO/VIDEO. */
function foldDetails(details: ModalityDetail[] | undefined): Partial<Record<TokenModality, number>> {
  const out: Partial<Record<TokenModality, number>> = {};
  if (!details) return out;
  for (const d of details) {
    const mod = normalizeModality(d.modality);
    if (!mod) continue;
    out[mod] = (out[mod] ?? 0) + (d.tokenCount ?? 0);
  }
  return out;
}

/** True if a delta carries no billable/reportable signal at all. */
function isZeroDelta(d: UsageDelta): boolean {
  const promptSum = Object.values(d.promptTokens).reduce((a, b) => a + (b ?? 0), 0);
  const responseSum = Object.values(d.responseTokens).reduce((a, b) => a + (b ?? 0), 0);
  return promptSum === 0 && responseSum === 0 && d.thoughtsTokens === 0 && d.totalTokens === 0;
}

/**
 * Parse one raw usageMetadata payload (unknown/partial shape — defensive)
 * into a normalized UsageDelta. Returns null if there is nothing usable
 * (absent, empty, or an all-zero event), so callers can skip it.
 *
 * SUBTLETY: on some SDK/model versions responseTokensDetails' TEXT bucket
 * already includes thoughts tokens (i.e. thoughtsTokenCount is counted
 * twice: once standalone, once folded into TEXT). We defensively subtract
 * thoughtsTokenCount from the response TEXT bucket, clamped to 0, so a
 * shot's "thoughts" line and its "text out" line never double-bill the
 * same tokens.
 */
export function parseUsage(raw: unknown, atMs: number = Date.now()): UsageDelta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawUsageMetadata;

  let promptTokens = foldDetails(r.promptTokensDetails);
  // SDK name first, raw wire name (relay path) second — never both populated
  // for one payload, so there is no double-count path.
  let responseTokens = foldDetails(r.responseTokensDetails ?? r.candidatesTokensDetails);

  const hasPromptDetail = Object.keys(promptTokens).length > 0;
  const hasResponseDetail = Object.keys(responseTokens).length > 0;

  // Fallback: no per-modality breakdown from the server — attribute the flat
  // prompt/response counts to TEXT so cumulative totals still reconcile.
  if (!hasPromptDetail && r.promptTokenCount) {
    promptTokens = { TEXT: r.promptTokenCount };
  }
  const flatResponse = r.responseTokenCount ?? r.candidatesTokenCount;
  if (!hasResponseDetail && flatResponse) {
    responseTokens = { TEXT: flatResponse };
  }

  const thoughtsTokens = r.thoughtsTokenCount ?? 0;
  const totalTokens = r.totalTokenCount ?? 0;

  // Avoid double-billing thoughts if they were folded into response TEXT.
  if (thoughtsTokens > 0 && responseTokens.TEXT !== undefined) {
    responseTokens = {
      ...responseTokens,
      TEXT: Math.max(0, responseTokens.TEXT - thoughtsTokens),
    };
  }

  const delta: UsageDelta = { atMs, promptTokens, responseTokens, thoughtsTokens, totalTokens };
  if (isZeroDelta(delta)) return null;
  return delta;
}

/**
 * costMonitor.record — the impure entry point wired into liveClient's
 * onmessage handler. Parses `raw` and, if it carries usable token counts,
 * dispatches it to appStore.addUsage (which recomputes the live THB
 * breakdown and attributes cost to the in-flight shot, if any).
 */
export const costMonitor = {
  record(raw: unknown): void {
    const delta = parseUsage(raw);
    if (!delta) return;
    appStore.getState().addUsage(delta);
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug('[costMonitor] usage', delta);
    }
  },
};

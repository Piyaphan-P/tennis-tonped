import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseUsage, costMonitor } from './costMonitor';
import { appStore, pruneHistory, loadHistory } from '../store';
import { HISTORY_TTL_MS } from '../types';
import type { StoredSession } from '../types';

describe('parseUsage', () => {
  it('folds per-modality details (sample usageMetadata shape)', () => {
    const delta = parseUsage(
      {
        promptTokenCount: 15,
        responseTokenCount: 20,
        totalTokenCount: 38,
        thoughtsTokenCount: 3,
        promptTokensDetails: [
          { modality: 'TEXT', tokenCount: 10 },
          { modality: 'AUDIO', tokenCount: 5 },
        ],
        responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 20 }],
      },
      123,
    );
    expect(delta).not.toBeNull();
    expect(delta!.promptTokens.TEXT).toBe(10);
    expect(delta!.promptTokens.AUDIO).toBe(5);
    expect(delta!.responseTokens.AUDIO).toBe(20);
    expect(delta!.responseTokens.TEXT).toBeUndefined();
    expect(delta!.thoughtsTokens).toBe(3);
    expect(delta!.totalTokens).toBe(38);
    expect(delta!.atMs).toBe(123);
  });

  it('falls back to TEXT when per-modality details are absent', () => {
    const delta = parseUsage({ promptTokenCount: 42, responseTokenCount: 7 });
    expect(delta!.promptTokens.TEXT).toBe(42);
    expect(delta!.responseTokens.TEXT).toBe(7);
  });

  it('maps the Vertex IMAGE modality into the VIDEO ($3/1M visual) bucket', () => {
    // Vertex Live reports still-image frames as modality "IMAGE" (verified in
    // the spike). Image input is priced identically to video, so it folds into
    // the VIDEO bucket rather than being dropped (the old under-count bug).
    const delta = parseUsage({
      promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 258 }],
    });
    expect(delta).not.toBeNull();
    expect(delta!.promptTokens.VIDEO).toBe(258);
    expect(delta!.promptTokens.TEXT).toBeUndefined();
  });

  it('sums IMAGE and any real VIDEO tokens into the same VIDEO bucket', () => {
    const delta = parseUsage({
      promptTokensDetails: [
        { modality: 'IMAGE', tokenCount: 200 },
        { modality: 'VIDEO', tokenCount: 40 },
        { modality: 'image', tokenCount: 18 }, // case-insensitive
      ],
    });
    expect(delta!.promptTokens.VIDEO).toBe(258);
  });

  it('falls back to the flat count when details exist but only have genuinely unknown modalities', () => {
    const delta = parseUsage({
      promptTokensDetails: [{ modality: 'DOCUMENT', tokenCount: 99 }],
      promptTokenCount: 99,
    });
    // DOCUMENT isn't a bucket we bill, so it's dropped from the folded map;
    // since the fold produced an empty map, the flat promptTokenCount fallback
    // kicks in so real usage still gets billed (attributed to TEXT).
    expect(delta).not.toBeNull();
    expect(delta!.promptTokens.TEXT).toBe(99);
  });

  it('normalizes lower/mixed-case modality strings', () => {
    const delta = parseUsage({
      promptTokensDetails: [{ modality: 'text', tokenCount: 12 }],
    });
    expect(delta!.promptTokens.TEXT).toBe(12);
  });

  it('subtracts thoughts tokens from response TEXT to avoid double-billing', () => {
    const delta = parseUsage({
      responseTokensDetails: [{ modality: 'TEXT', tokenCount: 50 }],
      thoughtsTokenCount: 20,
      totalTokenCount: 70,
    });
    expect(delta!.responseTokens.TEXT).toBe(30);
    expect(delta!.thoughtsTokens).toBe(20);
  });

  it('clamps the thoughts subtraction at 0 instead of going negative', () => {
    const delta = parseUsage({
      responseTokensDetails: [{ modality: 'TEXT', tokenCount: 5 }],
      thoughtsTokenCount: 20,
      totalTokenCount: 25,
    });
    expect(delta!.responseTokens.TEXT).toBe(0);
  });

  it('leaves response AUDIO untouched when subtracting thoughts (only TEXT is adjusted)', () => {
    const delta = parseUsage({
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }],
      thoughtsTokenCount: 20,
      totalTokenCount: 120,
    });
    expect(delta!.responseTokens.AUDIO).toBe(100);
    expect(delta!.responseTokens.TEXT).toBeUndefined();
  });

  it('returns null for absent, empty, or all-zero metadata', () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
    expect(parseUsage({})).toBeNull();
    expect(parseUsage('not-an-object')).toBeNull();
    expect(
      parseUsage({
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 0 }],
        totalTokenCount: 0,
      }),
    ).toBeNull();
  });

  it('defaults atMs to Date.now() when omitted', () => {
    const before = Date.now();
    const delta = parseUsage({ promptTokenCount: 1 });
    const after = Date.now();
    expect(delta!.atMs).toBeGreaterThanOrEqual(before);
    expect(delta!.atMs).toBeLessThanOrEqual(after);
  });
});

describe('costMonitor.record', () => {
  beforeEach(() => {
    appStore.setState({
      cost: {
        tokens: {
          textIn: 0,
          audioIn: 0,
          videoIn: 0,
          textOut: 0,
          audioOut: 0,
          thoughts: 0,
          total: 0,
        },
        breakdown: {
          thbTotal: 0,
          textInTHB: 0,
          audioInTHB: 0,
          videoInTHB: 0,
          textOutTHB: 0,
          audioOutTHB: 0,
          thoughtsTHB: 0,
        },
        attributingShotId: null,
        usageEvents: 0,
      },
    });
  });

  it('dispatches a parsed delta into the store, incrementing usageEvents and tokens', () => {
    costMonitor.record({
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 100 }],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 50 }],
      totalTokenCount: 150,
    });
    const state = appStore.getState();
    expect(state.cost.usageEvents).toBe(1);
    expect(state.cost.tokens.textIn).toBe(100);
    expect(state.cost.tokens.audioOut).toBe(50);
    expect(state.cost.breakdown.thbTotal).toBeGreaterThan(0);
  });

  it('is a no-op for events with no usable token counts', () => {
    costMonitor.record({});
    costMonitor.record(null);
    const state = appStore.getState();
    expect(state.cost.usageEvents).toBe(0);
  });

  it('accumulates across multiple events', () => {
    costMonitor.record({ promptTokenCount: 10 });
    costMonitor.record({ promptTokenCount: 5 });
    const state = appStore.getState();
    expect(state.cost.usageEvents).toBe(2);
    expect(state.cost.tokens.textIn).toBe(15);
  });

  it('bills a realistic Vertex per-shot payload including its dominant IMAGE tokens', () => {
    // Real per-shot usageMetadata shape from the Vertex spike: a small TEXT
    // prompt plus the swing JPEG(s) reported as IMAGE (the bulk of the tokens),
    // and an AUDIO coach reply. IMAGE MUST be billed (video $3/1M) — before the
    // fix it was silently dropped, under-counting nearly all of the shot's cost.
    costMonitor.record({
      promptTokenCount: 276,
      responseTokenCount: 50,
      totalTokenCount: 326,
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 18 },
        { modality: 'IMAGE', tokenCount: 258 },
      ],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 50 }],
    });
    const state = appStore.getState();
    expect(state.cost.tokens.textIn).toBe(18);
    // The 258 IMAGE tokens land in the VIDEO ("visual input") bucket.
    expect(state.cost.tokens.videoIn).toBe(258);
    expect(state.cost.tokens.audioOut).toBe(50);
    // The THB total must reflect the image tokens, not just text+audio. At the
    // default $3/1M video rate the image tokens alone dominate the visual cost.
    expect(state.cost.breakdown.videoInTHB).toBeGreaterThan(0);
    const textOnlyVisual = state.cost.breakdown.textInTHB;
    expect(state.cost.breakdown.videoInTHB).toBeGreaterThan(textOnlyVisual);
    expect(state.cost.breakdown.thbTotal).toBeGreaterThan(
      state.cost.breakdown.textInTHB + state.cost.breakdown.audioOutTHB,
    );
  });
});

// ---------------------------------------------------------------------------
// Session history: 3-day auto-expiry (pruneHistory + loadHistory), store.ts
// ---------------------------------------------------------------------------

function makeSession(tsMs: number, userName = 'Nok'): StoredSession {
  return {
    id: crypto.randomUUID(),
    tsMs,
    userName,
    durationMs: 60_000,
    shotCount: 4,
    avgScore: 75,
    goodFormPct: 50,
    bestPeakWristSpeed: 3.1,
    totalCostTHB: 0.5,
    focusShot: 'forehand',
    improvements: [],
  };
}

describe('pruneHistory (pure 3-day expiry)', () => {
  it('keeps sessions within HISTORY_TTL_MS and drops older ones', () => {
    const now = Date.now();
    const recent = makeSession(now - 1000, 'recent');
    const old = makeSession(now - (4 * 24 * 60 * 60 * 1000), 'old');
    expect(pruneHistory([recent, old], now)).toEqual([recent]);
  });

  it('keeps a session exactly at the 3-day boundary (inclusive)', () => {
    const now = Date.now();
    const boundary = makeSession(now - HISTORY_TTL_MS, 'boundary');
    expect(pruneHistory([boundary], now)).toEqual([boundary]);
  });

  it('drops a session 1ms past the 3-day boundary', () => {
    const now = Date.now();
    const justOld = makeSession(now - HISTORY_TTL_MS - 1, 'just-old');
    expect(pruneHistory([justOld], now)).toEqual([]);
  });

  it('is a no-op on an empty list', () => {
    expect(pruneHistory([], Date.now())).toEqual([]);
  });
});

describe('loadHistory (localStorage read + prune)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubLocalStorage(initial: Record<string, string> = {}) {
    const backing: Record<string, string> = { ...initial };
    const setItem = vi.fn((k: string, v: string) => {
      backing[k] = v;
    });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing[k] ?? null,
      setItem,
      removeItem: (k: string) => {
        delete backing[k];
      },
    });
    return { backing, setItem };
  }

  it('prunes expired sessions on read and re-saves the pruned list', () => {
    const now = Date.now();
    const recent = makeSession(now - 1000, 'recent');
    const old = makeSession(now - HISTORY_TTL_MS - 1000, 'old');
    const { backing } = stubLocalStorage({
      'tp.history': JSON.stringify([recent, old]),
    });

    const result = loadHistory(now);
    expect(result).toEqual([recent]);
    expect(JSON.parse(backing['tp.history'])).toEqual([recent]);
  });

  it('does not re-save when nothing was pruned', () => {
    const now = Date.now();
    const recent = makeSession(now - 1000, 'recent');
    const { setItem } = stubLocalStorage({
      'tp.history': JSON.stringify([recent]),
    });

    const result = loadHistory(now);
    expect(result).toEqual([recent]);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('returns [] for absent history', () => {
    stubLocalStorage({});
    expect(loadHistory()).toEqual([]);
  });

  it('returns [] and never throws on corrupt JSON', () => {
    stubLocalStorage({ 'tp.history': 'not-json{{' });
    expect(loadHistory()).toEqual([]);
  });

  it('returns [] when the stored value is not an array', () => {
    stubLocalStorage({ 'tp.history': JSON.stringify({ not: 'an array' }) });
    expect(loadHistory()).toEqual([]);
  });

  it('filters out malformed entries missing required fields', () => {
    const now = Date.now();
    const good = makeSession(now - 1000, 'good');
    const bad = { id: 'bad', tsMs: now }; // missing shotCount
    stubLocalStorage({ 'tp.history': JSON.stringify([good, bad]) });
    expect(loadHistory(now)).toEqual([good]);
  });

  it('returns [] when localStorage itself is unavailable (never throws)', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadHistory()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v1.1 Vertex relay: RAW WIRE names — response side arrives as candidates*.
// The relay bypasses the SDK's candidates→response rename, so parseUsage must
// read both. Payload below is the exact shape captured live in review.
// ---------------------------------------------------------------------------
describe('parseUsage — raw Vertex wire candidates* names (relay path)', () => {
  it('bills audio-out from candidatesTokensDetails', () => {
    const d = parseUsage({
      promptTokenCount: 282,
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 24 },
        { modality: 'IMAGE', tokenCount: 258 },
      ],
      candidatesTokenCount: 29,
      candidatesTokensDetails: [
        { modality: 'TEXT', tokenCount: 4 },
        { modality: 'AUDIO', tokenCount: 25 },
      ],
      totalTokenCount: 311,
    });
    expect(d).not.toBeNull();
    expect(d!.responseTokens.AUDIO).toBe(25);
    expect(d!.responseTokens.TEXT).toBe(4);
    expect(d!.promptTokens.VIDEO).toBe(258); // IMAGE folded into visual bucket
  });

  it('falls back to flat candidatesTokenCount when no details', () => {
    const d = parseUsage({ candidatesTokenCount: 17 });
    expect(d!.responseTokens.TEXT).toBe(17);
  });

  it('never double-counts when SDK names are present too', () => {
    const d = parseUsage({
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 10 }],
      candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 999 }],
    });
    expect(d!.responseTokens.AUDIO).toBe(10); // SDK name wins, candidates ignored
  });
});

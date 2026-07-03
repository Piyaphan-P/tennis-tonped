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

  it('falls back to the flat count when details exist but only have unknown modalities', () => {
    const delta = parseUsage({
      promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 99 }],
      promptTokenCount: 99,
    });
    // IMAGE isn't TEXT/AUDIO/VIDEO, so it's dropped from the folded map; since
    // the fold produced an empty map, the flat promptTokenCount fallback
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

// ============================================================================
// v2.6 — an EMPTY session (0 shots) is still saved to History with score 0 and
// all-0 stats (user request 2026-07-28). Only a never-started session (no
// startedAtMs) is skipped. Guards changed in store.snapshotSessionToHistory +
// store.endSession.
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './store';

// Root vitest runs in bare node (no DOM): minimal in-memory localStorage stub.
if (typeof localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => {
      mem.delete(k);
    },
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
  } as Storage;
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ history: [], shots: [] });
});

/** Put the store into a "live session, no shots" state. */
function startLiveEmptySession(startedAtMs = 1_000_000): void {
  const s = useAppStore.getState();
  useAppStore.setState({
    shots: [],
    session: { ...s.session, status: 'live', startedAtMs, endedAtMs: 0, error: null },
  });
}

describe('empty session persistence (v2.6)', () => {
  it('endSession saves a 0-shot session to history with score 0 + 0 stats', () => {
    startLiveEmptySession();
    useAppStore.getState().endSession();
    const hist = useAppStore.getState().history;
    expect(hist).toHaveLength(1);
    expect(hist[0].shotCount).toBe(0);
    expect(hist[0].avgScore).toBe(0);
    expect(hist[0].goodFormPct).toBe(0);
  });

  it('snapshotSessionToHistory saves a 0-shot in-progress session', () => {
    startLiveEmptySession();
    useAppStore.getState().snapshotSessionToHistory();
    const hist = useAppStore.getState().history;
    expect(hist).toHaveLength(1);
    expect(hist[0].shotCount).toBe(0);
  });

  it('still skips a session that never started (startedAtMs <= 0)', () => {
    const s = useAppStore.getState();
    useAppStore.setState({
      shots: [],
      session: { ...s.session, status: 'live', startedAtMs: 0, endedAtMs: 0, error: null },
    });
    useAppStore.getState().snapshotSessionToHistory();
    useAppStore.getState().endSession();
    expect(useAppStore.getState().history).toHaveLength(0);
  });

  it('the snapshot then the final end UPSERT the same row (no duplicate)', () => {
    startLiveEmptySession();
    useAppStore.getState().snapshotSessionToHistory();
    useAppStore.getState().endSession();
    expect(useAppStore.getState().history).toHaveLength(1);
  });
});

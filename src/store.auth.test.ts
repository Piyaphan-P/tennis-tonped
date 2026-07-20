// ============================================================================
// Auth slice (UAM v1.5) — setAuth behavior, esp. the userName seeding rule
// (revised 2026-07-20 per user): on sign-in, userName defaults to displayName
// (ชื่อเล่น), else the FULL email. Seeds when empty AND re-seeds whenever a
// DIFFERENT account signs in (shared phone must not greet the previous player);
// the SAME account re-signing in never clobbers a hand-edited name.
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './store';

// Root vitest runs in bare node (no DOM): provide a minimal in-memory
// localStorage. The re-seed rule persists the last account under
// 'tp.authEmail', and store.ts's lsGet/lsSet check availability at CALL time,
// so installing the stub here (after the hoisted import) is sufficient.
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

const ADMIN = { email: 'coach@adge.club', role: 'admin' as const, displayName: 'Coach A' };

beforeEach(() => {
  localStorage.removeItem('tp.authEmail');
  useAppStore.setState({ auth: null });
  useAppStore.getState().setUserName('');
});

describe('store auth slice', () => {
  it('starts signed out', () => {
    expect(useAppStore.getState().auth).toBeNull();
  });

  it('stores the identity and seeds an empty userName from displayName', () => {
    useAppStore.getState().setAuth(ADMIN);
    const s = useAppStore.getState();
    expect(s.auth).toEqual(ADMIN);
    expect(s.settings.userName).toBe('Coach A');
  });

  it('falls back to the FULL email when displayName is blank', () => {
    useAppStore.getState().setAuth({ email: 'nid@adge.club', role: 'player', displayName: '  ' });
    expect(useAppStore.getState().settings.userName).toBe('nid@adge.club');
  });

  it('keeps a hand-edited userName when the SAME account signs in again', () => {
    useAppStore.getState().setAuth(ADMIN);
    useAppStore.getState().setUserName('น้องเมย์');
    useAppStore.getState().setAuth(ADMIN);
    expect(useAppStore.getState().settings.userName).toBe('น้องเมย์');
  });

  it('re-seeds userName when a DIFFERENT account signs in', () => {
    useAppStore.getState().setAuth(ADMIN);
    expect(useAppStore.getState().settings.userName).toBe('Coach A');
    useAppStore.getState().setAuth({ email: 'nid@adge.club', role: 'player', displayName: 'Nid' });
    expect(useAppStore.getState().settings.userName).toBe('Nid');
  });

  it('clears the identity on logout without touching userName', () => {
    useAppStore.getState().setAuth(ADMIN);
    useAppStore.getState().setAuth(null);
    const s = useAppStore.getState();
    expect(s.auth).toBeNull();
    expect(s.settings.userName).toBe('Coach A');
  });
});

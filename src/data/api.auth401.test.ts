// ============================================================================
// api.ts — 401 handling on the cloud DATA path (code-review finding #8).
// A 401 (cookie expired/revoked mid-session) on a safeFetch-backed call must
// clear the auth identity (so LoginGate reappears) WITHOUT latching offline,
// while the auth probes (fetchGate) that bypass safeFetch keep their own 401
// as a normal, non-clearing outcome.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, fetchGate, isCloudAvailable } from './api';
import { useAppStore } from '../store';

const USER = { email: 'coach@adge.club', role: 'admin' as const, displayName: 'Coach A' };

function mockFetchStatus(status: number, body: unknown = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  useAppStore.setState({ auth: USER });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api 401 handling', () => {
  it('clears auth on a 401 cloud data call (createSession) without latching offline', async () => {
    mockFetchStatus(401);
    const id = await createSession('Coach A', new Date().toISOString());
    expect(id).toBeNull();
    // Identity dropped → LoginGate reappears.
    expect(useAppStore.getState().auth).toBeNull();
    // 401 is auth, not offline: the cloud must NOT be latched offline.
    expect(isCloudAvailable()).toBe(true);
  });

  it('does NOT clear auth when the gate probe (fetchGate) 401s (normal unauthed)', async () => {
    mockFetchStatus(401);
    const res = await fetchGate();
    expect(res).toEqual({ status: 'unauthed' });
    // fetchGate bypasses safeFetch → auth identity untouched.
    expect(useAppStore.getState().auth).toEqual(USER);
  });
});

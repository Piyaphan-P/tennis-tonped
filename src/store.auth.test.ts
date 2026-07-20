// ============================================================================
// Auth slice (UAM v1.5) — setAuth behavior, esp. the userName seeding rule:
// on sign-in an EMPTY settings.userName is initialized from displayName (or
// the email local-part), but an existing name is never overwritten.
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './store';

const ADMIN = { email: 'coach@adge.club', role: 'admin' as const, displayName: 'Coach A' };

beforeEach(() => {
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

  it('falls back to the email local-part when displayName is blank', () => {
    useAppStore.getState().setAuth({ email: 'nid@adge.club', role: 'player', displayName: '  ' });
    expect(useAppStore.getState().settings.userName).toBe('nid');
  });

  it('never overwrites an existing userName', () => {
    useAppStore.getState().setUserName('น้องเมย์');
    useAppStore.getState().setAuth(ADMIN);
    expect(useAppStore.getState().settings.userName).toBe('น้องเมย์');
  });

  it('clears the identity on logout without touching userName', () => {
    useAppStore.getState().setAuth(ADMIN);
    useAppStore.getState().setAuth(null);
    const s = useAppStore.getState();
    expect(s.auth).toBeNull();
    expect(s.settings.userName).toBe('Coach A');
  });
});

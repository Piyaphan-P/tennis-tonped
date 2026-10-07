// ============================================================================
// v2.1 LINE profile slice — setLineProfile persists to localStorage, seeds the
// coach-greeting userName from displayName (falling back to email), clears on
// null, and never touches the voice/mode/verbosity slices.
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './store';
import type { LineProfile } from './types';

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

const LS_LINE_PROFILE = 'tp.lineProfile';

const PROFILE: LineProfile = {
  lineUserId: 'U4af4980629abc',
  displayName: 'Ton',
  pictureUrl: 'https://profile.line-scdn.net/x',
  email: 'hello@gmail.com',
};

beforeEach(() => {
  localStorage.removeItem(LS_LINE_PROFILE);
  useAppStore.getState().setLineProfile(null);
  useAppStore.getState().setUserName('');
  useAppStore.getState().setVoiceTone('gentleF');
  useAppStore.getState().setCoachMode('encourage');
  useAppStore.getState().setVerbosity('short');
});

describe('setLineProfile', () => {
  it('stores the profile in state and persists JSON to localStorage', () => {
    useAppStore.getState().setLineProfile(PROFILE);
    expect(useAppStore.getState().settings.lineProfile).toEqual(PROFILE);
    expect(JSON.parse(localStorage.getItem(LS_LINE_PROFILE)!)).toEqual(PROFILE);
  });

  it('seeds userName from displayName', () => {
    useAppStore.getState().setLineProfile(PROFILE);
    expect(useAppStore.getState().settings.userName).toBe('Ton');
  });

  it('falls back to email when displayName is blank', () => {
    useAppStore.getState().setLineProfile({ ...PROFILE, displayName: '   ' });
    expect(useAppStore.getState().settings.userName).toBe('hello@gmail.com');
  });

  it('clears the profile and removes the LS key on null', () => {
    useAppStore.getState().setLineProfile(PROFILE);
    useAppStore.getState().setLineProfile(null);
    expect(useAppStore.getState().settings.lineProfile).toBeNull();
    expect(localStorage.getItem(LS_LINE_PROFILE)).toBeNull();
  });

  it('does not disturb the voice/mode/verbosity slices', () => {
    useAppStore.getState().setVoiceTone('firmM');
    useAppStore.getState().setCoachMode('hardcore');
    useAppStore.getState().setVerbosity('long');
    useAppStore.getState().setLineProfile(PROFILE);
    const s = useAppStore.getState().settings;
    expect(s.voiceTone).toBe('firmM');
    expect(s.coachMode).toBe('hardcore');
    expect(s.verbosity).toBe('long');
  });
});

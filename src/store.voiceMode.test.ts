// ============================================================================
// v1.6 coach voice-tone + coach-mode settings slice — defaults, setters, and
// two-directional localStorage persistence (write via setter, read at init).
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import { readEnum, useAppStore } from './store';

// Root vitest runs in bare node (no DOM): provide a minimal in-memory
// localStorage (same stub the auth slice test installs). store.ts's lsGet/lsSet
// check availability at CALL time, so installing it here is sufficient.
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

const LS_VOICE_TONE = 'tp.voiceTone';
const LS_COACH_MODE = 'tp.coachMode';

beforeEach(() => {
  localStorage.removeItem(LS_VOICE_TONE);
  localStorage.removeItem(LS_COACH_MODE);
  // Reset to the documented defaults for each test.
  useAppStore.getState().setVoiceTone('gentleF');
  useAppStore.getState().setCoachMode('encourage');
});

describe('readEnum (read-at-init / legacy-value guard)', () => {
  const TONES = ['gentleF', 'firmF', 'firmM', 'friendlyM'] as const;

  it('missing key → fallback default', () => {
    localStorage.removeItem('tp.voiceTone');
    expect(readEnum('tp.voiceTone', TONES, 'gentleF')).toBe('gentleF');
  });

  it('valid stored value is returned as-is', () => {
    localStorage.setItem('tp.voiceTone', 'firmM');
    expect(readEnum('tp.voiceTone', TONES, 'gentleF')).toBe('firmM');
  });

  it('garbage / legacy value falls back to the default', () => {
    localStorage.setItem('tp.voiceTone', 'bogus-legacy');
    expect(readEnum('tp.voiceTone', TONES, 'gentleF')).toBe('gentleF');
  });
});

describe('store voice-tone / coach-mode slice (v1.6)', () => {
  it('setVoiceTone updates state AND persists to localStorage', () => {
    useAppStore.getState().setVoiceTone('firmM');
    expect(useAppStore.getState().settings.voiceTone).toBe('firmM');
    expect(localStorage.getItem(LS_VOICE_TONE)).toBe('firmM');
  });

  it('setCoachMode updates state AND persists to localStorage', () => {
    useAppStore.getState().setCoachMode('hardcore');
    expect(useAppStore.getState().settings.coachMode).toBe('hardcore');
    expect(localStorage.getItem(LS_COACH_MODE)).toBe('hardcore');
  });

  it('does not disturb other settings (userName, dominantHand)', () => {
    const before = useAppStore.getState().settings;
    useAppStore.getState().setVoiceTone('friendlyM');
    useAppStore.getState().setCoachMode('buddy');
    const after = useAppStore.getState().settings;
    expect(after.userName).toBe(before.userName);
    expect(after.dominantHand).toBe(before.dominantHand);
    expect(after.focusShot).toBe(before.focusShot);
  });
});

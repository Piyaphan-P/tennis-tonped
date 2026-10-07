// ADGE Tennis (SIT) — KIOSK auto-start helpers (v2.4).
// ---------------------------------------------------------------------------
// When the coach app is embedded in a room-control iframe, the room page opens
// it with `?kiosk=1&k=<KIOSK_KEY>&…` params. The app then:
//   1. carries auth as an `x-kiosk-token` HEADER on its own same-origin /api/*
//      fetches (cross-site iframe COOKIES are blocked on iOS — so no cookie),
//   2. auto-configures coach settings + LINE identity from the params,
//   3. jumps straight into the live coaching session.
// These helpers are pure param-parsing + a one-time fetch monkeypatch; the
// bootstrap lives in components/KioskGate.tsx. Everything here is inert unless
// `?kiosk=1` (or a bare `?kiosk`) is present in the URL.
// ---------------------------------------------------------------------------
import type { CoachMode, DominantHand, Verbosity, VoiceTone } from './types';

export interface KioskParams {
  token: string;
  sessionId: string;
  lineUserId: string;
  displayName: string;
  voiceTone: VoiceTone;
  coachMode: CoachMode;
  verbosity: Verbosity;
  dominantHand: DominantHand;
}

// Allowed value sets (mirror types.ts) — a bad/absent param falls back to the
// coach defaults so a malformed room URL can never crash the bootstrap.
const VOICE_TONES: readonly VoiceTone[] = ['gentleF', 'firmF', 'firmM', 'friendlyM'];
const COACH_MODES: readonly CoachMode[] = ['encourage', 'hardcore', 'polite', 'buddy'];
const VERBOSITY_LEVELS: readonly Verbosity[] = ['short', 'medium', 'long'];
const DOMINANT_HANDS: readonly DominantHand[] = ['left', 'right'];

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Parse the kiosk params off the current URL. Kiosk is active when `kiosk=1`
 * (or a bare `kiosk` key) is present; returns null otherwise. Enum params are
 * validated against the allowed sets and fall back to coach defaults
 * (gentleF / encourage / short / right) on a bad or missing value.
 */
export function readKioskParams(): KioskParams | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  // Active when `kiosk=1` or a bare `kiosk` key is present; an explicit
  // `kiosk=0` opts out.
  if (!q.has('kiosk') || q.get('kiosk') === '0') return null;
  return {
    token: q.get('k') ?? '',
    sessionId: q.get('session') ?? '',
    lineUserId: q.get('line') ?? '',
    displayName: q.get('name') ?? '',
    voiceTone: oneOf(q.get('voiceTone'), VOICE_TONES, 'gentleF'),
    coachMode: oneOf(q.get('coachMode'), COACH_MODES, 'encourage'),
    verbosity: oneOf(q.get('verbosity'), VERBOSITY_LEVELS, 'short'),
    dominantHand: oneOf(q.get('hand'), DOMINANT_HANDS, 'right'),
  };
}

// --- Same-origin /api/* fetch patch (carry the kiosk token) -----------------
let kioskFetchInstalled = false;

/** True when a URL string points at this app's own /api/* (same-origin). */
function isApiUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.href);
    return u.origin === window.location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * Monkeypatch window.fetch ONCE so every same-origin /api/* request gains the
 * `x-kiosk-token` header. Handles both a string/URL first arg and a Request
 * object; merges with any caller-supplied headers; leaves non-/api requests
 * untouched. Idempotent — a second call is a no-op.
 */
export function installKioskFetch(token: string): void {
  if (kioskFetchInstalled || !token || typeof window === 'undefined') return;
  kioskFetchInstalled = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url; // Request object
    if (!isApiUrl(target)) return orig(input, init);
    // Merge onto whichever headers source applies (init wins, else Request's).
    const base =
      input instanceof Request && !(init && 'headers' in init) ? input.headers : init?.headers;
    const headers = new Headers(base as HeadersInit | undefined);
    headers.set('x-kiosk-token', token);
    return orig(input, { ...init, headers });
  };
}

/**
 * Remove the sensitive `k` (token) param from the visible URL via
 * history.replaceState so the key isn't shoulder-surfed / left in history. The
 * in-memory token (installKioskFetch) keeps working. Other params are left so a
 * reload still reads kiosk mode.
 */
export function stripKioskTokenFromUrl(): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('k')) return;
    url.searchParams.delete('k');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* history unavailable — non-fatal */
  }
}

// ============================================================================
// ADGE Tennis — cloud sync HTTP client (FROZEN CONTRACT).
//
// Same-origin /api/* calls (dev proxies to :8080 via vite.config). NONE of
// these functions throw: any network error or a 503 flips a module-level
// offline latch for 60s, and every function returns null/false fast while
// latched — so the UI silently falls back to localStorage stats + session-only
// clips and we never spam fetch at a cloud that isn't there.
//
// NOTE (statuses derivation): the frozen uploadShotMeta(sessionId, shot)
// signature carries no AngleStatuses (Shot has none), so — per the contract's
// "derive via evaluateAngleStatuses(contactAngles, hand, 'contact')" — the
// derivation runs HERE when building the POST body, reusing the canonical
// store function + the current dominantHand. This avoids schema drift.
// ============================================================================

import type {
  AdminUserRow,
  AuthUser,
  CloudSessionDetail,
  CloudSessionSummary,
  Shot,
  SessionSummaryJson,
} from '../types';
import { evaluateAngleStatuses, useAppStore } from '../store';

// ---------------------------------------------------------------------------
// Offline latch (60s recheck window)
// ---------------------------------------------------------------------------

const OFFLINE_WINDOW_MS = 60_000;
/** 0 = online; otherwise the Date.now() ms until which we stay latched offline. */
let offlineUntil = 0;

function isOffline(): boolean {
  if (offlineUntil === 0) return false;
  if (Date.now() >= offlineUntil) {
    offlineUntil = 0; // window elapsed — allow one probe
    return false;
  }
  return true;
}

function latchOffline(): void {
  offlineUntil = Date.now() + OFFLINE_WINDOW_MS;
}

function markOnline(): void {
  offlineUntil = 0;
}

/**
 * Auth cookie expired/revoked mid-session (401 on a cloud DATA call). Clear the
 * stored identity so LoginGate reappears. This is an AUTH failure, NOT offline,
 * so we never latch offline here. Scoped to safeFetch (the cloud data path):
 * the auth probes/mutations (fetchGate/login/listUsers/…) use raw fetch and
 * bypass this, so their own expected 401s never recursively clear auth.
 * Guarded against SSR / a missing store (never throws).
 */
function clearAuthOn401(): void {
  try {
    useAppStore.getState().setAuth(null);
  } catch {
    /* no store available (e.g. SSR) — nothing to clear */
  }
}

/**
 * fetch wrapper: returns the Response on 2xx, or null on any failure. A 503
 * (cloud not configured / server DB error) OR a thrown network error latches
 * offline for 60s. A 401 clears the auth identity (LoginGate reappears) but
 * does NOT latch offline. Never throws.
 */
async function safeFetch(input: string, init?: RequestInit): Promise<Response | null> {
  if (isOffline()) return null;
  try {
    const res = await fetch(input, init);
    if (res.status === 503) {
      latchOffline();
      return null;
    }
    if (res.status === 401) {
      // Auth, not offline: drop the identity so re-login is prompted; the
      // offline latch stays untouched so cloud sync resumes after re-login.
      clearAuthOn401();
      return null;
    }
    if (!res.ok) {
      // 4xx/5xx other than 503: don't latch (it's a request-level problem),
      // but treat as failure for this call.
      return null;
    }
    markOnline();
    return res;
  } catch {
    latchOffline();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** True while the cloud is reachable (not currently latched offline). */
export function isCloudAvailable(): boolean {
  return !isOffline();
}

/** POST /api/sessions — returns the new session id, or null when offline. */
export async function createSession(
  userName: string,
  startedAtIso: string,
): Promise<string | null> {
  const res = await safeFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, startedAt: startedAtIso }),
  });
  if (!res) return null;
  try {
    const data = (await res.json()) as { id?: string };
    return typeof data.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}

/**
 * Per-session Gemini usage totals, PATCHed with the session end (frozen
 * contract). thb = costMonitor's real THB total; tokensIn/tokensOut = summed
 * input/output tokens across modalities; detail = per-modality breakdown.
 */
export interface SessionUsage {
  thb: number;
  tokensIn: number;
  tokensOut: number;
  detail?: object;
}

/** PATCH /api/sessions/:id — end + summary (+ optional usage). Returns true on success. */
export async function endSessionCloud(
  id: string,
  endedAtIso: string,
  avgScore: number,
  shotCount: number,
  summary: SessionSummaryJson,
  usage?: SessionUsage,
): Promise<boolean> {
  const res = await safeFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endedAt: endedAtIso,
      avgScore,
      shotCount,
      summary,
      ...(usage ? { usage } : {}),
    }),
  });
  return res !== null;
}

/** POST /api/sessions/:id/shots — metadata only. Returns cloud shot id. */
export async function uploadShotMeta(
  sessionId: string,
  shot: Shot,
): Promise<string | null> {
  // Derive contact-time statuses here (see file header note).
  const hand = useAppStore.getState().settings.dominantHand;
  const statuses = evaluateAngleStatuses(shot.contactAngles, hand, 'contact');
  const body = {
    idx: shot.index,
    type: shot.type,
    score: shot.score,
    angles: shot.contactAngles,
    statuses,
    issues: shot.issues,
    peakWristSpeed: shot.peakWristSpeed,
    // Purely additive optional field. NOTE: BOTH server backends pick explicit
    // fields and currently DROP this (dbFirestore.mjs too — it is NOT stored
    // as-is), so there is no cloud round-trip; History shows speed via the
    // same-session localMatch fallback only. Kept on the wire so a future
    // server mapper change is frontend-free.
    speedKmh: shot.speedKmh,
  };
  const res = await safeFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/shots`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res) return null;
  try {
    const data = (await res.json()) as { id?: string };
    return typeof data.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}

/** POST /api/shots/:id/clip — raw body. Skips >8MB. Returns true on success. */
export async function uploadShotClip(
  cloudShotId: string,
  blob: Blob,
  mimeType: string,
): Promise<boolean> {
  if (blob.size > 8_000_000) return false;
  const res = await safeFetch(`/api/shots/${encodeURIComponent(cloudShotId)}/clip`, {
    method: 'POST',
    headers: { 'Content-Type': mimeType || 'application/octet-stream' },
    body: blob,
  });
  return res !== null;
}

/**
 * POST /api/shots/:id/audio — raw WAV body (the coach's spoken critique). Skips
 * >8MB. Returns true on success. Mirrors uploadShotClip.
 */
export async function uploadShotAudio(
  cloudShotId: string,
  blob: Blob,
): Promise<boolean> {
  if (blob.size > 8_000_000) return false;
  const res = await safeFetch(`/api/shots/${encodeURIComponent(cloudShotId)}/audio`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/wav' },
    body: blob,
  });
  return res !== null;
}

/** Same-origin URL that streams a shot's coach-audio WAV through the server. */
export function audioUrl(cloudShotId: string): string {
  return `/api/audio/${encodeURIComponent(cloudShotId)}`;
}

/** GET /api/history?days=3 — session list, or null when offline. */
export async function fetchHistory(days = 3): Promise<CloudSessionSummary[] | null> {
  const res = await safeFetch(`/api/history?days=${encodeURIComponent(String(days))}`);
  if (!res) return null;
  try {
    return (await res.json()) as CloudSessionSummary[];
  } catch {
    return null;
  }
}

/** GET /api/sessions/:id — full detail incl shots, or null when offline. */
export async function fetchSessionDetail(
  id: string,
): Promise<CloudSessionDetail | null> {
  const res = await safeFetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res) return null;
  try {
    return (await res.json()) as CloudSessionDetail;
  } catch {
    return null;
  }
}

/** Same-origin URL that streams a shot's clip through the server. */
export function clipUrl(cloudShotId: string): string {
  return `/api/clips/${encodeURIComponent(cloudShotId)}`;
}

/**
 * DELETE /api/sessions/:id — drops the DB rows only; GCS clip objects are left
 * for the bucket's 3-day lifecycle rule to reap. Returns true on success.
 */
export async function deleteSessionCloud(id: string): Promise<boolean> {
  const res = await safeFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return res !== null;
}

// ---------------------------------------------------------------------------
// Auth + user management (UAM v1.5). These calls deliberately BYPASS the
// offline latch above: a login attempt / admin action must never be silently
// swallowed because clip sync latched offline, and an auth failure (401/429/
// 503 on /api/login) must never latch the CLOUD offline — the two failure
// domains are unrelated. All functions still never throw.
// ---------------------------------------------------------------------------

/** Known server error codes plus client-side buckets. */
export type AuthErrorCode =
  | 'bad_credentials'
  | 'too_many_attempts'
  | 'user_exists'
  | 'invalid_input'
  | 'forbidden'
  | 'server'
  | 'network';

export interface AuthFailure {
  ok: false;
  error: AuthErrorCode;
  /** Server-provided human message (fallback copy when we lack an i18n key). */
  message?: string;
}

export type LoginResult = { ok: true; user: AuthUser } | AuthFailure;
export type UserMutationResult = { ok: true } | AuthFailure;

export type GateResult =
  | { status: 'authed'; user: AuthUser }
  | { status: 'unauthed' }
  /** 404 / network / non-contract response — no gate (dev). Caller fails OPEN. */
  | { status: 'no-gate' };

const KNOWN_CODES: readonly AuthErrorCode[] = [
  'bad_credentials',
  'too_many_attempts',
  'user_exists',
  'invalid_input',
  'forbidden',
];

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function userOf(body: Record<string, unknown>): AuthUser | null {
  if (typeof body.email !== 'string' || body.email === '') return null;
  return {
    email: body.email,
    role: body.role === 'admin' ? 'admin' : 'player',
    displayName: typeof body.displayName === 'string' ? body.displayName : '',
  };
}

async function failureOf(res: Response): Promise<AuthFailure> {
  if (res.status === 403) return { ok: false, error: 'forbidden' };
  const body = await jsonOf(res);
  const code = KNOWN_CODES.find((c) => c === body.error);
  return {
    ok: false,
    error: code ?? 'server',
    message: typeof body.message === 'string' ? body.message : undefined,
  };
}

/** POST /api/login — sets the httpOnly cookie on success. */
export async function login(email: string, password: string): Promise<LoginResult> {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      const user = userOf(await jsonOf(res));
      if (user) return { ok: true, user };
      return { ok: false, error: 'server' };
    }
    return failureOf(res);
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** POST /api/logout — clears the cookie. Returns true on success. */
export async function logout(): Promise<boolean> {
  try {
    const res = await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** GET /api/gate — who am I? (LoginGate boot probe.) */
export async function fetchGate(): Promise<GateResult> {
  try {
    const res = await fetch('/api/gate', { credentials: 'same-origin' });
    if (res.status === 401) return { status: 'unauthed' };
    if (!res.ok) return { status: 'no-gate' };
    const user = userOf(await jsonOf(res));
    // 200 without the contract body = pre-UAM server / dev stub → fail open.
    return user ? { status: 'authed', user } : { status: 'no-gate' };
  } catch {
    return { status: 'no-gate' };
  }
}

/** GET /api/users — all accounts (admin only). Null on any failure. */
export async function listUsers(): Promise<AdminUserRow[] | null> {
  try {
    const res = await fetch('/api/users', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as AdminUserRow[]) : null;
  } catch {
    return null;
  }
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName?: string;
}

/** POST /api/users — add a player (admin only). */
export async function createUser(input: CreateUserInput): Promise<UserMutationResult> {
  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
    });
    return res.ok ? { ok: true } : failureOf(res);
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** PATCH /api/users/:email — reset password / rename / enable-disable. */
export async function patchUser(
  email: string,
  patch: { password?: string; displayName?: string; disabled?: boolean },
): Promise<UserMutationResult> {
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(patch),
    });
    return res.ok ? { ok: true } : failureOf(res);
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** DELETE /api/users/:email — remove a player (cannot delete self). */
export async function deleteUser(email: string): Promise<UserMutationResult> {
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(email)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    return res.ok ? { ok: true } : failureOf(res);
  } catch {
    return { ok: false, error: 'network' };
  }
}

// ---------------------------------------------------------------------------
// Usage / cost reporting (admin only). Frozen contract:
//   GET /api/usage → { users: [{ email, userName, thb, tokensIn, tokensOut,
//   sessions }], total: { thb, tokensIn, tokensOut, sessions } }
// Bypasses the offline latch like the other admin calls. Never throws.
// ---------------------------------------------------------------------------

export interface UsageUserRow {
  email: string;
  userName: string;
  thb: number;
  tokensIn: number;
  tokensOut: number;
  sessions: number;
}

export interface UsageTotals {
  thb: number;
  tokensIn: number;
  tokensOut: number;
  sessions: number;
}

export interface UsageReport {
  users: UsageUserRow[];
  total: UsageTotals;
}

/** GET /api/usage — per-user + total Gemini spend (admin only). Null on any failure. */
export async function fetchUsage(): Promise<UsageReport | null> {
  try {
    const res = await fetch('/api/usage', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object') return null;
    const r = body as UsageReport;
    if (!Array.isArray(r.users) || !r.total || typeof r.total !== 'object') return null;
    return r;
  } catch {
    return null;
  }
}

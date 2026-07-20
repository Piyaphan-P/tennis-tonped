// ============================================================================
// ADGE Tennis — PURE auth primitives (UAM v1.5).
//
// ONLY node:crypto here — no express, no firestore — so the repo-root vitest
// (which does not install server deps) can unit-test this file cleanly, same
// rule as lib.mjs. Password hashing (scrypt), the per-user signed cookie
// (sign/verify/parse), email validation and cookie-header parsing live here;
// everything that touches express or the users collection lives in authGate.mjs.
// ============================================================================

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

export const COOKIE_NAME = 'adge_auth';
export const COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60; // 90 days — log in once per device.

const SCRYPT_KEYLEN = 64; // bytes
const SALT_BYTES = 16;

/** Frozen-contract email shape (lowercased before storage/lookup by callers). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email);
}

// ---------------------------------------------------------------------------
// Passwords — scrypt with a per-user random salt. NEVER store plaintext.
// ---------------------------------------------------------------------------

/** Hash a password → { passSalt, passHash } (both hex). */
export function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return { passSalt: salt.toString('hex'), passHash: key.toString('hex') };
}

/** Constant-time verify of a password against stored hex salt+hash. */
export function verifyPassword(password, passSalt, passHash) {
  try {
    const salt = Buffer.from(String(passSalt), 'hex');
    const expected = Buffer.from(String(passHash), 'hex');
    const got = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// --- Async variants (event-loop-friendly) ----------------------------------
// scryptSync blocks the single Node thread for the whole KDF; on the REQUEST
// path (login, create/patch user) use these promisified variants instead so
// concurrent requests are not stalled. Identical params/output to the sync
// pair (keylen 64, same salt handling, timingSafeEqual). The SYNC versions are
// kept for boot-time ensureAdmin (blocking at boot is fine) and unit tests.

/** Async hash → { passSalt, passHash } (both hex). */
export async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(String(password), salt, SCRYPT_KEYLEN);
  return { passSalt: salt.toString('hex'), passHash: key.toString('hex') };
}

/** Async constant-time verify against stored hex salt+hash. */
export async function verifyPasswordAsync(password, passSalt, passHash) {
  try {
    const salt = Buffer.from(String(passSalt), 'hex');
    const expected = Buffer.from(String(passHash), 'hex');
    const got = await scryptAsync(String(password), salt, SCRYPT_KEYLEN);
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signing secret — env AUTH_SECRET, dev fallback with a one-time warning.
// ---------------------------------------------------------------------------

const DEV_SECRET = 'adge-dev-secret';
let warnedDevSecret = false;

/** The HMAC secret. When AUTH_SECRET is unset in PRODUCTION we hard-fail (a
 *  public-constant signing key would let anyone forge admin cookies). Outside
 *  production a constant dev secret is used with a one-time warning (never spam
 *  per-request). Set AUTH_SECRET on Cloud Run. */
export function getAuthSecret() {
  const s = process.env.AUTH_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET is required in production');
  }
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn('[auth] AUTH_SECRET not set — using constant dev secret (fine for local dev only)');
  }
  return DEV_SECRET;
}

// ---------------------------------------------------------------------------
// Cookie — stateless per-user token: `v1.<base64url(email|role|exp)>.<hmac>`.
// Survives Cloud Run instance churn like the old shared-HMAC cookie. The role
// inside is a HINT: the authGate /api guard re-checks the store per request
// (cached ≤60s) and the STORED role wins, so a demoted/disabled/deleted user is
// revoked within the TTL rather than living for the full 90-day cookie.
// ---------------------------------------------------------------------------

function hmacHex(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
}

/** Constant-time string compare (avoids trivially timing the HMAC). */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Sign an identity cookie value. `exp` = unix seconds; defaults to
 * now + COOKIE_MAX_AGE_S so login and cookie expiry stay in lockstep.
 */
export function signCookie({ email, role, exp }, secret = getAuthSecret()) {
  const expSec = exp ?? Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_S;
  const payload = Buffer.from(`${email}|${role}|${expSec}`).toString('base64url');
  return `v1.${payload}.${hmacHex(payload, secret)}`;
}

/**
 * Verify a cookie value → { email, role, exp } or null (bad shape, bad
 * signature, or expired). `nowSec` is injectable for tests.
 */
export function verifyCookie(value, secret = getAuthSecret(), nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts;
  if (!safeEqual(sig, hmacHex(payload, secret))) return null;
  let decoded;
  try {
    decoded = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // email|role|exp — split from the END so an email containing '|' (regex
  // permits it) can never smuggle a role.
  const i2 = decoded.lastIndexOf('|');
  const i1 = decoded.lastIndexOf('|', i2 - 1);
  if (i1 <= 0 || i2 <= i1) return null;
  const email = decoded.slice(0, i1);
  const role = decoded.slice(i1 + 1, i2);
  const exp = Number(decoded.slice(i2 + 1));
  if (!email || (role !== 'admin' && role !== 'player')) return null;
  if (!Number.isFinite(exp) || exp <= nowSec) return null;
  return { email, role, exp };
}

// ---------------------------------------------------------------------------
// Per-request store re-check (UAM revocation) — PURE decision function.
// The cookie is stateless and lives 90 days, so disable/delete/demote of a
// user would otherwise stay effective until expiry. The /api guard consults
// the store (cached ≤60s) and feeds the outcome here. Best-effort: a transient
// store error (lookupFailed) falls back to TRUSTING the cookie — a Firestore
// blip must never lock every user out.
// ---------------------------------------------------------------------------

/**
 * Decide whether a request with a valid cookie `identity` ({email, role}) may
 * proceed, given the STORED `user` (or null when deleted) and whether the
 * lookup failed.
 *
 * Returns { allow: true, role, displayName } — role/displayName sourced from
 * the stored user when available so a stale-but-valid cookie can never act
 * above its current role — or { allow: false } (deleted / disabled / role
 * mismatch). On lookupFailed we trust the cookie (allow, role from cookie).
 */
export function evaluateGuard({ identity, user, lookupFailed }) {
  if (lookupFailed) {
    // Transient store error — trust the cookie (do not lock everyone out).
    return { allow: true, role: identity.role, displayName: identity.email };
  }
  if (!user) return { allow: false }; // deleted
  if (user.disabled) return { allow: false }; // disabled
  if (user.role !== identity.role) return { allow: false }; // demotion/escalation
  return {
    allow: true,
    role: user.role, // authoritative — never above the current stored role
    displayName: user.displayName || identity.email,
  };
}

/**
 * Resolve the client IP for rate-limiting from an X-Forwarded-For header.
 * Cloud Run APPENDS the real client IP as the RIGHTMOST entry; the leftmost
 * entries are client-supplied and spoofable, so we take the LAST hop. Falls
 * back to the socket peer when the header is absent, then '?' as a last resort.
 */
export function clientIpFromForwarded(xff, socketRemote) {
  const fromHeader = typeof xff === 'string' ? xff.split(',').pop()?.trim() : '';
  return fromHeader || socketRemote || '?';
}

/** Parse a Cookie request header → { name: value }. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

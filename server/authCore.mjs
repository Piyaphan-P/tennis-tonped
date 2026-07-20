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

// ---------------------------------------------------------------------------
// Signing secret — env AUTH_SECRET, dev fallback with a one-time warning.
// ---------------------------------------------------------------------------

const DEV_SECRET = 'adge-dev-secret';
let warnedDevSecret = false;

/** The HMAC secret. When AUTH_SECRET is unset, a constant dev secret is used
 *  and we warn ONCE (never spam per-request). Set AUTH_SECRET on Cloud Run. */
export function getAuthSecret() {
  const s = process.env.AUTH_SECRET;
  if (s) return s;
  if (!warnedDevSecret) {
    warnedDevSecret = true;
    console.warn('[auth] AUTH_SECRET not set — using constant dev secret (fine for local dev only)');
  }
  return DEV_SECRET;
}

// ---------------------------------------------------------------------------
// Cookie — stateless per-user token: `v1.<base64url(email|role|exp)>.<hmac>`.
// Survives Cloud Run instance churn like the old shared-HMAC cookie; the role
// inside is TRUSTED per request (no DB read) — disabling/deleting a user takes
// effect at the next /api/gate probe (app load), which does check the store.
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

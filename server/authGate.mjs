// ADGE Tennis (SIT) — per-user auth gate in front of the app's APIs (UAM v1.5).
// -----------------------------------------------------------------------------
// Email is the primary identity. POST /api/login checks the users collection
// (backend.getUser — scrypt hash verify) and sets a signed httpOnly cookie
// carrying `email|role|exp` (see authCore.mjs). Every other /api/* route (and
// the /api/live WS upgrade in liveRelay.mjs) requires that cookie; the guard
// attaches req.user = { email, role, displayName } for the ownership checks in
// routes.mjs. Static assets stay public — the frontend shows login on 401.
//
// The /api guard now re-checks the store per request (cached ≤60s): a
// disabled/deleted/demoted user is revoked within the TTL, not only at the next
// /api/gate probe. The cookie's role is superseded by the STORED role when the
// lookup succeeds; a transient store error falls back to trusting the cookie
// (best-effort — never locks everyone out). The WS /api/live upgrade stays
// cookie-only for now (see isGateAuthorized). The old shared GATE_USER/GATE_PASS
// login is retired — users collection only.
// -----------------------------------------------------------------------------
import express from 'express';
import { backend } from './store.mjs';
import {
  COOKIE_NAME,
  COOKIE_MAX_AGE_S,
  isValidEmail,
  verifyPasswordAsync,
  signCookie,
  verifyCookie,
  parseCookies,
  evaluateGuard,
  clientIpFromForwarded,
} from './authCore.mjs';

// Paths that must stay reachable without the cookie.
const OPEN_PATHS = new Set(['/api/login', '/api/logout', '/healthz']);

// --- Per-user store cache (UAM revocation) ----------------------------------
// The cookie is stateless + 90-day, so a disabled/deleted/demoted user would
// stay effective until expiry. The /api guard consults the store per request,
// cached here per-email for a short TTL (one backend.getUser per ≤60s per
// active user — acceptable). Best-effort: a getUser THROW is cached as a
// failed lookup so the guard trusts the cookie AND we don't re-hit a flapping
// store on every request. Resolved entries hold the user (or null = deleted).
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map(); // email → { at, user, failed }

/**
 * Best-effort store read for a cookie's email, cached ≤60s. Returns
 * { user } (user may be null = definitively deleted) or { failed: true } on a
 * transient store error (caller then trusts the cookie). Never throws.
 */
async function lookupUserCached(email) {
  const now = Date.now();
  const hit = userCache.get(email);
  if (hit && now - hit.at < USER_CACHE_TTL_MS) {
    return hit.failed ? { failed: true } : { user: hit.user };
  }
  try {
    const user = await backend.getUser(email);
    userCache.set(email, { at: now, user: user ?? null, failed: false });
    return { user: user ?? null };
  } catch (err) {
    // Mirror /api/gate: a transient store error must not lock users out.
    console.error('[auth] guard lookup (non-fatal):', err?.message || err);
    userCache.set(email, { at: now, user: null, failed: true });
    return { failed: true };
  }
}

// --- Brute-force guard: in-memory, per (ip+email) — 10 failures / 60s. ------
// Good enough for SIT (single instance, tiny user base); resets on restart.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // key → { count, windowStart }

function limiterKey(req, email) {
  // Cloud Run APPENDS the real client IP as the RIGHTMOST x-forwarded-for
  // entry; the leftmost entries are client-supplied and trivially spoofable
  // (an attacker could rotate them to dodge the per-IP limit). See
  // clientIpFromForwarded — take the last hop, socket peer as fallback.
  const ip = clientIpFromForwarded(req.headers['x-forwarded-for'], req.socket?.remoteAddress);
  return `${ip}|${email}`;
}

function isRateLimited(key) {
  const rec = loginFailures.get(key);
  if (!rec) return false;
  if (Date.now() - rec.windowStart > LOGIN_WINDOW_MS) {
    loginFailures.delete(key); // window elapsed — start fresh
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILURES;
}

function recordFailure(key) {
  const now = Date.now();
  const rec = loginFailures.get(key);
  if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, windowStart: now });
  } else {
    rec.count += 1;
  }
  // Opportunistic prune so the map can't grow unbounded across a long uptime.
  if (loginFailures.size > 1000) {
    for (const [k, r] of loginFailures) {
      if (now - r.windowStart > LOGIN_WINDOW_MS) loginFailures.delete(k);
    }
  }
}

// --- Cookie helpers ---------------------------------------------------------

function setAuthCookie(res, value, maxAgeS = COOKIE_MAX_AGE_S) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure}`,
  );
}

/** The verified cookie identity { email, role, exp } or null. Works for plain
 *  HTTP requests AND raw WS upgrade requests (both expose headers.cookie). */
export function identityFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const got = cookies[COOKIE_NAME];
  return got ? verifyCookie(got) : null;
}

/** True when the request carries a valid auth cookie — kept under its original
 *  name so liveRelay.mjs's WS-upgrade guard needs no changes (cookie-only, no DB).
 *
 *  NOTE (follow-up): this WS /api/live upgrade path is COOKIE-ONLY — it does NOT
 *  perform the per-request store re-check that the /api guard now does (disable/
 *  delete/demote is not yet enforced on an already-open or newly-upgrading WS).
 *  The upgrade handler is synchronous; do NOT make it async here to bolt on the
 *  store read — that is a separate change (needs an async upgrade path). */
export function isGateAuthorized(req) {
  return identityFromRequest(req) !== null;
}

const BAD_CREDENTIALS = {
  error: 'bad_credentials',
  message: 'Wrong email or password / อีเมลหรือรหัสผ่านไม่ถูกต้อง',
};

const AUTH_UNAVAILABLE = {
  error: 'auth_unavailable',
  message:
    'Login backend is not available right now — try again shortly. / ' +
    'ระบบล็อกอินยังไม่พร้อมใช้งาน — ลองใหม่อีกครั้ง',
};

/**
 * Mount login/logout/gate + the /api/* guard. Call BEFORE any /api routes are
 * registered so the guard middleware runs first.
 */
export function mountAuthGate(app) {
  // Login: verify against the users collection, set the per-user cookie.
  app.post('/api/login', express.json({ limit: '2kb' }), async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const key = limiterKey(req, email);
    if (isRateLimited(key)) {
      return res.status(429).json({
        error: 'too_many_attempts',
        message: 'Too many login attempts — wait a minute. / พยายามเข้าสู่ระบบบ่อยเกินไป — รอสักครู่แล้วลองใหม่',
      });
    }
    if (!backend.ready()) return res.status(503).json(AUTH_UNAVAILABLE);
    let user;
    try {
      user = await backend.getUser(email);
    } catch (err) {
      console.error('[auth] login lookup:', err?.message || err);
      return res.status(503).json(AUTH_UNAVAILABLE);
    }
    // Same 401 for unknown email / disabled / wrong password — no enumeration.
    // Async scrypt (verifyPasswordAsync) keeps the event loop free under load.
    if (
      !user ||
      user.disabled ||
      !(await verifyPasswordAsync(password, user.passSalt, user.passHash))
    ) {
      recordFailure(key);
      return res.status(401).json(BAD_CREDENTIALS);
    }
    setAuthCookie(res, signCookie({ email: user.email, role: user.role }));
    res.json({ ok: true, email: user.email, role: user.role, displayName: user.displayName ?? '' });
  });

  // Logout: clear the cookie. Open path — works even with an expired cookie.
  app.post('/api/logout', (_req, res) => {
    setAuthCookie(res, '', 0);
    res.json({ ok: true });
  });

  // Session probe so the frontend can decide login-screen vs app on load.
  // Re-checks the store (like the /api guard now does): a user disabled/deleted/
  // demoted after their cookie was minted gets bounced at the next app load. The
  // lookup is best-effort — a transient DB error must not log everyone out.
  app.get('/api/gate', async (req, res) => {
    const id = identityFromRequest(req);
    if (!id) return res.status(401).json({ ok: false });
    // Best-effort store read (shared cache with the /api guard). A DELETED
    // (null) or disabled user → 401; a role change also bounces them so the
    // frontend re-derives the current role. A transient store error trusts the
    // cookie (never log everyone out).
    const { user, failed } = await lookupUserCached(id.email);
    if (!failed) {
      const decision = evaluateGuard({ identity: id, user, lookupFailed: false });
      if (!decision.allow) return res.status(401).json({ ok: false });
      return res.json({
        ok: true,
        email: id.email,
        role: decision.role,
        displayName: user?.displayName ?? '',
      });
    }
    res.json({ ok: true, email: id.email, role: id.role, displayName: '' });
  });

  // Guard every other /api/* route; attach the identity for ownership checks.
  // ASYNC: per request it consults the store (cached ≤60s) so a disabled/
  // deleted/demoted user is revoked without waiting for the 90-day cookie to
  // expire. Best-effort — a transient store error falls back to trusting the
  // cookie (see lookupUserCached + evaluateGuard); it never locks users out.
  const UNAUTHORIZED = {
    error: 'unauthorized',
    message: 'Login required / กรุณาเข้าสู่ระบบก่อนใช้งาน',
  };
  app.use('/api', async (req, res, next) => {
    if (OPEN_PATHS.has(`/api${req.path}`) || OPEN_PATHS.has(req.path)) return next();
    if (req.path === '/login' || req.path === '/logout' || req.path === '/gate') return next();
    const id = identityFromRequest(req);
    if (!id) return res.status(401).json(UNAUTHORIZED);
    try {
      const { user, failed } = await lookupUserCached(id.email);
      const decision = evaluateGuard({ identity: id, user, lookupFailed: failed });
      if (!decision.allow) return res.status(401).json(UNAUTHORIZED);
      // role from the STORE when available so a stale cookie can't act above
      // its current role; displayName is not required per request (email stands
      // in) but we use the stored one when the lookup succeeded.
      req.user = { email: id.email, role: decision.role, displayName: decision.displayName };
      next();
    } catch (err) {
      // Defensive: evaluateGuard/lookup should never throw, but if anything
      // does, do not 500 the whole API — trust the cookie identity.
      console.error('[auth] guard (non-fatal):', err?.message || err);
      req.user = { email: id.email, role: id.role, displayName: id.email };
      next();
    }
  });
}

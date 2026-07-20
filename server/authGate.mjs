// ADGE Tennis (SIT) — per-user auth gate in front of the app's APIs (UAM v1.5).
// -----------------------------------------------------------------------------
// Email is the primary identity. POST /api/login checks the users collection
// (backend.getUser — scrypt hash verify) and sets a signed httpOnly cookie
// carrying `email|role|exp` (see authCore.mjs). Every other /api/* route (and
// the /api/live WS upgrade in liveRelay.mjs) requires that cookie; the guard
// attaches req.user = { email, role, displayName } for the ownership checks in
// routes.mjs. Static assets stay public — the frontend shows login on 401.
//
// Role inside the cookie is TRUSTED per request (no DB read). Disable/delete
// takes effect at the next /api/gate probe, which DOES consult the store.
// The old shared GATE_USER/GATE_PASS login is retired — users collection only.
// -----------------------------------------------------------------------------
import express from 'express';
import { backend } from './store.mjs';
import {
  COOKIE_NAME,
  COOKIE_MAX_AGE_S,
  isValidEmail,
  verifyPassword,
  signCookie,
  verifyCookie,
  parseCookies,
} from './authCore.mjs';

// Paths that must stay reachable without the cookie.
const OPEN_PATHS = new Set(['/api/login', '/api/logout', '/healthz']);

// --- Brute-force guard: in-memory, per (ip+email) — 10 failures / 60s. ------
// Good enough for SIT (single instance, tiny user base); resets on restart.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map(); // key → { count, windowStart }

function limiterKey(req, email) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '?';
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
 *  name so liveRelay.mjs's WS-upgrade guard needs no changes (cookie-only, no DB). */
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
    if (!user || user.disabled || !verifyPassword(password, user.passSalt, user.passHash)) {
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
  // This is the ONE place that re-checks the store: a user disabled/deleted
  // after their cookie was minted gets bounced at the next app load. The
  // lookup is best-effort — a transient DB error must not log everyone out.
  app.get('/api/gate', async (req, res) => {
    const id = identityFromRequest(req);
    if (!id) return res.status(401).json({ ok: false });
    let displayName = '';
    try {
      const user = await backend.getUser(id.email);
      if (user) {
        if (user.disabled) return res.status(401).json({ ok: false });
        displayName = user.displayName ?? '';
      }
    } catch (err) {
      console.error('[auth] gate lookup (non-fatal):', err?.message || err);
    }
    res.json({ ok: true, email: id.email, role: id.role, displayName });
  });

  // Guard every other /api/* route; attach the identity for ownership checks.
  app.use('/api', (req, res, next) => {
    if (OPEN_PATHS.has(`/api${req.path}`) || OPEN_PATHS.has(req.path)) return next();
    if (req.path === '/login' || req.path === '/logout' || req.path === '/gate') return next();
    const id = identityFromRequest(req);
    if (!id) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Login required / กรุณาเข้าสู่ระบบก่อนใช้งาน',
      });
    }
    // displayName is not in the cookie (no DB read per request) — email stands in.
    req.user = { email: id.email, role: id.role, displayName: id.email };
    next();
  });
}

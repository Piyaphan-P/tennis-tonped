// ADGE Tennis (SIT) — simple credential gate in front of the app's APIs.
// -----------------------------------------------------------------------------
// One shared login (default admin/adge, override via GATE_USER/GATE_PASS env)
// checked by POST /api/login, which sets a signed httpOnly cookie. Every other
// /api/* route (and the /api/live WS upgrade) requires that cookie. Static
// assets stay public — the frontend shows its login screen on 401.
//
// The cookie value is a deterministic HMAC of the credentials, so it stays
// valid across Cloud Run instances/restarts and rotates itself whenever the
// password changes. No session store needed.
// -----------------------------------------------------------------------------
import crypto from 'node:crypto';
import express from 'express';

const GATE_USER = process.env.GATE_USER || 'admin';
const GATE_PASS = process.env.GATE_PASS || 'adge';
const COOKIE_NAME = 'adge_gate';
const COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60; // 90 days — log in once per device.

// Paths that must stay reachable without the cookie.
const OPEN_PATHS = new Set(['/api/login', '/healthz']);

function expectedCookieValue() {
  return crypto
    .createHmac('sha256', `${GATE_USER}:${GATE_PASS}`)
    .update('adge-gate-v1')
    .digest('hex');
}

/** Constant-time string compare (avoids trivially timing the HMAC/creds). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** True when the request carries a valid gate cookie. Works for plain HTTP
 *  requests AND raw WS upgrade requests (both expose headers.cookie). */
export function isGateAuthorized(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const got = cookies[COOKIE_NAME];
  return Boolean(got) && safeEqual(got, expectedCookieValue());
}

/**
 * Mount the login endpoint + the /api/* guard. Call BEFORE any /api routes are
 * registered so the guard middleware runs first.
 */
export function mountAuthGate(app) {
  // Login: verify shared credentials, set the signed cookie.
  app.post('/api/login', express.json({ limit: '2kb' }), (req, res) => {
    const { user, pass } = req.body ?? {};
    if (!safeEqual(user ?? '', GATE_USER) || !safeEqual(pass ?? '', GATE_PASS)) {
      return res.status(401).json({
        error: 'bad_credentials',
        message: 'Wrong username or password / ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
      });
    }
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.set(
      'Set-Cookie',
      `${COOKIE_NAME}=${expectedCookieValue()}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`,
    );
    res.json({ ok: true });
  });

  // Session probe so the frontend can decide login-screen vs app on load.
  app.get('/api/gate', (req, res) => {
    if (!isGateAuthorized(req)) return res.status(401).json({ ok: false });
    res.json({ ok: true });
  });

  // Guard every other /api/* route.
  app.use('/api', (req, res, next) => {
    if (OPEN_PATHS.has(`/api${req.path}`) || OPEN_PATHS.has(req.path)) return next();
    if (req.path === '/login' || req.path === '/gate') return next();
    if (!isGateAuthorized(req)) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Login required / กรุณาเข้าสู่ระบบก่อนใช้งาน',
      });
    }
    next();
  });
}

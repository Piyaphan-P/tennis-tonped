// ============================================================================
// ADGE Tennis — cloud persistence routes (metadata backend + GCS).
//
// mountCloudRoutes(app) wires POST/PATCH/GET/DELETE for sessions, shots, clips
// and history. Body parsers are scoped PER ROUTE (never global) so the raw
// video body on the clip route is not mangled by express.json (risk #5).
//
// Metadata access goes through `backend` (store.mjs → Postgres or Firestore per
// DB_BACKEND); this file holds NO SQL/Firestore code — only validation, GCS
// wiring, status codes and JSON shapes. Every handler first checks
// backend.ready() (and gcsReady() for clip routes); if the cloud is not
// configured it returns the SAME bilingual 503 as /api/token (unavailableBody).
// All handlers try/catch → 503/500 JSON — never crash.
// ============================================================================

import express from 'express';
import { backend } from './store.mjs';
import { gcsReady, saveClip, streamClip } from './gcs.mjs';
import {
  clipObjectPath,
  audioObjectPath,
  validateShotMeta,
  unavailableBody,
} from './lib.mjs';
import { hashPassword, isValidEmail } from './authCore.mjs';

const CLIP_MAX_BYTES = 8 * 1024 * 1024; // ~8MB cap (413 beyond)

// --- UAM v1.5 authorization helpers ----------------------------------------
// req.user = { email, role } is attached by the auth gate before these routes
// run. Ownership rule: admin sees everything; a player only their own
// sessions. Legacy sessions without ownerEmail are admin-visible ONLY. A
// denied session read returns the SAME 404 as a missing one — never leak that
// the id exists.

const FORBIDDEN_BODY = {
  error: 'forbidden',
  message: 'Admin only / สำหรับผู้ดูแลระบบเท่านั้น',
};

/** True when `user` may touch a session owned by `ownerEmail` (null = legacy). */
function canAccess(user, ownerEmail) {
  if (user?.role === 'admin') return true;
  return ownerEmail != null && ownerEmail === user?.email;
}

/** 403 unless the caller is an admin. */
function requireAdmin(req, res) {
  if (req.user?.role === 'admin') return true;
  res.status(403).json(FORBIDDEN_BODY);
  return false;
}

/** The shared don't-leak-existence 404 for denied/missing sessions. */
function sessionNotFound(res) {
  res.status(404).json({ error: 'session_not_found' });
}

/**
 * Resolve + authorize a session by id. Returns true when the caller may
 * proceed; otherwise responds 404 (missing OR foreign — identical on purpose).
 */
async function authorizeSession(req, res, sessionId) {
  const owner = await backend.getSessionOwner(sessionId);
  if (!owner || !canAccess(req.user, owner.ownerEmail)) {
    sessionNotFound(res);
    return false;
  }
  return true;
}

/**
 * Resolve + authorize a shot by bare id (clip/audio routes carry no
 * sessionId). Returns { sessionId } when allowed; null after responding 404.
 */
async function authorizeShot(req, res, shotId) {
  const owner = await backend.getShotOwner(shotId);
  if (!owner) {
    res.status(404).json({ error: 'shot_not_found' });
    return null;
  }
  if (!canAccess(req.user, owner.ownerEmail)) {
    sessionNotFound(res);
    return null;
  }
  return { sessionId: owner.sessionId };
}

export function mountCloudRoutes(app) {
  const json = express.json({ limit: '256kb' });
  const rawVideo = express.raw({
    type: ['video/*', 'application/octet-stream'],
    limit: '8mb',
  });
  const rawAudio = express.raw({
    type: ['audio/*'],
    limit: '8mb',
  });

  // Reject early with the shared bilingual 503 when the DB is not configured.
  const requireDb = (res) => {
    if (backend.ready()) return true;
    res.status(503).json(unavailableBody('cloud'));
    return false;
  };
  const requireGcs = (res) => {
    if (gcsReady()) return true;
    res.status(503).json(unavailableBody('clips'));
    return false;
  };

  // --- POST /api/sessions — create, returns { id } ------------------------
  app.post('/api/sessions', json, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const userName = typeof req.body?.userName === 'string' ? req.body.userName : '';
      const startedAt = req.body?.startedAt ? new Date(req.body.startedAt) : new Date();
      // Owner is stamped from the auth cookie — any client-sent value ignored.
      const ownerEmail = req.user?.email ?? null;
      const { id } = await backend.createSession({ userName, startedAt, ownerEmail });
      res.json({ id });
    } catch (err) {
      console.error('[routes] create session:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- PATCH /api/sessions/:id — end + summary (204) ----------------------
  app.patch('/api/sessions/:id', json, async (req, res) => {
    if (!requireDb(res)) return;
    try {
      if (!(await authorizeSession(req, res, req.params.id))) return;
      const { endedAt, avgScore, shotCount, summary } = req.body ?? {};
      // The durable leaderboard upsert (best-effort, shotCount>0 gate) lives
      // inside the backend so both Postgres and Firestore record it identically.
      await backend.patchSession(req.params.id, { endedAt, avgScore, shotCount, summary });
      res.status(204).end();
    } catch (err) {
      console.error('[routes] patch session:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- POST /api/sessions/:id/shots — metadata only, returns { id } -------
  app.post('/api/sessions/:id/shots', json, async (req, res) => {
    if (!requireDb(res)) return;
    const body = req.body ?? {};
    // NEVER persist stills — strip any jpeg fields defensively.
    delete body.jpegBase64;
    delete body.contactFrameJpegBase64;
    delete body.captures;
    const { ok, errors } = validateShotMeta(body);
    if (!ok) {
      return res.status(400).json({ error: 'invalid_shot_meta', errors });
    }
    try {
      if (!(await authorizeSession(req, res, req.params.id))) return;
      const { id } = await backend.createShot(req.params.id, body);
      res.json({ id });
    } catch (err) {
      console.error('[routes] create shot:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- POST /api/shots/:id/clip — raw video body → GCS (204) --------------
  app.post('/api/shots/:id/clip', rawVideo, async (req, res) => {
    if (!requireDb(res)) return;
    if (!requireGcs(res)) return;
    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: 'empty_clip_body' });
      }
      if (buf.length > CLIP_MAX_BYTES) {
        return res.status(413).json({ error: 'clip_too_large' });
      }
      const mime = req.get('content-type') || 'video/webm';
      const owner = await authorizeShot(req, res, req.params.id);
      if (!owner) return;
      const path = clipObjectPath(owner.sessionId, req.params.id, mime);
      await saveClip(path, buf, mime);
      await backend.setShotClip(req.params.id, path, mime);
      res.status(204).end();
    } catch (err) {
      console.error('[routes] upload clip:', err?.message || err);
      res.status(503).json(unavailableBody('clips'));
    }
  });

  // --- POST /api/shots/:id/audio — raw WAV body → GCS (204) ---------------
  // The coach's spoken critique (PCM we already received, WAV-wrapped). Same
  // guards as the clip route. Zero extra Gemini tokens.
  app.post('/api/shots/:id/audio', rawAudio, async (req, res) => {
    if (!requireDb(res)) return;
    if (!requireGcs(res)) return;
    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: 'empty_audio_body' });
      }
      if (buf.length > CLIP_MAX_BYTES) {
        return res.status(413).json({ error: 'audio_too_large' });
      }
      const mime = req.get('content-type') || 'audio/wav';
      const owner = await authorizeShot(req, res, req.params.id);
      if (!owner) return;
      const path = audioObjectPath(owner.sessionId, req.params.id);
      await saveClip(path, buf, mime);
      await backend.setShotAudio(req.params.id, path, mime);
      res.status(204).end();
    } catch (err) {
      console.error('[routes] upload audio:', err?.message || err);
      res.status(503).json(unavailableBody('clips'));
    }
  });

  // --- GET /api/history?days=3 — session list -----------------------------
  app.get('/api/history', async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const days = Math.min(3, Math.max(1, Number(req.query.days) || 3));
      // Player → own sessions only. Admin → everything, optional ?email= filter.
      let rows;
      if (req.user?.role === 'admin') {
        const filter = String(req.query.email ?? '').trim().toLowerCase();
        rows = filter
          ? await backend.listHistory(days, { ownerEmail: filter })
          : await backend.listHistory(days);
      } else {
        rows = await backend.listHistory(days, { ownerEmail: req.user?.email });
      }
      res.json(rows);
    } catch (err) {
      console.error('[routes] history:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- GET /api/sessions/:id — detail incl shots --------------------------
  app.get('/api/sessions/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const detail = await backend.getSessionDetail(req.params.id);
      // Missing and foreign look IDENTICAL (don't leak existence).
      if (!detail || !canAccess(req.user, detail.ownerEmail)) {
        return sessionNotFound(res);
      }
      res.json(detail);
    } catch (err) {
      console.error('[routes] session detail:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- GET /api/clips/:shotId — proxy-stream the GCS object ---------------
  app.get('/api/clips/:shotId', async (req, res) => {
    if (!requireDb(res)) return;
    if (!requireGcs(res)) return;
    try {
      if (!(await authorizeShot(req, res, req.params.shotId))) return;
      const ref = await backend.getShotClipRef(req.params.shotId);
      if (!ref) {
        return res.status(404).json({ error: 'clip_not_found' });
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      await streamClip(ref.clipPath, ref.clipMime, req, res);
    } catch (err) {
      console.error('[routes] clip stream:', err?.message || err);
      if (!res.headersSent) res.status(503).json(unavailableBody('clips'));
    }
  });

  // --- GET /api/audio/:shotId — proxy-stream the coach WAV (Range/206) ----
  app.get('/api/audio/:shotId', async (req, res) => {
    if (!requireDb(res)) return;
    if (!requireGcs(res)) return;
    try {
      if (!(await authorizeShot(req, res, req.params.shotId))) return;
      const ref = await backend.getShotAudioRef(req.params.shotId);
      if (!ref) {
        return res.status(404).json({ error: 'audio_not_found' });
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      await streamClip(ref.audioPath, ref.audioMime || 'audio/wav', req, res);
    } catch (err) {
      console.error('[routes] audio stream:', err?.message || err);
      if (!res.headersSent) res.status(503).json(unavailableBody('clips'));
    }
  });

  // --- DELETE /api/sessions/:id — cascade delete rows (204) ---------------
  app.delete('/api/sessions/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
      if (!(await authorizeSession(req, res, req.params.id))) return;
      await backend.deleteSession(req.params.id);
      res.status(204).end();
    } catch (err) {
      console.error('[routes] delete session:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // ==========================================================================
  // User management (UAM v1.5) — ADMIN ONLY (403 otherwise). Everything goes
  // through backend.* (Firestore has the real implementation; the Postgres
  // stubs throw → the catch below maps that to the bilingual 503). Password
  // hashing happens HERE via authCore so plaintext never reaches the backend.
  // ==========================================================================

  const INVALID_INPUT = {
    error: 'invalid_input',
    message:
      'Email must be valid and password at least 4 characters. / ' +
      'อีเมลต้องถูกต้องและรหัสผ่านอย่างน้อย 4 ตัวอักษร',
  };

  // --- GET /api/users — list (safe wire shape, no credential fields) -------
  app.get('/api/users', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!requireDb(res)) return;
    try {
      res.json(await backend.listUsers());
    } catch (err) {
      console.error('[routes] list users:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- POST /api/users — create a player (role is ALWAYS 'player') ---------
  app.post('/api/users', json, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!requireDb(res)) return;
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName : '';
    if (!isValidEmail(email) || password.length < 4) {
      return res.status(400).json(INVALID_INPUT);
    }
    try {
      if (await backend.getUser(email)) {
        return res.status(409).json({ error: 'user_exists' });
      }
      const { passSalt, passHash } = hashPassword(password);
      await backend.createUser({ email, passSalt, passHash, displayName, role: 'player' });
      res.status(201).json({ ok: true, email });
    } catch (err) {
      console.error('[routes] create user:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- PATCH /api/users/:email — reset password / rename / disable ---------
  // An admin may PATCH their own password/displayName but can NOT disable
  // themselves (lockout guard).
  app.patch('/api/users/:email', json, async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!requireDb(res)) return;
    const email = String(req.params.email ?? '').trim().toLowerCase();
    const { password, displayName, disabled } = req.body ?? {};
    if (password != null && (typeof password !== 'string' || password.length < 4)) {
      return res.status(400).json(INVALID_INPUT);
    }
    if (disabled === true && email === req.user.email) {
      return res.status(400).json({
        error: 'cannot_disable_self',
        message: 'You cannot disable your own account. / ปิดการใช้งานบัญชีตัวเองไม่ได้',
      });
    }
    try {
      const patch = {};
      if (password != null) Object.assign(patch, hashPassword(password));
      if (typeof displayName === 'string') patch.displayName = displayName;
      if (typeof disabled === 'boolean') patch.disabled = disabled;
      const found = await backend.updateUser(email, patch);
      if (!found) return res.status(404).json({ error: 'user_not_found' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[routes] patch user:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- DELETE /api/users/:email — remove the account ONLY (204) ------------
  // Sessions expire via TTL and leaderboard rows are durable — untouched.
  app.delete('/api/users/:email', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!requireDb(res)) return;
    const email = String(req.params.email ?? '').trim().toLowerCase();
    if (email === req.user.email) {
      return res.status(400).json({
        error: 'cannot_delete_self',
        message: 'You cannot delete your own account. / ลบบัญชีตัวเองไม่ได้',
      });
    }
    try {
      await backend.deleteUser(email);
      res.status(204).end();
    } catch (err) {
      console.error('[routes] delete user:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });
}

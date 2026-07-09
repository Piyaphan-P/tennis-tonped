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

const CLIP_MAX_BYTES = 8 * 1024 * 1024; // ~8MB cap (413 beyond)

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
      const { id } = await backend.createSession({ userName, startedAt });
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
      const sessionId = await backend.getShotSession(req.params.id);
      if (!sessionId) {
        return res.status(404).json({ error: 'shot_not_found' });
      }
      const path = clipObjectPath(sessionId, req.params.id, mime);
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
      const sessionId = await backend.getShotSession(req.params.id);
      if (!sessionId) {
        return res.status(404).json({ error: 'shot_not_found' });
      }
      const path = audioObjectPath(sessionId, req.params.id);
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
      const rows = await backend.listHistory(days);
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
      if (!detail) {
        return res.status(404).json({ error: 'session_not_found' });
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
      await backend.deleteSession(req.params.id);
      res.status(204).end();
    } catch (err) {
      console.error('[routes] delete session:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });
}

// ============================================================================
// ADGE Tennis — cloud persistence routes (Postgres + GCS).
//
// mountCloudRoutes(app) wires POST/PATCH/GET/DELETE for sessions, shots, clips
// and history. Body parsers are scoped PER ROUTE (never global) so the raw
// video body on the clip route is not mangled by express.json (risk #5).
//
// Every handler first checks dbReady() (and gcsReady() for clip routes); if the
// cloud is not configured it returns the SAME bilingual 503 as /api/token
// (unavailableBody). All handlers try/catch → 503/500 JSON — never crash.
// ============================================================================

import express from 'express';
import { randomUUID } from 'node:crypto';
import { query, dbReady } from './db.mjs';
import { gcsReady, saveClip, streamClip } from './gcs.mjs';
import {
  clipObjectPath,
  audioObjectPath,
  sessionRowToJson,
  shotRowToJson,
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
    if (dbReady()) return true;
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
      const id = randomUUID();
      const userName = typeof req.body?.userName === 'string' ? req.body.userName : '';
      const startedAt = req.body?.startedAt ? new Date(req.body.startedAt) : new Date();
      await query(
        `INSERT INTO sessions (id, user_name, started_at) VALUES ($1, $2, $3)`,
        [id, userName, startedAt.toISOString()],
      );
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
      await query(
        `UPDATE sessions
            SET ended_at = $2, avg_score = $3, shot_count = $4, summary = $5
          WHERE id = $1`,
        [
          req.params.id,
          endedAt ? new Date(endedAt).toISOString() : null,
          Number(avgScore) || 0,
          Number(shotCount) || 0,
          summary != null ? JSON.stringify(summary) : null,
        ],
      );
      // Leaderboard (v1.0): sessions/shots purge after 3 days, so the finished
      // session's name + scores are ALSO recorded on the durable board (never
      // purged; the ranking site reads only this table). Idempotent by PK;
      // best-effort — a board failure must not fail the session PATCH.
      if ((Number(shotCount) || 0) > 0) {
        try {
          await query(
            `INSERT INTO leaderboard_records
               (session_id, user_name, avg_score, max_score, shot_count, played_at)
             SELECT s.id, s.user_name, $2,
                    COALESCE((SELECT max(score) FROM shots WHERE session_id = s.id), 0),
                    $3, s.started_at
               FROM sessions s WHERE s.id = $1
             ON CONFLICT (session_id) DO UPDATE SET
               user_name = EXCLUDED.user_name,
               avg_score = EXCLUDED.avg_score,
               max_score = EXCLUDED.max_score,
               shot_count = EXCLUDED.shot_count`,
            [req.params.id, Number(avgScore) || 0, Number(shotCount) || 0],
          );
        } catch (err) {
          console.error('[routes] leaderboard record (non-fatal):', err?.message || err);
        }
      }
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
      const id = randomUUID();
      await query(
        `INSERT INTO shots
           (id, session_id, idx, type, score, angles, statuses, issues, peak_wrist_speed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          req.params.id,
          body.idx,
          body.type,
          body.score,
          JSON.stringify(body.angles),
          JSON.stringify(body.statuses),
          JSON.stringify(body.issues),
          body.peakWristSpeed,
        ],
      );
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
      const found = await query(`SELECT session_id FROM shots WHERE id = $1`, [req.params.id]);
      if (found.rowCount === 0) {
        return res.status(404).json({ error: 'shot_not_found' });
      }
      const sessionId = found.rows[0].session_id;
      const path = clipObjectPath(sessionId, req.params.id, mime);
      await saveClip(path, buf, mime);
      await query(`UPDATE shots SET clip_path = $2, clip_mime = $3 WHERE id = $1`, [
        req.params.id,
        path,
        mime,
      ]);
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
      const found = await query(`SELECT session_id FROM shots WHERE id = $1`, [req.params.id]);
      if (found.rowCount === 0) {
        return res.status(404).json({ error: 'shot_not_found' });
      }
      const sessionId = found.rows[0].session_id;
      const path = audioObjectPath(sessionId, req.params.id);
      await saveClip(path, buf, mime);
      await query(`UPDATE shots SET audio_path = $2, audio_mime = $3 WHERE id = $1`, [
        req.params.id,
        path,
        mime,
      ]);
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
      const { rows } = await query(
        `SELECT * FROM sessions
          WHERE started_at >= now() - ($1 || ' days')::interval
          ORDER BY started_at DESC`,
        [String(days)],
      );
      res.json(rows.map(sessionRowToJson));
    } catch (err) {
      console.error('[routes] history:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- GET /api/sessions/:id — detail incl shots --------------------------
  app.get('/api/sessions/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
      const sRes = await query(`SELECT * FROM sessions WHERE id = $1`, [req.params.id]);
      if (sRes.rowCount === 0) {
        return res.status(404).json({ error: 'session_not_found' });
      }
      const shRes = await query(
        `SELECT * FROM shots WHERE session_id = $1 ORDER BY idx ASC`,
        [req.params.id],
      );
      res.json({
        ...sessionRowToJson(sRes.rows[0]),
        shots: shRes.rows.map(shotRowToJson),
      });
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
      const { rows, rowCount } = await query(
        `SELECT clip_path, clip_mime FROM shots WHERE id = $1`,
        [req.params.shotId],
      );
      if (rowCount === 0 || !rows[0].clip_path) {
        return res.status(404).json({ error: 'clip_not_found' });
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      await streamClip(rows[0].clip_path, rows[0].clip_mime, req, res);
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
      const { rows, rowCount } = await query(
        `SELECT audio_path, audio_mime FROM shots WHERE id = $1`,
        [req.params.shotId],
      );
      if (rowCount === 0 || !rows[0].audio_path) {
        return res.status(404).json({ error: 'audio_not_found' });
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      await streamClip(rows[0].audio_path, rows[0].audio_mime || 'audio/wav', req, res);
    } catch (err) {
      console.error('[routes] audio stream:', err?.message || err);
      if (!res.headersSent) res.status(503).json(unavailableBody('clips'));
    }
  });

  // --- DELETE /api/sessions/:id — cascade delete rows (204) ---------------
  app.delete('/api/sessions/:id', async (req, res) => {
    if (!requireDb(res)) return;
    try {
      await query(`DELETE FROM sessions WHERE id = $1`, [req.params.id]);
      res.status(204).end();
    } catch (err) {
      console.error('[routes] delete session:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });
}

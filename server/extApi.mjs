// ============================================================================
// ADGE Tennis — external history API (SIT v2.1).
//
// A SEPARATE auth path from the browser cookie gate: every /api/ext/* route is
// authed ONLY by a shared secret in the `x-api-key` header (constant-time
// compared against env HISTORY_API_KEY). The cookie gate explicitly skips the
// `/ext` prefix (see authGate.mjs) so this is the sole auth here.
//
// It exposes a player's play history + durable stats + coach clip/audio, keyed
// by lineUserId (the per-session key) or lineEmail. ownerEmail is the shared
// ROOM account and is NEVER a query key here.
//
//   GET /api/ext/history?lineUserId=U..|email=..   live (≤3d) sessions + shots
//   GET /api/ext/stats?lineUserId=U..|email=..     durable leaderboard + totals
//   GET /api/ext/clips/:shotId                     proxy-stream the swing clip
//   GET /api/ext/audio/:shotId                     proxy-stream the coach WAV
//
// NO cost/usage is exposed (internal-only, PO decision). Clip/audio URLs in the
// history response are same-origin ext paths that themselves require x-api-key.
// ============================================================================

import express from 'express';
import { backend } from './store.mjs';
import { gcsReady, streamClip } from './gcs.mjs';
import { apiKeyMatches } from './authCore.mjs';
import { unavailableBody } from './lib.mjs';

const HISTORY_DAYS = 3; // matches the session/clip TTL — older data is gone anyway

/** The configured API key, or '' when unset (→ every ext route 503s). Read
 *  lazily each request so a key rotated via redeploy takes effect. */
function configuredKey() {
  return (process.env.HISTORY_API_KEY || '').trim();
}

export function mountExtApi(app) {
  const ext = express.Router();

  // --- x-api-key gate (the ONLY auth under /ext) --------------------------
  ext.use((req, res, next) => {
    const want = configuredKey();
    if (!want) {
      // Feature not provisioned → same bilingual 503 shape as the token path.
      return res.status(503).json(unavailableBody('cloud'));
    }
    if (!apiKeyMatches(req.get('x-api-key'), want)) {
      return res.status(401).json({ error: 'invalid_api_key', message: 'Bad or missing x-api-key' });
    }
    return next();
  });

  const requireDb = (res) => {
    if (backend.ready()) return true;
    res.status(503).json(unavailableBody('cloud'));
    return false;
  };

  /** Read the lineUserId/email query pair (email lowercased). null when neither. */
  function identityFromQuery(req) {
    const lineUserId = String(req.query.lineUserId ?? '').trim();
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (!lineUserId && !email) return null;
    return { lineUserId: lineUserId || undefined, lineEmail: email || undefined };
  }

  // --- GET /api/ext/history — live sessions + shots -----------------------
  ext.get('/history', async (req, res) => {
    if (!requireDb(res)) return;
    const id = identityFromQuery(req);
    if (!id) {
      return res.status(400).json({ error: 'missing_query', message: 'lineUserId or email required' });
    }
    try {
      const sessions = await backend.listHistoryByLine(HISTORY_DAYS, id);
      // Decorate each shot with ext clip/audio URLs (x-api-key required on them).
      const decorated = sessions.map((s) => ({
        ...s,
        shots: (s.shots || []).map((sh) => ({
          ...sh,
          clipUrl: sh.hasClip ? `/api/ext/clips/${sh.id}` : null,
          audioUrl: sh.hasAudio ? `/api/ext/audio/${sh.id}` : null,
        })),
      }));
      res.json({
        query: { lineUserId: id.lineUserId ?? null, email: id.lineEmail ?? null },
        windowDays: HISTORY_DAYS,
        count: decorated.length,
        sessions: decorated,
      });
    } catch (err) {
      console.error('[ext] history:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- GET /api/ext/stats — durable leaderboard + totals ------------------
  ext.get('/stats', async (req, res) => {
    if (!requireDb(res)) return;
    const id = identityFromQuery(req);
    if (!id) {
      return res.status(400).json({ error: 'missing_query', message: 'lineUserId or email required' });
    }
    try {
      const { leaderboard, totals } = await backend.getStatsByLine(id);
      res.json({
        query: { lineUserId: id.lineUserId ?? null, email: id.lineEmail ?? null },
        totals,
        leaderboard,
      });
    } catch (err) {
      console.error('[ext] stats:', err?.message || err);
      res.status(503).json(unavailableBody('cloud'));
    }
  });

  // --- GET /api/ext/clips/:shotId — proxy-stream (Range/206) --------------
  // No per-user ownership: the API key IS the authorization boundary here.
  ext.get('/clips/:shotId', async (req, res) => {
    if (!requireDb(res)) return;
    if (!gcsReady()) return res.status(503).json(unavailableBody('clips'));
    try {
      const access = await backend.getShotAccess(req.params.shotId);
      if (!access) return res.status(404).json({ error: 'shot_not_found' });
      if (!access.clipPath) return res.status(404).json({ error: 'clip_not_found' });
      res.setHeader('Cache-Control', 'private, max-age=3600');
      await streamClip(access.clipPath, access.clipMime, req, res);
    } catch (err) {
      console.error('[ext] clip stream:', err?.message || err);
      if (!res.headersSent) res.status(503).json(unavailableBody('clips'));
    }
  });

  // --- GET /api/ext/audio/:shotId — proxy-stream the coach WAV -----------
  ext.get('/audio/:shotId', async (req, res) => {
    if (!requireDb(res)) return;
    if (!gcsReady()) return res.status(503).json(unavailableBody('clips'));
    try {
      const access = await backend.getShotAccess(req.params.shotId);
      if (!access) return res.status(404).json({ error: 'shot_not_found' });
      if (!access.audioPath) return res.status(404).json({ error: 'audio_not_found' });
      res.setHeader('Cache-Control', 'private, max-age=3600');
      await streamClip(access.audioPath, access.audioMime || 'audio/wav', req, res);
    } catch (err) {
      console.error('[ext] audio stream:', err?.message || err);
      if (!res.headersSent) res.status(503).json(unavailableBody('clips'));
    }
  });

  app.use('/api/ext', ext);
}

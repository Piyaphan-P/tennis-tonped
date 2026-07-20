// ============================================================================
// ADGE Tennis — Postgres access (metadata only; NO blobs).
//
// Lazy singleton pg Pool, created ONLY when DATABASE_URL is set. Neon/Supabase
// serverless free tier: TLS required, tiny pool, cold-disconnect tolerant. Any
// thrown pg error surfaces to the route as a rejected query() (→ 503/500) — it
// never crashes the process (pool 'error' handler + per-query try/catch).
//
// Schema auto-migrates on boot (CREATE TABLE IF NOT EXISTS). Rows older than
// 3 days are purged on boot and every 6h; GCS clips purge themselves via the
// bucket lifecycle, so the server never deletes GCS objects.
// ============================================================================

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { sessionRowToJson, shotRowToJson } from './lib.mjs';

const { Pool } = pg;

const CONN = process.env.DATABASE_URL || '';

/**
 * DB schema isolation (env DB_SCHEMA). 'public' (default) = production behavior,
 * byte-identical to before this env existed: no connect hook, no CREATE SCHEMA.
 * SIT sets DB_SCHEMA=sit so its rows live in a separate Postgres schema on the
 * SAME database. The value is string-interpolated into SQL (identifiers cannot
 * be parameterized), so it is sanitized to a strict identifier here — that
 * regex IS the injection guard. Anything invalid falls back to 'public'.
 */
const DB_SCHEMA = (() => {
  const raw = (process.env.DB_SCHEMA || 'public').trim();
  if (/^[a-z_][a-z0-9_]*$/.test(raw)) return raw;
  console.warn(`[db] invalid DB_SCHEMA "${raw}" — falling back to "public"`);
  return 'public';
})();

/** Lazy singleton — undefined until first use, null when no DATABASE_URL. */
let pool;

/** True when Postgres is configured (DATABASE_URL present). */
export function dbReady() {
  return Boolean(CONN);
}

function getPool() {
  if (pool !== undefined) return pool;
  if (!CONN) {
    pool = null;
    return pool;
  }
  pool = new Pool({
    connectionString: CONN,
    max: 3,
    ssl: { rejectUnauthorized: false },
    idleTimeoutMillis: 30_000,
  });
  // Serverless sockets get reaped when idle; swallow so a dead pooled client
  // never takes down the process — the next query() just opens a fresh one.
  pool.on('error', (err) => {
    console.error('[db] idle client error (ignored):', err?.message || err);
  });
  // Non-default schema (e.g. SIT 'sit'): pin every new connection's search_path
  // so all unqualified queries resolve into that schema. The Supabase pooler on
  // :5432 is SESSION mode, so SET persists for the life of the pooled client.
  // Public = prod: no hook at all (byte-identical to prior behavior).
  if (DB_SCHEMA !== 'public') {
    pool.on('connect', (client) => {
      client.query(`SET search_path TO ${DB_SCHEMA}`).catch((err) => {
        console.error('[db] failed to set search_path:', err?.message || err);
      });
    });
  }
  return pool;
}

/**
 * Run one parameterized query. Rejects on any pg error (caller maps to 5xx).
 * Rejects immediately when the pool is not configured.
 */
export async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL not configured');
  return p.query(text, params);
}

const MIGRATE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_name text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  avg_score real NOT NULL DEFAULT 0,
  shot_count int NOT NULL DEFAULT 0,
  summary jsonb
);
CREATE TABLE IF NOT EXISTS shots (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx int NOT NULL,
  type text NOT NULL,
  score real NOT NULL,
  angles jsonb,
  statuses jsonb,
  issues jsonb,
  peak_wrist_speed real NOT NULL DEFAULT 0,
  clip_path text,
  clip_mime text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shots_session_idx ON shots(session_id, idx);
ALTER TABLE shots ADD COLUMN IF NOT EXISTS audio_path text;
ALTER TABLE shots ADD COLUMN IF NOT EXISTS audio_mime text;
CREATE TABLE IF NOT EXISTS leaderboard_records (
  session_id uuid PRIMARY KEY,
  user_name text NOT NULL DEFAULT '',
  avg_score real NOT NULL DEFAULT 0,
  max_score real NOT NULL DEFAULT 0,
  shot_count int NOT NULL DEFAULT 0,
  played_at timestamptz NOT NULL
);
`;

/** Create tables/index if absent. No-op (resolves) when DB not configured. */
export async function migrate() {
  if (!dbReady()) return;
  // For a non-default schema (SIT), create it first; the search_path hook then
  // lands the unqualified CREATE TABLE statements inside it. Public = prod: skip
  // (the schema always exists), keeping migration byte-identical to before.
  if (DB_SCHEMA !== 'public') {
    await query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  }
  await query(MIGRATE_SQL);
}

/** Delete sessions (and cascade shots) older than 3 days. GCS self-purges. */
export async function purgeOld() {
  if (!dbReady()) return;
  await query(`DELETE FROM sessions WHERE started_at < now() - interval '3 days'`);
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Boot-time init: migrate then purge, best-effort (never throws into boot),
 * and schedule a recurring purge every 6h. No-op when DB not configured.
 */
export function initDb() {
  if (!dbReady()) {
    console.log('[db] DATABASE_URL not set — cloud history disabled (localStorage fallback)');
    return;
  }
  migrate()
    .then(() => purgeOld())
    .then(() => console.log(`[db] migrated + purged; cloud history ON (schema: ${DB_SCHEMA})`))
    .catch((err) => console.error('[db] boot init failed (non-fatal):', err?.message || err));
  const timer = setInterval(() => {
    purgeOld().catch((err) => console.error('[db] periodic purge failed:', err?.message || err));
  }, SIX_HOURS_MS);
  timer.unref?.();
}

// ============================================================================
// Route-facing interface (pgBackend)
//
// The operation surface routes.mjs needs, wrapping the EXACT SQL that used to
// live inline in the routes — behavior is byte-identical to before this
// extraction (prod runs this path; DB_BACKEND=postgres is the default). Nothing
// above this line changed. store.mjs selects between this and firestoreBackend.
// ============================================================================
export const pgBackend = {
  name: 'postgres',
  ready: () => dbReady(),
  init: () => initDb(),

  async createSession({ userName, startedAt }) {
    const id = randomUUID();
    await query(`INSERT INTO sessions (id, user_name, started_at) VALUES ($1, $2, $3)`, [
      id,
      userName,
      startedAt.toISOString(),
    ]);
    return { id };
  },

  // `usage` (admin cost visibility) is accepted but NOT recorded on the
  // Postgres path (Firestore-only, like UAM). The usage write is fire-and-
  // forget by contract — it must never fail the PATCH — so it is logged and
  // dropped here rather than thrown.
  async patchSession(id, { endedAt, avgScore, shotCount, summary, usage }) {
    if (usage) {
      console.error(
        '[routes] usage record dropped (not implemented on postgres path — Firestore-only)',
      );
    }
    await query(
      `UPDATE sessions
          SET ended_at = $2, avg_score = $3, shot_count = $4, summary = $5
        WHERE id = $1`,
      [
        id,
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
        // SECURITY: avg_score AND max_score for the DURABLE board are computed
        // from the STORED shots (avg()/max()), NOT from the client-supplied
        // avgScore (spoofable). The WHERE ... EXISTS shots gate means a session
        // with zero shots writes NO leaderboard row (matches the Firestore
        // path's leaderboardScores→null skip). shot_count = $2.
        await query(
          `INSERT INTO leaderboard_records
             (session_id, user_name, avg_score, max_score, shot_count, played_at)
           SELECT s.id, s.user_name,
                  COALESCE((SELECT avg(score) FROM shots WHERE session_id = s.id), 0),
                  COALESCE((SELECT max(score) FROM shots WHERE session_id = s.id), 0),
                  $2, s.started_at
             FROM sessions s
            WHERE s.id = $1
              AND EXISTS (SELECT 1 FROM shots WHERE session_id = s.id)
           ON CONFLICT (session_id) DO UPDATE SET
             user_name = EXCLUDED.user_name,
             avg_score = EXCLUDED.avg_score,
             max_score = EXCLUDED.max_score,
             shot_count = EXCLUDED.shot_count`,
          [id, Number(shotCount) || 0],
        );
      } catch (err) {
        console.error('[routes] leaderboard record (non-fatal):', err?.message || err);
      }
    }
  },

  async createShot(sessionId, meta) {
    const id = randomUUID();
    await query(
      `INSERT INTO shots
         (id, session_id, idx, type, score, angles, statuses, issues, peak_wrist_speed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        sessionId,
        meta.idx,
        meta.type,
        meta.score,
        JSON.stringify(meta.angles),
        JSON.stringify(meta.statuses),
        JSON.stringify(meta.issues),
        meta.peakWristSpeed,
      ],
    );
    return { id };
  },

  async getShotSession(shotId) {
    const found = await query(`SELECT session_id FROM shots WHERE id = $1`, [shotId]);
    if (found.rowCount === 0) return null;
    return found.rows[0].session_id;
  },

  /**
   * Single-lookup resolver for the clip/audio routes (mirrors the Firestore
   * getShotAccess): ONE SELECT returns session_id + existing clip/audio refs.
   * ownerEmail is always null on the Postgres path (legacy/admin-only, like
   * getShotOwner). Returns null when the shot does not exist.
   */
  async getShotAccess(shotId) {
    const { rows, rowCount } = await query(
      `SELECT session_id, clip_path, clip_mime, audio_path, audio_mime FROM shots WHERE id = $1`,
      [shotId],
    );
    if (rowCount === 0) return null;
    const r = rows[0];
    return {
      sessionId: r.session_id,
      ownerEmail: null,
      clipPath: r.clip_path ?? null,
      clipMime: r.clip_mime ?? null,
      audioPath: r.audio_path ?? null,
      audioMime: r.audio_mime ?? null,
    };
  },

  // sessionId accepted for signature parity with the Firestore backend (which
  // writes by direct path); Postgres keys on the shot PK and ignores it.
  async setShotClip(_sessionId, shotId, path, mime) {
    await query(`UPDATE shots SET clip_path = $2, clip_mime = $3 WHERE id = $1`, [
      shotId,
      path,
      mime,
    ]);
  },

  async setShotAudio(_sessionId, shotId, path, mime) {
    await query(`UPDATE shots SET audio_path = $2, audio_mime = $3 WHERE id = $1`, [
      shotId,
      path,
      mime,
    ]);
  },

  async getShotClipRef(shotId) {
    const { rows, rowCount } = await query(
      `SELECT clip_path, clip_mime FROM shots WHERE id = $1`,
      [shotId],
    );
    if (rowCount === 0 || !rows[0].clip_path) return null;
    return { clipPath: rows[0].clip_path, clipMime: rows[0].clip_mime };
  },

  async getShotAudioRef(shotId) {
    const { rows, rowCount } = await query(
      `SELECT audio_path, audio_mime FROM shots WHERE id = $1`,
      [shotId],
    );
    if (rowCount === 0 || !rows[0].audio_path) return null;
    return { audioPath: rows[0].audio_path, audioMime: rows[0].audio_mime };
  },

  async listHistory(days, { ownerEmail } = {}) {
    // UAM v1.5 is Firestore-only (user decision — SIT and future prod both run
    // Firestore). The owner-filtered path has no SQL implementation; routes
    // turn this into their bilingual 503.
    if (ownerEmail) throw new Error('listHistory(ownerEmail) not implemented on postgres path');
    const { rows } = await query(
      `SELECT * FROM sessions
        WHERE started_at >= now() - ($1 || ' days')::interval
        ORDER BY started_at DESC`,
      [String(days)],
    );
    return rows.map(sessionRowToJson);
  },

  async getSessionDetail(id) {
    const sRes = await query(`SELECT * FROM sessions WHERE id = $1`, [id]);
    if (sRes.rowCount === 0) return null;
    const shRes = await query(`SELECT * FROM shots WHERE session_id = $1 ORDER BY idx ASC`, [id]);
    return {
      ...sessionRowToJson(sRes.rows[0]),
      shots: shRes.rows.map(shotRowToJson),
    };
  },

  async deleteSession(id) {
    await query(`DELETE FROM sessions WHERE id = $1`, [id]);
  },

  // ==========================================================================
  // Users + ownership (UAM v1.5) — STUBS ONLY on the Postgres path.
  //
  // The real implementation is Firestore-only (user decision: SIT and future
  // prod both run DB_BACKEND=firestore). These stubs exist so the interface is
  // complete and DB_BACKEND=postgres still boots: user-management methods
  // throw a clear error (routes → 503); the ownership helpers reuse EXISTING
  // queries and report ownerEmail=null, i.e. every pg session behaves like a
  // legacy row (admin-visible only). No new SQL here by design.
  // ==========================================================================

  async getUser() {
    throw new Error('users not implemented on postgres path (UAM is Firestore-only)');
  },
  async listUsers() {
    throw new Error('users not implemented on postgres path (UAM is Firestore-only)');
  },
  async createUser() {
    throw new Error('users not implemented on postgres path (UAM is Firestore-only)');
  },
  async updateUser() {
    throw new Error('users not implemented on postgres path (UAM is Firestore-only)');
  },
  async deleteUser() {
    throw new Error('users not implemented on postgres path (UAM is Firestore-only)');
  },
  async ensureAdmin() {
    throw new Error('ensureAdmin not implemented on postgres path (UAM is Firestore-only)');
  },
  /** Admin cost aggregate (GET /api/usage) — Firestore-only, like users. The
   *  route maps this throw to its bilingual 503. */
  async aggregateUsage() {
    throw new Error('usage aggregation not implemented on postgres path (Firestore-only)');
  },

  /** Ownership stub: session exists → legacy owner (null → admin-only). */
  async getSessionOwner(id) {
    const detail = await this.getSessionDetail(id);
    return detail ? { ownerEmail: detail.ownerEmail ?? null } : null;
  },

  /** Ownership stub: resolves the shot's session, owner always legacy-null. */
  async getShotOwner(shotId) {
    const sessionId = await this.getShotSession(shotId);
    return sessionId ? { sessionId, ownerEmail: null } : null;
  },
};

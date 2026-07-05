// ============================================================================
// ต้นและเพชร Tennis Club — Postgres access (metadata only; NO blobs).
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

const { Pool } = pg;

const CONN = process.env.DATABASE_URL || '';

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
`;

/** Create tables/index if absent. No-op (resolves) when DB not configured. */
export async function migrate() {
  if (!dbReady()) return;
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
    .then(() => console.log('[db] migrated + purged; cloud history ON'))
    .catch((err) => console.error('[db] boot init failed (non-fatal):', err?.message || err));
  const timer = setInterval(() => {
    purgeOld().catch((err) => console.error('[db] periodic purge failed:', err?.message || err));
  }, SIX_HOURS_MS);
  timer.unref?.();
}

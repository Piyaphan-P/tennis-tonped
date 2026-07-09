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

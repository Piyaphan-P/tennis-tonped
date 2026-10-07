// ============================================================================
// ADGE Tennis — data-layer selector.
//
// Reads env DB_BACKEND and exports ONE backend implementing the route-facing
// interface (see pgBackend in db.mjs / firestoreBackend in dbFirestore.mjs):
//
//   DB_BACKEND=postgres  (default) → Supabase Postgres, byte-identical to prod.
//   DB_BACKEND=firestore           → Firestore "nonprd" (SIT migration target).
//
// routes.mjs calls `backend.*` and `backend.ready()`; index.mjs calls
// `initDb()`. Both backends are statically imported, but each keeps its client
// lazy, so selecting one costs nothing for the other.
// ============================================================================

import { pgBackend } from './db.mjs';
import { firestoreBackend } from './dbFirestore.mjs';

const CHOICE = (process.env.DB_BACKEND || 'postgres').trim().toLowerCase();

export const backend = CHOICE === 'firestore' ? firestoreBackend : pgBackend;

console.log(`[db] DB_BACKEND=${CHOICE} → using ${backend.name} backend`);

/** Boot the selected backend (pg: migrate+purge+timer; firestore: log only). */
export function initDb() {
  return backend.init();
}

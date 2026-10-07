// ============================================================================
// ADGE Tennis — External Stat API (STANDALONE service, 2026-07-28).
//
// Deployed SEPARATELY from the coach app (user request: don't bundle it). This
// entry mounts ONLY the /api/ext/* endpoints (history/stats/clips/audio) — the
// same router the coach app used to mount — authed solely by the x-api-key
// (HISTORY_API_KEY). NO coach routes, NO cookie login gate, NO token minter,
// NO static frontend. It reuses the exact same data layer (store/dbFirestore,
// gcs, lib) as the coach app, so responses are byte-identical.
//
// Env (Cloud Run): DB_BACKEND=firestore, FIRESTORE_DATABASE=nonprd,
// GOOGLE_CLOUD_PROJECT=adge-tennis-nonprd, GCS_BUCKET=adge-tennis-nonprd-clips,
// HISTORY_API_KEY (secret). Runtime SA needs Firestore + GCS read.
// ============================================================================
import express from 'express';
import http from 'node:http';
import { mountExtApi } from './extApi.mjs';
import { initDb } from './store.mjs';

const app = express();
const PORT = process.env.PORT || 8080;

// Liveness/readiness — public, no key. Reports whether the API key is wired.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'adge-stat-api', keyConfigured: Boolean(process.env.HISTORY_API_KEY) });
});

// Boot the metadata backend (firestore in SIT), then mount the ext router.
// Every /api/ext/* route enforces x-api-key itself (extApi.mjs) — there is no
// cookie gate here, so nothing else guards these paths by design.
initDb();
mountExtApi(app);

// Anything else = 404 JSON (no SPA fallback — this service serves no frontend).
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`ADGE Stat API (external /api/ext/*) on :${PORT}`);
});

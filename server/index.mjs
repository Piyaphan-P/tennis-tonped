// ต้นและเพชร Tennis Club — token-minting backend + static server
// -----------------------------------------------------------------------------
// Serves the built frontend (../dist) AND exposes GET /api/token which mints a
// short-lived Gemini Live *ephemeral* token (AQ...) from a long-lived API key
// held ONLY here (env GEMINI_API_KEY, via Secret Manager on Cloud Run).
//
// The real key never reaches the browser. The browser fetches a fresh ephemeral
// token from /api/token on every (re)connect, so a court session keeps coaching
// continuously without the ~30-min token expiry cutting it off.
// -----------------------------------------------------------------------------
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { mountCloudRoutes } from './routes.mjs';
import { initDb } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

const API_KEY = process.env.GEMINI_API_KEY || '';       // long-lived AIza… (server-only secret)
const TOKEN_TTL_MIN = Number(process.env.TOKEN_TTL_MIN || 30);
const TOKEN_USES = Number(process.env.TOKEN_USES || 10);

// A single client bound to the long-lived key. v1alpha is required for minting.
const minter = API_KEY
  ? new GoogleGenAI({ apiKey: API_KEY, httpOptions: { apiVersion: 'v1alpha' } })
  : null;

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, minter: Boolean(minter), ttlMin: TOKEN_TTL_MIN });
});

// Mint a fresh ephemeral token for the browser Live session.
app.get('/api/token', async (_req, res) => {
  if (!minter) {
    return res.status(503).json({
      error: 'no_api_key',
      // Bilingual so the frontend can show it verbatim if needed.
      message:
        'Server has no GEMINI_API_KEY. Set it (Secret Manager) to enable live coaching. / ' +
        'เซิร์ฟเวอร์ยังไม่มี GEMINI_API_KEY — ตั้งค่า secret ก่อนถึงจะโค้ชสดได้',
    });
  }
  try {
    const expireTime = new Date(Date.now() + TOKEN_TTL_MIN * 60_000).toISOString();
    // Unlocked config (Case 1): the frontend sets its own systemInstruction
    // (with the player's name) and transcription options per session.
    const token = await minter.authTokens.create({
      config: { uses: TOKEN_USES, expireTime },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ token: token.name, expiresAt: expireTime });
  } catch (err) {
    console.error('[token] mint failed:', err?.message || err);
    res.status(502).json({ error: 'mint_failed', message: String(err?.message || err) });
  }
});

// Cloud persistence (Postgres metadata + GCS clips). Mounted BEFORE the static
// / SPA fallback so /api/* routes win over the catch-all. Boots the DB
// (migrate + purge + 6h purge timer); all endpoints degrade to a bilingual 503
// when DATABASE_URL / GCS creds are absent — nothing crashes.
initDb();
mountCloudRoutes(app);

// Static frontend + SPA fallback.
const dist = path.join(__dirname, '..', 'dist');
app.use(express.static(dist));
app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));

app.listen(PORT, () => {
  console.log(`ต้นและเพชร Tennis Club server on :${PORT} (token minting: ${minter ? 'on' : 'OFF'})`);
});

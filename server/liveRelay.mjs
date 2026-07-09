// ADGE Tennis — Vertex AI Live WebSocket relay
// -----------------------------------------------------------------------------
// The browser CANNOT hold Google credentials, and a raw browser→Vertex WS with
// an access_token in the query string is rejected as too broad. So this relay
// sits same-origin at /api/live: the browser speaks the SAME BidiGenerateContent
// WS protocol it always did, and we open the REAL Vertex Live session server-side
// with ADC (Application Default Credentials) and pipe frames both ways.
//
// DESIGN — raw upstream WS + Bearer, pure frame piping (NOT the SDK live.connect):
//   • Faithful: the browser's frames ARE the Bidi protocol frames, so we forward
//     them byte-verbatim. The ONLY frame we touch is the first `setup` frame,
//     where we OVERWRITE the model + pin location='global' server-side. The
//     client's systemInstruction / generationConfig / transcription config pass
//     through untouched (the client builds the coach persona + player name).
//   • Everything downstream (serverContent incl. audio inlineData,
//     outputTranscription, turnComplete, usageMetadata) pipes back verbatim so
//     the existing browser message handling — and the cost monitor's
//     usageMetadata parsing — keep working unchanged.
//   • Empirically de-risked (spike browser-direct2.mjs channel 3): a raw upstream
//     WS with `Authorization: Bearer <ADC token>` returns setupComplete + audio
//     chunks + transcript + usageMetadata on gemini-live-2.5-flash @ global.
//
// NEVER crashes the process: every socket has an 'error' handler, upstream close
// codes are sanitized (ws.close throws on 1005/1006/1015), and ADC / permission
// failures degrade to a clean close code the browser can surface bilingually.
// -----------------------------------------------------------------------------
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleAuth } from 'google-auth-library';
import { isGateAuthorized } from './authGate.mjs';

// --- Pinned server-side (the client is NOT trusted for these) -----------------
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'ton-team';
const LOCATION = 'global'; // Live is allowlisted ONLY at global for this project.
const MODEL_ID = 'gemini-live-2.5-flash'; // half-cascade; native-audio not allowlisted.
const MODEL_PATH = `projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL_ID}`;

// Global Vertex Live endpoint (regional endpoints reject Live with WS 1008).
const UPSTREAM_URL =
  'wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent';

const PATH = '/api/live';
const IDLE_MS = 5 * 60 * 1000; // close an idle relay after ~5 min of no frames.
const PING_MS = 30 * 1000; // heartbeat to detect dead browser sockets.
const MAX_PENDING = 400; // cap frames buffered before upstream opens (flood guard).

// One shared ADC token source (caches + refreshes internally).
const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });

// Application-range close codes the browser can switch on for a bilingual message.
const CLOSE = {
  BAD_SETUP: 4000, // first frame was not a valid `setup` frame
  UPSTREAM_ERROR: 4001, // generic upstream failure
  ADC_UNAVAILABLE: 4002, // could not obtain ADC credentials
  PERMISSION_DENIED: 4403, // SA lacks roles/aiplatform.user (handshake 401/403)
  IDLE_TIMEOUT: 4008, // no activity for IDLE_MS
  BUFFER_OVERFLOW: 4009, // client flooded frames before setup completed
};

const IAM_HINT =
  `Grant the Cloud Run runtime SA aiplatform access:\n` +
  `  gcloud projects add-iam-policy-binding ${PROJECT} \\\n` +
  `    --member=serviceAccount:<RUNTIME_SA_EMAIL> --role=roles/aiplatform.user`;

// ws.close() throws (RangeError) for reserved/invalid codes. Only 1000..1003,
// 1007..1011 and 3000..4999 are sendable — map anything else to 1011.
function sanitizeCloseCode(code) {
  if (typeof code !== 'number') return 1011;
  if (code >= 3000 && code <= 4999) return code;
  if (code >= 1000 && code <= 1003) return code;
  if (code >= 1007 && code <= 1011) return code;
  return 1011;
}

// Close reasons must be <=123 bytes UTF-8.
function sanitizeReason(reason) {
  const s = typeof reason === 'string' ? reason : String(reason ?? '');
  const buf = Buffer.from(s, 'utf8');
  return buf.length <= 123 ? s : buf.subarray(0, 123).toString('utf8');
}

/**
 * Mount the Vertex Live relay onto an http.Server. Handles the WS upgrade for
 * PATH itself (so other upgrade consumers, if any are added later, still see the
 * event for non-matching paths).
 */
export function mountLiveRelay(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = req.url;
    }
    if (pathname !== PATH) {
      // No other upgrade consumer exists — close cleanly instead of leaving the
      // socket dangling until the client times out.
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // CSRF guard: a browser cannot suppress Origin, so a present Origin whose
    // host differs from our own is a cross-origin caller — reject it. A missing
    // Origin (server-to-server tools, our own Node test client) is allowed.
    if (!originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Same gate as the HTTP /api/* routes: no valid login cookie → no relay.
    // (Origin alone is spoofable from non-browser callers; the cookie is not.)
    if (!isGateAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => handleBrowser(ws, req));
  });

  console.log(`[live] relay mounted at ${PATH} → Vertex ${MODEL_ID} @ ${LOCATION} (project ${PROJECT})`);
  return wss;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // no browser Origin → non-browser caller, allow.
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // malformed Origin → reject.
  }
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost)) return true; // dev.
  const expected = [req.headers['x-forwarded-host'], req.headers.host].filter(Boolean);
  return expected.includes(originHost);
}

/**
 * Wire one browser socket to a fresh upstream Vertex Live session. Lazy-opens the
 * upstream only once the browser's `setup` frame arrives, so we never hold a
 * Vertex slot for a browser that connects and stays silent.
 */
function handleBrowser(browser, req) {
  let upstream = null;
  let upstreamOpen = false;
  let sawSetup = false;
  let setupFrame = null; // rewritten setup JSON string, sent first upstream.
  const pending = []; // {data, isBinary} frames buffered until upstream opens.
  let torn = false;
  let idleTimer = null;

  const label = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?';

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      closeBrowser(CLOSE.IDLE_TIMEOUT, 'idle_timeout');
    }, IDLE_MS);
  }

  // Heartbeat: terminate a browser socket that stops answering pings.
  browser.isAlive = true;
  browser.on('pong', () => {
    browser.isAlive = true;
  });
  const pingTimer = setInterval(() => {
    if (browser.readyState !== WebSocket.OPEN) return;
    if (!browser.isAlive) {
      teardown();
      return;
    }
    browser.isAlive = false;
    try {
      browser.ping();
    } catch {
      /* noop */
    }
  }, PING_MS);

  function teardown() {
    if (torn) return;
    torn = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(pingTimer);
    try {
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'relay_closed');
      else if (upstream) upstream.terminate();
    } catch {
      /* noop */
    }
    try {
      if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
        browser.terminate();
      }
    } catch {
      /* noop */
    }
  }

  function closeBrowser(code, reason) {
    try {
      if (browser.readyState === WebSocket.OPEN) {
        browser.close(sanitizeCloseCode(code), sanitizeReason(reason));
      }
    } catch {
      /* noop */
    }
    teardown();
  }

  // --- browser → upstream -----------------------------------------------------
  browser.on('message', (data, isBinary) => {
    resetIdle();

    if (!sawSetup) {
      sawSetup = true;
      // The first Bidi frame MUST be `setup`. Parse it, pin the model, forward.
      let parsed;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        closeBrowser(CLOSE.BAD_SETUP, 'expected JSON setup frame first');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.setup || typeof parsed.setup !== 'object') {
        closeBrowser(CLOSE.BAD_SETUP, 'first frame must be a setup frame');
        return;
      }
      // SECURITY: overwrite the model + pin location; never trust the client's
      // model. systemInstruction / generationConfig / transcription pass through.
      parsed.setup.model = MODEL_PATH;
      setupFrame = JSON.stringify(parsed);
      openUpstream();
      return;
    }

    if (upstreamOpen) {
      forwardUpstream(data, isBinary);
    } else {
      if (pending.length >= MAX_PENDING) {
        closeBrowser(CLOSE.BUFFER_OVERFLOW, 'too many frames before setup completed');
        return;
      }
      pending.push({ data, isBinary });
    }
  });

  browser.on('error', (err) => {
    console.error(`[live] browser socket error (${label}):`, err?.message || err);
    teardown();
  });

  browser.on('close', () => {
    teardown();
  });

  function forwardUpstream(data, isBinary) {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    try {
      upstream.send(data, { binary: isBinary });
    } catch (err) {
      console.error(`[live] forward→upstream failed (${label}):`, err?.message || err);
    }
  }

  // --- open the real Vertex session server-side (ADC) --------------------------
  async function openUpstream() {
    let token;
    try {
      token = await auth.getAccessToken();
      if (!token) throw new Error('empty access token');
    } catch (err) {
      console.error(`[live] ADC token failed (${label}):`, err?.message || err);
      console.error(IAM_HINT);
      closeBrowser(CLOSE.ADC_UNAVAILABLE, 'vertex_credentials_unavailable');
      return;
    }
    if (torn) return; // browser vanished while we were fetching the token.

    try {
      upstream = new WebSocket(UPSTREAM_URL, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      console.error(`[live] upstream construct failed (${label}):`, err?.message || err);
      closeBrowser(CLOSE.UPSTREAM_ERROR, 'upstream_connect_failed');
      return;
    }

    // Handshake-level HTTP rejection (401/403 = SA missing roles/aiplatform.user).
    upstream.on('unexpected-response', (_req, res) => {
      const status = res?.statusCode;
      console.error(`[live] upstream handshake HTTP ${status} (${label})`);
      if (status === 401 || status === 403) {
        console.error(IAM_HINT);
        closeBrowser(CLOSE.PERMISSION_DENIED, `vertex_permission_denied_${status}`);
      } else {
        closeBrowser(CLOSE.UPSTREAM_ERROR, `upstream_http_${status || 'error'}`);
      }
    });

    upstream.on('open', () => {
      upstreamOpen = true;
      resetIdle();
      try {
        upstream.send(setupFrame); // rewritten setup first…
        for (const f of pending) upstream.send(f.data, { binary: f.isBinary }); // …then buffered frames in order.
      } catch (err) {
        console.error(`[live] upstream initial send failed (${label}):`, err?.message || err);
        closeBrowser(CLOSE.UPSTREAM_ERROR, 'upstream_send_failed');
        return;
      }
      pending.length = 0;
    });

    // upstream → browser: ALWAYS re-framed as TEXT. Vertex sends every Live
    // frame as a BINARY WS frame (verified live: 13/13 incl. setupComplete) but
    // the payloads are all UTF-8 JSON — and a real browser delivers binary
    // frames as Blob, which the client cannot handle synchronously. Text
    // framing makes ev.data a plain string in every browser.
    upstream.on('message', (data) => {
      resetIdle();
      if (browser.readyState !== WebSocket.OPEN) return;
      try {
        browser.send(data, { binary: false });
      } catch (err) {
        console.error(`[live] forward→browser failed (${label}):`, err?.message || err);
      }
    });

    upstream.on('error', (err) => {
      console.error(`[live] upstream socket error (${label}):`, err?.message || err);
      // 'close' usually follows; if not, make sure the browser is released.
      if (!torn) closeBrowser(CLOSE.UPSTREAM_ERROR, 'upstream_error');
    });

    upstream.on('close', (code, reasonBuf) => {
      const reason = reasonBuf?.toString?.('utf8') || '';
      closeBrowser(code, reason || 'upstream_closed');
    });
  }

  resetIdle();
}

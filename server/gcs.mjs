// ============================================================================
// ADGE Tennis — GCS clip storage (ADC; bucket "adge-tennis-nonprd-clips").
//
// The bucket has a 3-day lifecycle rule (auto-delete) configured at the bucket
// level — the server NEVER deletes GCS objects. We only save() and stream().
// No signed URLs (the SA lacks signBlob): clips are always proxy-streamed
// through GET /api/clips/:shotId.
//
// ADC presence can only be verified at request time, so gcsReady() latches to
// false after a failed op; saveClip/streamClip are try/catch-wrapped so a
// credentials failure degrades to a 503/404 instead of crashing. The latch is
// TIME-BOXED (60s, mirroring src/data/api.ts) — a transient GCS timeout must
// not disable clips for the life of the Cloud Run instance.
// ============================================================================

import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.GCS_BUCKET || 'adge-tennis-nonprd-clips';
const OFFLINE_LATCH_MS = 60_000;

let storage;
let latchedUntil = 0;

function latchedOffline() {
  return Date.now() < latchedUntil;
}

function getBucket() {
  if (latchedOffline()) return null;
  try {
    if (!storage) storage = new Storage();
    return storage.bucket(BUCKET);
  } catch (err) {
    console.error('[gcs] Storage construction failed:', err?.message || err);
    latchedUntil = Date.now() + OFFLINE_LATCH_MS;
    return null;
  }
}

/**
 * True when GCS looks usable. Constructing Storage rarely throws (ADC is
 * resolved lazily at request time), so this returns true optimistically and
 * flips to false for OFFLINE_LATCH_MS once a real op fails (latchOffline).
 * Routes still wrap ops in try/catch and 503 on failure.
 */
export function gcsReady() {
  if (latchedOffline()) return false;
  return getBucket() !== null;
}

function latchOffline(err) {
  console.error('[gcs] op failed — latching offline for 60s:', err?.message || err);
  latchedUntil = Date.now() + OFFLINE_LATCH_MS;
}

/** Upload a clip buffer. Throws on failure (route maps to 503). */
export async function saveClip(objectPath, buffer, mime) {
  const bucket = getBucket();
  if (!bucket) throw new Error('GCS not available');
  try {
    await bucket.file(objectPath).save(buffer, {
      contentType: mime || 'application/octet-stream',
      resumable: false,
    });
  } catch (err) {
    latchOffline(err);
    throw err;
  }
}

/**
 * Stream a clip object to the HTTP response, honoring HTTP Range requests
 * (iOS Safari's <video> probes with `Range: bytes=0-1` and requires a 206 +
 * Content-Range or it refuses to play). Range requests need the object size,
 * fetched via getMetadata(); rangeless requests stream directly with
 * Accept-Ranges advertised. Responds 404 (missing) / 503 (other) exactly once,
 * guarding headersSent so a mid-stream error never double-sends.
 */
export async function streamClip(objectPath, mime, req, res) {
  const bucket = getBucket();
  if (!bucket) {
    latchOffline(new Error('GCS not available'));
    if (!res.headersSent) res.status(503).json({ error: 'cloud_unavailable' });
    return;
  }
  const file = bucket.file(objectPath);
  const sendError = (err) => {
    const code = err && err.code === 404 ? 404 : 503;
    if (code === 503) latchOffline(err);
    if (!res.headersSent) {
      res.status(code).json({ error: code === 404 ? 'clip_not_found' : 'clip_stream_failed' });
    } else {
      res.destroy();
    }
  };

  if (mime) res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');

  const rangeHeader = req.headers.range;
  const match = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  let readOpts;
  if (match && (match[1] !== '' || match[2] !== '')) {
    let size;
    try {
      const [meta] = await file.getMetadata();
      size = Number(meta.size);
    } catch (err) {
      sendError(err);
      return;
    }
    let start;
    let end;
    if (match[1] === '') {
      // suffix range: bytes=-N (last N bytes)
      const suffix = Math.min(Number(match[2]), size);
      start = size - suffix;
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    readOpts = { start, end };
  }

  let responded = false;
  const stream = file.createReadStream(readOpts);
  stream.on('error', (err) => {
    if (responded) return;
    responded = true;
    sendError(err);
  });
  stream.pipe(res);
}

// ============================================================================
// ADGE Tennis — PURE server helpers (cloud persistence).
//
// ZERO imports of pg / @google-cloud/storage / express so vitest at the repo
// root (where server deps are NOT installed) can unit-test this file cleanly.
// Only URL/path building, row→wire mappers, request validation, and the
// bilingual 503 body live here — nothing that touches a socket or the disk.
// ============================================================================

/** 'mp4' when the recorded container is mp4, else 'webm' (our two families). */
export function extFromMime(mime) {
  return typeof mime === 'string' && mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/** GCS object path for a clip: `<sessionId>/<shotId>.<ext>` (bucket is fixed). */
export function clipObjectPath(sessionId, shotId, mime) {
  return `${sessionId}/${shotId}.${extFromMime(mime)}`;
}

/**
 * GCS object path for a coach-audio WAV: `audio/<sessionId>/<shotId>.wav`.
 * The `audio/` prefix keeps clips and audio in disjoint namespaces under the
 * same bucket (and the same 3-day lifecycle rule reaps both).
 */
export function audioObjectPath(sessionId, shotId) {
  return `audio/${sessionId}/${shotId}.wav`;
}

/**
 * ISO string from a timestamp-ish value → string|null. Accepts pg timestamptz
 * (Date | ISO string) AND a Firestore Timestamp (duck-typed via `.toDate()` so
 * this file stays import-free — a raw Firestore Timestamp fed to `new Date()`
 * would otherwise yield Invalid Date).
 */
function isoOrNull(v) {
  if (v == null) return null;
  try {
    let d;
    if (v instanceof Date) d = v;
    else if (typeof v?.toDate === 'function') d = v.toDate();
    else d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/** sessions row (snake_case) → CloudSessionSummary wire shape (see src/types.ts). */
export function sessionRowToJson(row) {
  return {
    id: row.id,
    userName: row.user_name ?? '',
    startedAt: isoOrNull(row.started_at),
    endedAt: isoOrNull(row.ended_at),
    avgScore: Number(row.avg_score) || 0,
    shotCount: Number(row.shot_count) || 0,
    summary: row.summary ?? null,
    // UAM v1.5: session owner (null on legacy rows → admin-visible only).
    ownerEmail: row.owner_email ?? null,
  };
}

/** shots row (snake_case) → CloudShot wire shape. hasClip = clip_path != null. */
export function shotRowToJson(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    idx: Number(row.idx) || 0,
    type: row.type,
    score: Number(row.score) || 0,
    angles: row.angles ?? null,
    statuses: row.statuses ?? null,
    issues: row.issues ?? [],
    peakWristSpeed: Number(row.peak_wrist_speed) || 0,
    hasClip: row.clip_path != null,
    clipMime: row.clip_mime ?? null,
    hasAudio: row.audio_path != null,
    createdAt: isoOrNull(row.created_at),
  };
}

/**
 * Firestore `sessions/{id}` doc → the SAME CloudSessionSummary wire shape as
 * sessionRowToJson. `data` holds the contract camelCase fields (userName,
 * startedAt, endedAt, avgScore, shotCount, summary); Timestamps are handled by
 * isoOrNull's duck-typed toDate branch. Byte-compatible with the Postgres path.
 */
export function sessionDocToJson(id, data) {
  const d = data ?? {};
  return {
    id,
    userName: d.userName ?? '',
    startedAt: isoOrNull(d.startedAt),
    endedAt: isoOrNull(d.endedAt),
    avgScore: Number(d.avgScore) || 0,
    shotCount: Number(d.shotCount) || 0,
    summary: d.summary ?? null,
    // UAM v1.5: session owner (null/absent on legacy docs → admin-visible only).
    ownerEmail: d.ownerEmail ?? null,
  };
}

/**
 * Firestore `users/{email}` doc → the /api/users wire shape. NEVER includes
 * passSalt/passHash — this mapper is the only thing user-management responses
 * go through, so credentials can't leak by construction.
 */
export function userDocToJson(data) {
  const d = data ?? {};
  return {
    email: d.email ?? '',
    displayName: d.displayName ?? '',
    role: d.role === 'admin' ? 'admin' : 'player',
    disabled: Boolean(d.disabled),
    createdAt: isoOrNull(d.createdAt),
  };
}

/**
 * Firestore `sessions/{id}/shots/{id}` doc → the SAME CloudShot wire shape as
 * shotRowToJson. hasClip/hasAudio derive from clipPath/audioPath being set.
 */
export function shotDocToJson(id, data) {
  const d = data ?? {};
  return {
    id,
    sessionId: d.sessionId,
    idx: Number(d.idx) || 0,
    type: d.type,
    score: Number(d.score) || 0,
    angles: d.angles ?? null,
    statuses: d.statuses ?? null,
    issues: d.issues ?? [],
    peakWristSpeed: Number(d.peakWristSpeed) || 0,
    hasClip: d.clipPath != null,
    clipMime: d.clipMime ?? null,
    hasAudio: d.audioPath != null,
    createdAt: isoOrNull(d.createdAt),
  };
}

const SHOT_TYPES = new Set(['forehand', 'backhand', 'unknown']);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a shot-metadata POST body. Returns {ok, errors}. NEVER accept
 * jpegBase64 stills — the caller strips them before insert; here we only
 * guarantee the metadata shape the DB columns need.
 */
export function validateShotMeta(body) {
  const errors = [];
  if (!isPlainObject(body)) {
    return { ok: false, errors: ['body must be an object'] };
  }
  if (typeof body.idx !== 'number' || !Number.isFinite(body.idx)) {
    errors.push('idx must be a number');
  }
  if (typeof body.type !== 'string' || !SHOT_TYPES.has(body.type)) {
    errors.push('type must be one of forehand|backhand|unknown');
  }
  if (
    typeof body.score !== 'number' ||
    !Number.isFinite(body.score) ||
    body.score < 0 ||
    body.score > 100
  ) {
    errors.push('score must be a number in 0..100');
  }
  if (!isPlainObject(body.angles)) errors.push('angles must be an object');
  if (!isPlainObject(body.statuses)) errors.push('statuses must be an object');
  if (!Array.isArray(body.issues)) errors.push('issues must be an array');
  if (typeof body.peakWristSpeed !== 'number' || !Number.isFinite(body.peakWristSpeed)) {
    errors.push('peakWristSpeed must be a number');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Sanitize the OPTIONAL `usage` block on the end-of-session PATCH body
 * (admin cost visibility). Returns null when absent or malformed — old
 * clients that never send it keep working, and a bad shape is ignored
 * rather than failing the PATCH. Numbers are coerced (Number()||0), and
 * `detail` (free-form modality breakdown) is kept only when it is a plain
 * object — stored as-is otherwise null.
 */
export function sanitizeUsage(usage) {
  if (!isPlainObject(usage)) return null;
  return {
    thb: Number(usage.thb) || 0,
    tokensIn: Number(usage.tokensIn) || 0,
    tokensOut: Number(usage.tokensOut) || 0,
    detail: isPlainObject(usage.detail) ? usage.detail : null,
  };
}

/** Round to 2 decimals for THB display in the /api/usage response. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Fold `usage_records` rows into the GET /api/usage response (admin cost
 * visibility). PURE — the Firestore backend feeds it plain doc data; rows
 * are `{ ownerEmail, userName, thb, tokensIn, tokensOut, playedAt }` where
 * playedAt may be a Date, ISO string or Firestore Timestamp (duck-typed —
 * this file stays import-free). Group key = ownerEmail (null → "(legacy)");
 * each group's userName is the MOST RECENT record's (by playedAt). Users
 * are sorted by thb desc; thb is rounded to 2 decimals in the response.
 *
 * Response: { users: [{ email, userName, thb, tokensIn, tokensOut,
 * sessions }], total: { thb, tokensIn, tokensOut, sessions } }
 */
export function aggregateUsageRows(rows) {
  const byEmail = new Map();
  for (const row of rows ?? []) {
    const email = row?.ownerEmail ?? '(legacy)';
    let g = byEmail.get(email);
    if (!g) {
      g = { email, userName: '', thb: 0, tokensIn: 0, tokensOut: 0, sessions: 0, latestMs: -Infinity };
      byEmail.set(email, g);
    }
    g.thb += Number(row?.thb) || 0;
    g.tokensIn += Number(row?.tokensIn) || 0;
    g.tokensOut += Number(row?.tokensOut) || 0;
    g.sessions += 1;
    // Most-recent record names the group. Rows without a parseable playedAt
    // compare at -Infinity (>= keeps the LAST such row — stable enough for
    // legacy data with no timestamps at all).
    const iso = isoOrNull(row?.playedAt);
    const ms = iso == null ? -Infinity : Date.parse(iso);
    if (ms >= g.latestMs) {
      g.latestMs = ms;
      g.userName = row?.userName ?? '';
    }
  }
  const users = [...byEmail.values()]
    .sort((a, b) => b.thb - a.thb)
    .map(({ email, userName, thb, tokensIn, tokensOut, sessions }) => ({
      email,
      userName,
      thb: round2(thb),
      tokensIn,
      tokensOut,
      sessions,
    }));
  const total = users.reduce(
    (t, u) => ({
      thb: t.thb + u.thb,
      tokensIn: t.tokensIn + u.tokensIn,
      tokensOut: t.tokensOut + u.tokensOut,
      sessions: t.sessions + u.sessions,
    }),
    { thb: 0, tokensIn: 0, tokensOut: 0, sessions: 0 },
  );
  total.thb = round2(total.thb);
  return { users, total };
}

/**
 * The bilingual 503 body returned when the cloud is not configured
 * (no DATABASE_URL / no GCS creds). COPIES the /api/token degradation pattern:
 * the app shows it verbatim and falls back to localStorage stats-only history.
 * `feature` is accepted for symmetry/logging but the message is fixed copy.
 */
export function unavailableBody(feature) {
  void feature;
  return {
    error: 'cloud_unavailable',
    message:
      'Cloud history is not configured (DATABASE_URL / GCS). Sessions stay on this device. / ' +
      'ยังไม่ได้ตั้งค่าระบบคลาวด์ — ประวัติจะถูกเก็บบนเครื่องนี้เท่านั้น',
  };
}

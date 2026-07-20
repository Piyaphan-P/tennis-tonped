// ============================================================================
// ADGE Tennis — Firestore access (metadata only; NO blobs). SIT data layer.
//
// Implements the SAME route-facing interface as pgBackend (server/db.mjs) so
// routes.mjs is backend-agnostic (store.mjs selects one via DB_BACKEND). Clips
// and audio still live in GCS — only metadata is stored here.
//
// Firestore database "nonprd" (native mode, asia-southeast1, project adge-tennis-nonprd).
// TTL is enabled at the PLATFORM level on field `expireAt` for collection
// groups `sessions` and `shots`: we write expireAt = base + 3 days and Firestore
// deletes automatically — there is NO purge job on this path (contrast db.mjs).
// `leaderboard_records` has NO expireAt and is therefore durable forever.
//
// The client is a LAZY singleton (no `new Firestore()` at import time) so that
// Postgres-mode boot — which still statically imports this file via store.mjs —
// pays nothing. `ignoreUndefinedProperties` keeps nested summary/angles objects
// from tripping Firestore's undefined-field rejection.
// ============================================================================

import { Firestore, Timestamp } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import {
  aggregateUsageRows,
  leaderboardScores,
  sessionDocToJson,
  shotDocToJson,
  userDocToJson,
} from './lib.mjs';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'adge-tennis-nonprd';
const DATABASE = process.env.FIRESTORE_DATABASE || 'nonprd';
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const DELETE_BATCH = 400; // well under Firestore's 500-writes/batch limit

/** Lazy singleton — created on first real use, never at import time. */
let _db;
function db() {
  if (_db) return _db;
  _db = new Firestore({
    projectId: PROJECT,
    databaseId: DATABASE,
    ignoreUndefinedProperties: true,
  });
  return _db;
}

/** Firestore Timestamp `base + 3 days` — feeds the platform TTL on `expireAt`. */
function expireFrom(baseMs) {
  return Timestamp.fromMillis(baseMs + THREE_DAYS_MS);
}

/**
 * Resolve a shot by its bare id (the /api/shots/:id/clip|audio routes carry no
 * sessionId, and the frozen contract fixes shotId = uuid, so a collectionGroup
 * lookup is unavoidable — it cannot be refactored away).
 *
 * REQUIRES a COLLECTION_GROUP-scoped single-field index on `shots.id`. Firestore
 * auto-creates single-field indexes only at COLLECTION scope, NOT collection
 * group — so this index must be created manually once (see CLAUDE.md SIT
 * section). Until it exists this query throws FAILED_PRECONDITION, which the
 * clip/audio routes catch and surface as their bilingual 503 (never a crash).
 * The session/shot/history/detail/delete paths do NOT use this query.
 * Returns the DocumentSnapshot (has `.ref`, `.data()`, `.get()`) or null.
 */
async function findShot(shotId) {
  const q = await db().collectionGroup('shots').where('id', '==', shotId).limit(1).get();
  return q.empty ? null : q.docs[0];
}

// ============================================================================
// Route-facing interface (firestoreBackend) — mirrors pgBackend exactly.
// ============================================================================
export const firestoreBackend = {
  name: 'firestore',

  // Firestore is the deliberately-selected backend here; if creds/project are
  // missing the individual calls reject and the route maps that to a 503. So
  // "ready" is always true in firestore mode (cloud history is ON).
  ready: () => true,

  init() {
    console.log(
      `[db] backend=firestore (project=${PROJECT}, database=${DATABASE}); ` +
        `platform TTL on expireAt handles purge — no purge job. cloud history ON`,
    );
  },

  async createSession({ userName, startedAt, ownerEmail }) {
    const id = randomUUID();
    const startedTs = Timestamp.fromDate(startedAt);
    // Every contract field initialized up front: /api/history can list an
    // in-progress session BEFORE its PATCH, so a pre-patch read must already
    // match the Postgres column defaults. ownerEmail (UAM v1.5) is stamped by
    // the route from the auth cookie — never from the client body.
    await db()
      .collection('sessions')
      .doc(id)
      .set({
        userName,
        ownerEmail: ownerEmail ?? null,
        startedAt: startedTs,
        endedAt: null,
        avgScore: 0,
        shotCount: 0,
        summary: null,
        expireAt: expireFrom(startedAt.getTime()),
      });
    return { id };
  },

  async patchSession(id, { endedAt, avgScore, shotCount, summary, usage }) {
    const ref = db().collection('sessions').doc(id);
    const snap = await ref.get();
    // Phantom guard: Postgres UPDATE on a missing id is a silent no-op; a
    // Firestore set(merge) would CREATE the doc. Mirror Postgres — no-op.
    if (!snap.exists) return;
    await ref.update({
      endedAt: endedAt ? Timestamp.fromDate(new Date(endedAt)) : null,
      avgScore: Number(avgScore) || 0,
      shotCount: Number(shotCount) || 0,
      summary: summary != null ? summary : null,
    });
    // Durable leaderboard upsert (see db.mjs). Same shotCount>0 gate + inner
    // best-effort try/catch: a board failure must NOT fail the session PATCH.
    if ((Number(shotCount) || 0) > 0) {
      try {
        const shotsSnap = await ref.collection('shots').get();
        // SECURITY: avgScore AND maxScore for the DURABLE board are recomputed
        // from the STORED shot scores — NEVER from the client-supplied avgScore
        // (spoofable; only display-only on the session doc). Zero shots → skip.
        const scores = shotsSnap.docs.map((d) => Number(d.get('score')) || 0);
        const recomputed = leaderboardScores(scores);
        if (recomputed) {
          const data = snap.data();
          // Doc id = sessionId → idempotent upsert (durable, NO expireAt).
          await db()
            .collection('leaderboard_records')
            .doc(id)
            .set({
              userName: data.userName ?? '',
              avgScore: recomputed.avgScore,
              maxScore: recomputed.maxScore,
              shotCount: Number(shotCount) || 0,
              playedAt: data.startedAt, // session startedAt Timestamp
            });
        }
      } catch (err) {
        console.error('[routes] leaderboard record (non-fatal):', err?.message || err);
      }
    }
    // Durable per-user cost record (admin cost visibility). `usage` arrives
    // already sanitized by the route (lib.sanitizeUsage — null when the client
    // sent none, so old clients are a no-op here). Same pattern as the
    // leaderboard: doc id = sessionId → idempotent upsert, NO expireAt
    // (durable forever), inner best-effort try/catch — a usage write failure
    // must never fail the session PATCH.
    if (usage) {
      try {
        const data = snap.data();
        await db()
          .collection('usage_records')
          .doc(id)
          .set({
            ownerEmail: data.ownerEmail ?? null, // null on legacy sessions
            userName: data.userName ?? '',
            thb: usage.thb,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            detail: usage.detail, // free-form modality breakdown, stored as-is
            shotCount: Number(shotCount) || 0,
            playedAt: data.startedAt, // session startedAt Timestamp
          });
      } catch (err) {
        console.error('[routes] usage record (non-fatal):', err?.message || err);
      }
    }
  },

  /** Admin cost aggregate (GET /api/usage): read ALL usage_records — tiny
   *  scale by design — and fold them through the pure lib helper, which owns
   *  the response shape (grouping, sorting, rounding). */
  async aggregateUsage() {
    const snap = await db().collection('usage_records').get();
    return aggregateUsageRows(snap.docs.map((d) => d.data()));
  },

  async createShot(sessionId, meta) {
    const id = randomUUID();
    const now = Date.now();
    await db()
      .collection('sessions')
      .doc(sessionId)
      .collection('shots')
      .doc(id)
      .set({
        id, // stored for the collectionGroup shot-by-id lookup
        sessionId, // stored so findShot() can resolve the parent
        idx: meta.idx,
        type: meta.type,
        score: meta.score,
        angles: meta.angles,
        statuses: meta.statuses,
        issues: meta.issues,
        peakWristSpeed: meta.peakWristSpeed,
        clipPath: null,
        clipMime: null,
        audioPath: null,
        audioMime: null,
        createdAt: Timestamp.fromMillis(now),
        expireAt: expireFrom(now),
      });
    return { id };
  },

  async getShotSession(shotId) {
    const doc = await findShot(shotId);
    return doc ? doc.get('sessionId') : null;
  },

  /**
   * Single-lookup resolver for the clip/audio routes (findShot #7): ONE
   * collectionGroup scan for the shot + one direct session read for the owner,
   * returning everything those routes need (ownership + existing clip/audio
   * refs). Returns null when the shot does not exist. sessionId lets the
   * setters below write by DIRECT path (no second collectionGroup scan).
   */
  async getShotAccess(shotId) {
    const doc = await findShot(shotId);
    if (!doc) return null;
    const sessionId = doc.get('sessionId');
    const sess = await db().collection('sessions').doc(sessionId).get();
    return {
      sessionId,
      ownerEmail: sess.exists ? sess.get('ownerEmail') ?? null : null,
      clipPath: doc.get('clipPath') ?? null,
      clipMime: doc.get('clipMime') ?? null,
      audioPath: doc.get('audioPath') ?? null,
      audioMime: doc.get('audioMime') ?? null,
    };
  },

  // Writes go by DIRECT doc path (sessionId known from getShotAccess) so the
  // POST clip/audio path does NOT run a second collectionGroup shot scan.
  async setShotClip(sessionId, shotId, path, mime) {
    await db()
      .collection('sessions')
      .doc(sessionId)
      .collection('shots')
      .doc(shotId)
      .update({ clipPath: path, clipMime: mime });
  },

  async setShotAudio(sessionId, shotId, path, mime) {
    await db()
      .collection('sessions')
      .doc(sessionId)
      .collection('shots')
      .doc(shotId)
      .update({ audioPath: path, audioMime: mime });
  },

  async getShotClipRef(shotId) {
    const doc = await findShot(shotId);
    if (!doc) return null;
    const clipPath = doc.get('clipPath');
    if (!clipPath) return null;
    return { clipPath, clipMime: doc.get('clipMime') ?? null };
  },

  async getShotAudioRef(shotId) {
    const doc = await findShot(shotId);
    if (!doc) return null;
    const audioPath = doc.get('audioPath');
    if (!audioPath) return null;
    return { audioPath, audioMime: doc.get('audioMime') ?? null };
  },

  async listHistory(days, { ownerEmail } = {}) {
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    if (ownerEmail) {
      // Owner-filtered path (player, or admin ?email=). Query ONLY the equality
      // on ownerEmail (COLLECTION scope → auto-indexed) and do the startedAt
      // cutoff + DESC sort in memory — the 3-day TTL keeps result sets tiny.
      // NEVER combine where(ownerEmail)+orderBy(startedAt) in one query: that
      // needs a composite index which does not exist and would 503 (this repo
      // already paid that lesson with shots.id).
      const snap = await db().collection('sessions').where('ownerEmail', '==', ownerEmail).get();
      return snap.docs
        .map((d) => sessionDocToJson(d.id, d.data()))
        .filter((s) => s.startedAt && Date.parse(s.startedAt) >= cutoffMs)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    }
    const cutoff = Timestamp.fromMillis(cutoffMs);
    // Range filter + orderBy on the SAME field → single-field index (automatic).
    const snap = await db()
      .collection('sessions')
      .where('startedAt', '>=', cutoff)
      .orderBy('startedAt', 'desc')
      .get();
    return snap.docs.map((d) => sessionDocToJson(d.id, d.data()));
  },

  /** Owner of a session (for PATCH/DELETE authorization without pulling all
   *  shots). Returns { ownerEmail } (null on legacy docs) or null if missing. */
  async getSessionOwner(id) {
    const snap = await db().collection('sessions').doc(id).get();
    if (!snap.exists) return null;
    return { ownerEmail: snap.get('ownerEmail') ?? null };
  },

  /** Resolve a bare shotId → its parent session's owner (clip/audio routes
   *  carry no sessionId). collectionGroup id lookup (same index requirement as
   *  findShot) then one session read. Returns { sessionId, ownerEmail } | null. */
  async getShotOwner(shotId) {
    const doc = await findShot(shotId);
    if (!doc) return null;
    const sessionId = doc.get('sessionId');
    const sess = await db().collection('sessions').doc(sessionId).get();
    return { sessionId, ownerEmail: sess.exists ? sess.get('ownerEmail') ?? null : null };
  },

  async getSessionDetail(id) {
    const ref = db().collection('sessions').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const shotsSnap = await ref.collection('shots').orderBy('idx', 'asc').get();
    return {
      ...sessionDocToJson(snap.id, snap.data()),
      shots: shotsSnap.docs.map((d) => shotDocToJson(d.id, d.data())),
    };
  },

  async deleteSession(id) {
    const ref = db().collection('sessions').doc(id);
    const shotsCol = ref.collection('shots');
    // Delete the shots subcollection in batches, then the session doc.
    // leaderboard_records AND usage_records are durable and left untouched;
    // GCS untouched too.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await shotsCol.limit(DELETE_BATCH).get();
      if (page.empty) break;
      const batch = db().batch();
      page.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (page.size < DELETE_BATCH) break;
    }
    await ref.delete();
  },

  // ==========================================================================
  // Users (UAM v1.5) — collection `users/{email}` (doc id = lowercased email),
  // fields { email, passSalt, passHash, role, displayName, disabled,
  // createdAt:Timestamp }. NO expireAt — accounts are durable (like the
  // leaderboard). Passwords are scrypt hashes only (authCore.mjs) — plaintext
  // never reaches this file.
  // ==========================================================================

  /** Full user doc (INCLUDING passSalt/passHash — login needs them) or null.
   *  Callers must never serialize this to the wire; listUsers is the safe one. */
  async getUser(email) {
    const snap = await db().collection('users').doc(String(email).toLowerCase()).get();
    return snap.exists ? snap.data() : null;
  },

  /** All users in the SAFE wire shape (no credential fields), newest first. */
  async listUsers() {
    const snap = await db().collection('users').get();
    return snap.docs
      .map((d) => userDocToJson(d.data()))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  },

  /** Create a user (role decided by the route — always 'player' via the API).
   *  Caller (route) pre-checks existence for the 409; `create()` still throws
   *  ALREADY_EXISTS on a race, which the route surfaces as its 503. */
  async createUser({ email, passSalt, passHash, displayName, role }) {
    const key = String(email).toLowerCase();
    await db().collection('users').doc(key).create({
      email: key,
      passSalt,
      passHash,
      role: role === 'admin' ? 'admin' : 'player',
      displayName: displayName ?? '',
      disabled: false,
      createdAt: Timestamp.now(),
    });
  },

  /** Patch allowed fields (passSalt/passHash/displayName/disabled). Returns
   *  false when the user does not exist (route → 404) — never upserts. */
  async updateUser(email, patch) {
    const ref = db().collection('users').doc(String(email).toLowerCase());
    const snap = await ref.get();
    if (!snap.exists) return false;
    const allowed = {};
    if (patch.passSalt != null) allowed.passSalt = patch.passSalt;
    if (patch.passHash != null) allowed.passHash = patch.passHash;
    if (patch.displayName != null) allowed.displayName = patch.displayName;
    if (patch.disabled != null) allowed.disabled = Boolean(patch.disabled);
    if (Object.keys(allowed).length > 0) await ref.update(allowed);
    return true;
  },

  /** Delete the account doc ONLY — sessions (TTL cleans up) and leaderboard
   *  rows are deliberately left alone (frozen contract). */
  async deleteUser(email) {
    await db().collection('users').doc(String(email).toLowerCase()).delete();
  },

  /** Boot-time admin upsert (env ADMIN_EMAIL/ADMIN_PASS): idempotent recovery
   *  path — always (re)sets role=admin + the password, re-enables the account,
   *  and fills createdAt/displayName only on first creation. */
  async ensureAdmin({ email, passSalt, passHash }) {
    const key = String(email).toLowerCase();
    const ref = db().collection('users').doc(key);
    const snap = await ref.get();
    await ref.set(
      {
        email: key,
        passSalt,
        passHash,
        role: 'admin',
        disabled: false,
        ...(snap.exists ? {} : { displayName: '', createdAt: Timestamp.now() }),
      },
      { merge: true },
    );
  },
};

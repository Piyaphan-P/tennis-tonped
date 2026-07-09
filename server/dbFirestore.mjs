// ============================================================================
// ADGE Tennis — Firestore access (metadata only; NO blobs). SIT data layer.
//
// Implements the SAME route-facing interface as pgBackend (server/db.mjs) so
// routes.mjs is backend-agnostic (store.mjs selects one via DB_BACKEND). Clips
// and audio still live in GCS — only metadata is stored here.
//
// Firestore database "nonprd" (native mode, asia-southeast1, project ton-team).
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
import { sessionDocToJson, shotDocToJson } from './lib.mjs';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'ton-team';
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

  async createSession({ userName, startedAt }) {
    const id = randomUUID();
    const startedTs = Timestamp.fromDate(startedAt);
    // Every contract field initialized up front: /api/history can list an
    // in-progress session BEFORE its PATCH, so a pre-patch read must already
    // match the Postgres column defaults.
    await db()
      .collection('sessions')
      .doc(id)
      .set({
        userName,
        startedAt: startedTs,
        endedAt: null,
        avgScore: 0,
        shotCount: 0,
        summary: null,
        expireAt: expireFrom(startedAt.getTime()),
      });
    return { id };
  },

  async patchSession(id, { endedAt, avgScore, shotCount, summary }) {
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
        let maxScore = 0;
        shotsSnap.forEach((d) => {
          const s = Number(d.get('score')) || 0;
          if (s > maxScore) maxScore = s;
        });
        const data = snap.data();
        // Doc id = sessionId → idempotent upsert (durable, NO expireAt).
        await db()
          .collection('leaderboard_records')
          .doc(id)
          .set({
            userName: data.userName ?? '',
            avgScore: Number(avgScore) || 0,
            maxScore,
            shotCount: Number(shotCount) || 0,
            playedAt: data.startedAt, // session startedAt Timestamp
          });
      } catch (err) {
        console.error('[routes] leaderboard record (non-fatal):', err?.message || err);
      }
    }
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

  async setShotClip(shotId, path, mime) {
    const doc = await findShot(shotId);
    if (!doc) return;
    await doc.ref.update({ clipPath: path, clipMime: mime });
  },

  async setShotAudio(shotId, path, mime) {
    const doc = await findShot(shotId);
    if (!doc) return;
    await doc.ref.update({ audioPath: path, audioMime: mime });
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

  async listHistory(days) {
    const cutoff = Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000);
    // Range filter + orderBy on the SAME field → single-field index (automatic).
    const snap = await db()
      .collection('sessions')
      .where('startedAt', '>=', cutoff)
      .orderBy('startedAt', 'desc')
      .get();
    return snap.docs.map((d) => sessionDocToJson(d.id, d.data()));
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
    // leaderboard_records is durable and left untouched; GCS untouched too.
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
};

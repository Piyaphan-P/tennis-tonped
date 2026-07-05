// ============================================================================
// ต้นและเพชร Tennis Club — cloud sync orchestrator (fire-and-forget).
//
// Sits between the Live pose loop and api.ts. NEVER blocks the pose loop or
// coaching, NEVER rejects into callers (every path is .catch(()=>{})). If the
// cloud is unavailable, every call is a silent no-op and the app keeps its
// localStorage stats + session-only clips.
//
// Flow per session:
//   startSession       → resetCloudSync()          (clear maps/latch)
//   first shot done    → ensure cloud session, upload shot metadata (retry once)
//   clip finishes      → upload the raw clip blob to the meta'd cloud shot
//   endSession         → PATCH session summary
// ============================================================================

import type { Shot, ShotClip, SessionSummaryJson } from '../types';
import { useAppStore, GOOD_FORM_SCORE, deriveImprovements } from '../store';
import * as api from './api';

const MAX_CLIP_BYTES = 8_000_000;

// local shot id → resolved cloud shot id (once metadata upload succeeds).
const cloudShotIds = new Map<string, string>();
// local shot id → in-flight metadata upload (so a clip can await its shot id).
const metaPromises = new Map<string, Promise<string | null>>();
// Memoized lazy cloud-session creation for the current session (success only).
let sessionPromise: Promise<string | null> | null = null;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Clear all per-session sync state. Called from startSession (via LiveScreen). */
export function resetCloudSync(): void {
  cloudShotIds.clear();
  metaPromises.clear();
  sessionPromise = null;
}

/**
 * Ensure a cloud session exists for the current live session, created lazily on
 * the first shot. Caches ONLY success — a failed create resets so the next shot
 * retries. Returns the cloud session id, or null when the cloud is unavailable.
 */
function ensureSession(): Promise<string | null> {
  if (sessionPromise) return sessionPromise;
  const st = useAppStore.getState();
  const existing = st.cloudSessionId;
  if (existing) {
    sessionPromise = Promise.resolve(existing);
    return sessionPromise;
  }
  const userName = st.settings.userName;
  const startedAtIso = new Date(st.session.startedAtMs || Date.now()).toISOString();
  const p = api
    .createSession(userName, startedAtIso)
    .then((id) => {
      if (id) {
        useAppStore.getState().setCloudSessionId(id);
        return id;
      }
      sessionPromise = null; // allow a later shot to retry
      return null;
    })
    .catch(() => {
      sessionPromise = null;
      return null;
    });
  sessionPromise = p;
  return p;
}

async function uploadMetaRetryOnce(
  sessionId: string,
  shot: Shot,
): Promise<string | null> {
  let id = await api.uploadShotMeta(sessionId, shot);
  if (!id) id = await api.uploadShotMeta(sessionId, shot);
  return id;
}

/** Resolve the cloud shot id for a local shot (map → in-flight meta → poll). */
async function resolveCloudShotId(localShotId: string): Promise<string | null> {
  const known = cloudShotIds.get(localShotId);
  if (known) return known;
  const inflight = metaPromises.get(localShotId);
  if (inflight) return inflight;
  // The clip finished before the meta upload even started — poll briefly.
  for (let i = 0; i < 20; i += 1) {
    await delay(100);
    const hit = cloudShotIds.get(localShotId);
    if (hit) return hit;
    const mp = metaPromises.get(localShotId);
    if (mp) return mp;
  }
  return null;
}

/**
 * A shot completed: ensure the cloud session, upload the shot metadata (retry
 * once), record the id mapping, and — if the clip is already attached — upload
 * it too. Fire-and-forget; never blocks the caller.
 */
export function syncShotCompleted(shot: Shot): void {
  void (async () => {
    const sessionId = await ensureSession();
    if (!sessionId) return;
    const p = uploadMetaRetryOnce(sessionId, shot);
    metaPromises.set(shot.id, p);
    const cloudId = await p;
    if (!cloudId) return;
    cloudShotIds.set(shot.id, cloudId);
    // If the clip already landed on the shot (rare: clip < meta), upload now.
    const shotNow = useAppStore.getState().shots.find((s) => s.id === shot.id);
    const clip = shotNow?.clip;
    if (clip?.blob && clip.blob.size <= MAX_CLIP_BYTES) {
      await api.uploadShotClip(cloudId, clip.blob, clip.mimeType).catch(() => false);
    }
  })().catch(() => {});
}

/**
 * A clip finished recording and was attached to its shot: upload the raw blob
 * to the (possibly still in-flight) cloud shot. Skips blobs > 8MB. Fire-and-
 * forget; never blocks the caller.
 */
export function syncClipAttached(localShotId: string, clip: ShotClip): void {
  void (async () => {
    const blob = clip.blob;
    if (!blob || blob.size > MAX_CLIP_BYTES) return;
    const cloudId = await resolveCloudShotId(localShotId);
    if (!cloudId) return;
    await api.uploadShotClip(cloudId, blob, clip.mimeType);
  })().catch(() => {});
}

/**
 * Session ended: PATCH the cloud session with the summary, computed from the
 * SAME fields as buildStoredSession. State is snapshotted SYNCHRONOUSLY here so
 * a subsequent endSession() can't race the async PATCH. No-op without a cloud
 * session id.
 */
export function syncSessionEnded(): void {
  const s = useAppStore.getState();
  const sessionId = s.cloudSessionId;
  if (!sessionId) return;
  const shots = s.shots;
  const shotCount = shots.length;
  const avgScore =
    shotCount === 0 ? 0 : shots.reduce((sum, sh) => sum + sh.score, 0) / shotCount;
  const goodFormPct =
    shotCount === 0
      ? 0
      : (shots.filter((sh) => sh.score >= GOOD_FORM_SCORE).length / shotCount) * 100;
  const bestPeakWristSpeed =
    shotCount === 0 ? 0 : Math.max(...shots.map((sh) => sh.peakWristSpeed));
  const summary: SessionSummaryJson = {
    durationMs: s.session.startedAtMs ? Date.now() - s.session.startedAtMs : 0,
    goodFormPct,
    bestPeakWristSpeed,
    totalCostTHB: s.cost.breakdown.thbTotal,
    focusShot: s.settings.focusShot,
    improvements: deriveImprovements(shots),
  };
  const endedAtIso = new Date().toISOString();
  void api
    .endSessionCloud(sessionId, endedAtIso, avgScore, shotCount, summary)
    .catch(() => false);
}

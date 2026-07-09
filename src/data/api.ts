// ============================================================================
// ADGE Tennis — cloud sync HTTP client (FROZEN CONTRACT).
//
// Same-origin /api/* calls (dev proxies to :8080 via vite.config). NONE of
// these functions throw: any network error or a 503 flips a module-level
// offline latch for 60s, and every function returns null/false fast while
// latched — so the UI silently falls back to localStorage stats + session-only
// clips and we never spam fetch at a cloud that isn't there.
//
// NOTE (statuses derivation): the frozen uploadShotMeta(sessionId, shot)
// signature carries no AngleStatuses (Shot has none), so — per the contract's
// "derive via evaluateAngleStatuses(contactAngles, hand, 'contact')" — the
// derivation runs HERE when building the POST body, reusing the canonical
// store function + the current dominantHand. This avoids schema drift.
// ============================================================================

import type {
  CloudSessionDetail,
  CloudSessionSummary,
  Shot,
  SessionSummaryJson,
} from '../types';
import { evaluateAngleStatuses, useAppStore } from '../store';

// ---------------------------------------------------------------------------
// Offline latch (60s recheck window)
// ---------------------------------------------------------------------------

const OFFLINE_WINDOW_MS = 60_000;
/** 0 = online; otherwise the Date.now() ms until which we stay latched offline. */
let offlineUntil = 0;

function isOffline(): boolean {
  if (offlineUntil === 0) return false;
  if (Date.now() >= offlineUntil) {
    offlineUntil = 0; // window elapsed — allow one probe
    return false;
  }
  return true;
}

function latchOffline(): void {
  offlineUntil = Date.now() + OFFLINE_WINDOW_MS;
}

function markOnline(): void {
  offlineUntil = 0;
}

/**
 * fetch wrapper: returns the Response on 2xx, or null on any failure. A 503
 * (cloud not configured / server DB error) OR a thrown network error latches
 * offline for 60s. Never throws.
 */
async function safeFetch(input: string, init?: RequestInit): Promise<Response | null> {
  if (isOffline()) return null;
  try {
    const res = await fetch(input, init);
    if (res.status === 503) {
      latchOffline();
      return null;
    }
    if (!res.ok) {
      // 4xx/5xx other than 503: don't latch (it's a request-level problem),
      // but treat as failure for this call.
      return null;
    }
    markOnline();
    return res;
  } catch {
    latchOffline();
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** True while the cloud is reachable (not currently latched offline). */
export function isCloudAvailable(): boolean {
  return !isOffline();
}

/** POST /api/sessions — returns the new session id, or null when offline. */
export async function createSession(
  userName: string,
  startedAtIso: string,
): Promise<string | null> {
  const res = await safeFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName, startedAt: startedAtIso }),
  });
  if (!res) return null;
  try {
    const data = (await res.json()) as { id?: string };
    return typeof data.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}

/** PATCH /api/sessions/:id — end + summary. Returns true on success. */
export async function endSessionCloud(
  id: string,
  endedAtIso: string,
  avgScore: number,
  shotCount: number,
  summary: SessionSummaryJson,
): Promise<boolean> {
  const res = await safeFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endedAt: endedAtIso, avgScore, shotCount, summary }),
  });
  return res !== null;
}

/** POST /api/sessions/:id/shots — metadata only. Returns cloud shot id. */
export async function uploadShotMeta(
  sessionId: string,
  shot: Shot,
): Promise<string | null> {
  // Derive contact-time statuses here (see file header note).
  const hand = useAppStore.getState().settings.dominantHand;
  const statuses = evaluateAngleStatuses(shot.contactAngles, hand, 'contact');
  const body = {
    idx: shot.index,
    type: shot.type,
    score: shot.score,
    angles: shot.contactAngles,
    statuses,
    issues: shot.issues,
    peakWristSpeed: shot.peakWristSpeed,
  };
  const res = await safeFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/shots`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res) return null;
  try {
    const data = (await res.json()) as { id?: string };
    return typeof data.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}

/** POST /api/shots/:id/clip — raw body. Skips >8MB. Returns true on success. */
export async function uploadShotClip(
  cloudShotId: string,
  blob: Blob,
  mimeType: string,
): Promise<boolean> {
  if (blob.size > 8_000_000) return false;
  const res = await safeFetch(`/api/shots/${encodeURIComponent(cloudShotId)}/clip`, {
    method: 'POST',
    headers: { 'Content-Type': mimeType || 'application/octet-stream' },
    body: blob,
  });
  return res !== null;
}

/**
 * POST /api/shots/:id/audio — raw WAV body (the coach's spoken critique). Skips
 * >8MB. Returns true on success. Mirrors uploadShotClip.
 */
export async function uploadShotAudio(
  cloudShotId: string,
  blob: Blob,
): Promise<boolean> {
  if (blob.size > 8_000_000) return false;
  const res = await safeFetch(`/api/shots/${encodeURIComponent(cloudShotId)}/audio`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/wav' },
    body: blob,
  });
  return res !== null;
}

/** Same-origin URL that streams a shot's coach-audio WAV through the server. */
export function audioUrl(cloudShotId: string): string {
  return `/api/audio/${encodeURIComponent(cloudShotId)}`;
}

/** GET /api/history?days=3 — session list, or null when offline. */
export async function fetchHistory(days = 3): Promise<CloudSessionSummary[] | null> {
  const res = await safeFetch(`/api/history?days=${encodeURIComponent(String(days))}`);
  if (!res) return null;
  try {
    return (await res.json()) as CloudSessionSummary[];
  } catch {
    return null;
  }
}

/** GET /api/sessions/:id — full detail incl shots, or null when offline. */
export async function fetchSessionDetail(
  id: string,
): Promise<CloudSessionDetail | null> {
  const res = await safeFetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res) return null;
  try {
    return (await res.json()) as CloudSessionDetail;
  } catch {
    return null;
  }
}

/** Same-origin URL that streams a shot's clip through the server. */
export function clipUrl(cloudShotId: string): string {
  return `/api/clips/${encodeURIComponent(cloudShotId)}`;
}

/**
 * DELETE /api/sessions/:id — drops the DB rows only; GCS clip objects are left
 * for the bucket's 3-day lifecycle rule to reap. Returns true on success.
 */
export async function deleteSessionCloud(id: string): Promise<boolean> {
  const res = await safeFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return res !== null;
}

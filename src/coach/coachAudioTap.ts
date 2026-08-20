// ============================================================================
// ADGE Tennis — coach audio tap (persist the spoken critique).
//
// The Gemini Live coach streams native-audio PCM per turn (24 kHz / 16-bit LE
// / mono). We ALREADY receive & play these bytes, so capturing them costs ZERO
// extra Gemini tokens: liveClient forwards every coach PCM chunk here, and when
// a turn finalizes for a shot we wrap the accumulated PCM in a WAV header and
// fire-and-forget it to the cloud (GCS via cloudSync). A capped module-level
// Map also keeps the finished Blob for same-session use (e.g. the story/share
// exporter) without a cloud round-trip.
//
// liveClient wires exactly three calls (see the coachAudioTap contract):
//   onChunk(base64Pcm)      — every coach audio chunk of the current turn
//   finalizeForShot(shotId) — turn done for this shot → encode + upload + keep
//   discard()               — interrupted / no pending shot / disconnect → drop
//
// Every method is synchronous-safe, self-catching, and never throws or blocks
// the pose loop.
// ============================================================================

import { base64ToBytes, encodeWavBlob } from './wavEncode';
import { syncCoachAudio } from '../data/cloudSync';

/** Max finished-audio Blobs retained in-memory this session (oldest evicted). */
const MAX_KEPT = 20;

/** PCM chunks accumulated for the in-flight turn (raw 16-bit LE mono bytes). */
let accumulator: Uint8Array[] = [];

/** localShotId → finished coach-audio WAV Blob (session-only, capped). */
const audioByShot = new Map<string, Blob>();

/** Retrieve a finished coach-audio WAV Blob for a local shot (same session). */
export function getCoachAudioBlob(localShotId: string): Blob | undefined {
  return audioByShot.get(localShotId);
}

function keepBlob(localShotId: string, blob: Blob): void {
  // Refresh insertion order so a re-finalize doesn't get evicted early.
  if (audioByShot.has(localShotId)) audioByShot.delete(localShotId);
  audioByShot.set(localShotId, blob);
  while (audioByShot.size > MAX_KEPT) {
    const oldest = audioByShot.keys().next().value;
    if (oldest === undefined) break;
    audioByShot.delete(oldest);
  }
}

export const coachAudioTap = {
  /** Accumulate one coach PCM chunk (base64, 24 kHz 16-bit LE mono). */
  onChunk(base64Pcm: string): void {
    try {
      const bytes = base64ToBytes(base64Pcm);
      if (bytes.length > 0) accumulator.push(bytes);
    } catch {
      // never throw into the audio path
    }
  },

  /**
   * The coach's turn completed for this shot: encode the accumulated PCM to a
   * WAV Blob, keep it in-memory (capped), fire-and-forget the cloud upload, then
   * clear the accumulator. Empty accumulator → no-op (nothing was spoken).
   */
  finalizeForShot(localShotId: string): void {
    try {
      const chunks = accumulator;
      accumulator = [];
      if (chunks.length === 0) return;
      const blob = encodeWavBlob(chunks);
      if (!blob) return;
      keepBlob(localShotId, blob);
      // Fire-and-forget; syncCoachAudio never throws / never blocks.
      syncCoachAudio(localShotId, blob);
    } catch {
      accumulator = [];
    }
  },

  /** Turn interrupted / no pending shot / disconnect → drop accumulated PCM. */
  discard(): void {
    accumulator = [];
  },
};

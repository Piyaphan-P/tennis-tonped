// ============================================================================
// ADGE Tennis — swing-clip recorder (composite video: camera +
// burned-in colored skeleton)
//
// No React. Imperative module in the style of poseLandmarker.ts. One instance
// per Live session, constructed AFTER getUserMedia resolves so video.videoWidth
// is known. The shot detector drives its lifecycle via LiveScreen:
//
//   idle -> preparation   ⇒ startSwing()   (arm a fresh MediaRecorder)
//   every pose tick       ⇒ drawFrame()    (composite one frame while recording)
//   swing completed        ⇒ finishSwing()  (resolve a ShotClip)
//   swing discarded        ⇒ discardSwing() (drop chunks, no URL)
//   effect cleanup         ⇒ dispose()      (discard + release stream)
//
// SESSION-ONLY: finishSwing() mints a blob: object URL AND retains the encoded
// Blob (ShotClip.blob) so cloudSync can upload it to GCS this session. The store
// owns their lifetime (URL revoked + blob dropped on eviction / endSession /
// startSession). Clips are NEVER persisted to localStorage — the durable
// artifacts remain the still SwingCaptures.
//
// GRACEFUL DEGRADATION: every browser-media API touch is behind the `supported`
// flag + try/catch. In jsdom/node (no MediaRecorder / captureStream) the whole
// recorder no-ops and the app keeps its stills. Never throws into the pose loop.
// ============================================================================

import { drawSkeleton } from './captureRenderer';
import type { AngleStatuses, DominantHand, PoseFrame, ShotClip } from '../types';

// ---------------------------------------------------------------------------
// mimeType negotiation
// ---------------------------------------------------------------------------

/**
 * Preferred container/codec chain. mp4/avc1 first for iOS Safari (which only
 * records mp4 and on older versions lacks isTypeSupported), then WebM/VP9→VP8.
 */
const MIME_CHAIN = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/** Default MediaRecorder.isTypeSupported probe, guarded for non-browser envs. */
export function defaultIsTypeSupported(t: string): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported(t)
  );
}

/**
 * First supported mimeType in MIME_CHAIN, or null if none. The predicate is
 * injectable so vitest can unit-test the chain without any DOM.
 */
export function pickRecorderMimeType(
  isSupported: (t: string) => boolean = defaultIsTypeSupported,
): string | null {
  for (const t of MIME_CHAIN) {
    try {
      if (isSupported(t)) return t;
    } catch {
      /* a throwing probe just means "not this one" */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recording tunables (phone-friendly: small canvas, hardware-friendly bitrate)
// ---------------------------------------------------------------------------

export const CLIP_MAX_MS = 6000;
export const CLIP_TARGET_WIDTH = 480;
export const CLIP_FPS = 30;
export const CLIP_BITS_PER_SECOND = 1_800_000;

// ---------------------------------------------------------------------------
// SwingRecorder
// ---------------------------------------------------------------------------

export class SwingRecorder {
  private readonly video: HTMLVideoElement;

  /** True only if MediaRecorder + a working mimeType + canvas.captureStream
   *  are all present. Latched at construction; any probe throw ⇒ false forever. */
  readonly supported: boolean;

  /** Negotiated container/codec ('' when unsupported). */
  private readonly mimeType: string;

  // Lazily created on first startSwing (video.videoWidth may be 0 at construct).
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private stream: MediaStream | null = null;

  // Per-swing recorder state.
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** True between startSwing() and finishSwing()/discardSwing(). */
  private recording = false;
  private startedAtMs = 0;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolves when the current recorder's onstop fires (or immediately if none). */
  private stopped: Promise<void> | null = null;
  private resolveStopped: (() => void) | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    let ok = false;
    let mime = '';
    try {
      const picked = pickRecorderMimeType();
      ok =
        picked !== null &&
        typeof HTMLCanvasElement !== 'undefined' &&
        typeof HTMLCanvasElement.prototype.captureStream === 'function';
      mime = picked ?? '';
    } catch {
      ok = false;
      mime = '';
    }
    this.supported = ok;
    this.mimeType = mime;
  }

  /**
   * Composite one frame (downscaled video + colored skeleton) into the
   * recording canvas. No-op unless supported AND currently recording, so idle
   * battery cost is zero. Never throws into the pose loop.
   */
  drawFrame(frame: PoseFrame, statuses: AngleStatuses | null, hand: DominantHand): void {
    if (!this.supported || !this.recording) return;
    try {
      const canvas = this.canvas;
      const ctx = this.ctx;
      if (!canvas || !ctx) return;
      ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      drawSkeleton(ctx, canvas.width, canvas.height, frame.landmarks, statuses, hand, false);
    } catch {
      /* a failed composite just drops one frame — never break detection */
    }
  }

  /**
   * Arm a FRESH MediaRecorder for one swing. No-op if unsupported or already
   * recording. Fresh instance + start() with no timeslice (single final chunk)
   * keeps mp4 containers valid and dodges iOS pause/resume flakiness.
   */
  startSwing(): void {
    if (!this.supported || this.recording) return;
    try {
      const video = this.video;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return; // camera not ready — keep stills, no clip

      const scale = Math.min(1, CLIP_TARGET_WIDTH / vw);
      const w = Math.max(1, Math.round(vw * scale));
      const h = Math.max(1, Math.round(vh * scale));

      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
      }
      const canvas = this.canvas;
      canvas.width = w;
      canvas.height = h;
      this.ctx = canvas.getContext('2d');
      if (!this.ctx) return;

      if (!this.stream) {
        this.stream = canvas.captureStream(CLIP_FPS);
      }

      // Paint one immediate frame so the first encoded frame isn't black.
      try {
        this.ctx.drawImage(video, 0, 0, w, h);
      } catch {
        /* video not paintable yet — first frame may be blank, that's fine */
      }

      this.chunks = [];
      const recorder = new MediaRecorder(this.stream, {
        mimeType: this.mimeType,
        videoBitsPerSecond: CLIP_BITS_PER_SECOND,
      });
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      this.stopped = new Promise<void>((res) => {
        this.resolveStopped = res;
      });
      recorder.onstop = () => {
        this.resolveStopped?.();
      };
      recorder.start(); // NO timeslice → single final chunk
      this.recorder = recorder;
      this.startedAtMs = performance.now();
      this.recording = true;

      // Hard cap: stop the recorder but leave chunks pending so a late
      // finishSwing() still resolves the capped clip.
      this.capTimer = setTimeout(() => {
        try {
          if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
        } catch {
          /* ignore */
        }
      }, CLIP_MAX_MS);
    } catch {
      // Any failure arming the recorder ⇒ this swing simply has no clip.
      this.clearCapTimer();
      this.recording = false;
      this.recorder = null;
      this.chunks = [];
    }
  }

  /**
   * Resolve the recorded clip, or null. Resolves after the recorder's onstop
   * (or immediately if the cap already stopped it), bounded by a 1s safety
   * timeout. Never rejects.
   */
  async finishSwing(): Promise<ShotClip | null> {
    if (!this.supported || !this.recorder) {
      this.clearCapTimer();
      this.recording = false;
      return null;
    }
    const recorder = this.recorder;
    try {
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      await Promise.race([
        this.stopped ?? Promise.resolve(),
        new Promise<void>((res) => setTimeout(res, 1000)),
      ]);

      this.clearCapTimer();
      this.recording = false;
      this.recorder = null;

      const chunks = this.chunks;
      this.chunks = [];
      if (chunks.length === 0) return null;

      const blob = new Blob(chunks, { type: this.mimeType });
      if (blob.size === 0) return null;

      const canvas = this.canvas;
      return {
        url: URL.createObjectURL(blob),
        mimeType: this.mimeType,
        durationMs: Math.min(performance.now() - this.startedAtMs, CLIP_MAX_MS),
        sizeBytes: blob.size,
        width: canvas ? canvas.width : 0,
        height: canvas ? canvas.height : 0,
        // Retained for this session's cloud upload (never serialized).
        blob,
      };
    } catch {
      this.clearCapTimer();
      this.recording = false;
      this.recorder = null;
      this.chunks = [];
      return null;
    }
  }

  /** Abort the current swing: stop the recorder, drop chunks, mint no URL. */
  discardSwing(): void {
    this.clearCapTimer();
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* ignore */
    }
    this.recorder = null;
    this.chunks = [];
    this.recording = false;
  }

  /** Release everything. Called from the LiveScreen effect cleanup. */
  dispose(): void {
    this.discardSwing();
    try {
      this.stream?.getTracks().forEach((tr) => tr.stop());
    } catch {
      /* ignore */
    }
    this.stream = null;
    this.canvas = null;
    this.ctx = null;
  }

  private clearCapTimer(): void {
    if (this.capTimer !== null) {
      clearTimeout(this.capTimer);
      this.capTimer = null;
    }
  }
}

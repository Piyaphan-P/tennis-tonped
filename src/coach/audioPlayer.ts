// ============================================================================
// ต้นและเพชร Tennis Club (Ton & Phet Tennis Club) — coach audio player
//
// Gapless PCM playback queue for โค้ชต้นและเพชร's spoken replies.
// Input format (from Gemini native-audio Live): PCM 24000 Hz, 16-bit LE, mono,
// base64-encoded (no data: prefix).
//
// The Live server streams the coach's voice as many small base64 PCM chunks.
// We decode each chunk to a Float32 AudioBuffer and schedule it back-to-back on
// a single AudioContext timeline so playback is seamless (no clicks/gaps).
//
// iOS Safari requires the AudioContext to be created/resumed inside a user
// gesture — the Live screen calls unlock() on the "start session" tap.
//
// No React here; store writes are limited to coach.speaking + marking the
// latest shot's coaching audioPlayed flag.
// ============================================================================

import { appStore, selectLatestShot } from '../store';

/** Native-audio output sample rate, per verified spike facts. */
const OUTPUT_SAMPLE_RATE = 24000;

type AudioCtxCtor = typeof AudioContext;

function resolveAudioContextCtor(): AudioCtxCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioCtxCtor;
    webkitAudioContext?: AudioCtxCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** base64 -> Uint8Array (browser atob). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  /** Next timeline position (seconds, ctx clock) to schedule a buffer at. */
  private nextStartTime = 0;
  /** Sources that are scheduled/playing but not yet ended. */
  private activeSources = new Set<AudioBufferSourceNode>();
  /** True between the first chunk of a burst and the last onended. */
  private speaking = false;

  /**
   * Create/resume the AudioContext. MUST run inside a user gesture (the Live
   * screen calls this on the session-start tap) so iOS Safari allows playback.
   */
  async unlock(): Promise<void> {
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return;
    if (!this.ctx) {
      // Request 24kHz so decoded buffers play at native rate without resampling.
      try {
        this.ctx = new Ctor({ sampleRate: OUTPUT_SAMPLE_RATE });
      } catch {
        // Some browsers reject a forced sampleRate; fall back to default.
        this.ctx = new Ctor();
      }
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore — will retry on next enqueue */
      }
    }
  }

  /**
   * Decode one base64 PCM chunk and schedule it for gapless playback.
   * Called once per inlineData audio part from the Live message stream.
   */
  enqueue(base64: string): void {
    if (!base64) return;
    // Lazily ensure a context exists even if unlock() was skipped; on iOS this
    // may stay suspended until a gesture, which is acceptable (chunks queue).
    if (!this.ctx) {
      const Ctor = resolveAudioContextCtor();
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ sampleRate: OUTPUT_SAMPLE_RATE });
      } catch {
        this.ctx = new Ctor();
      }
    }
    const ctx = this.ctx;
    if (ctx.state === 'suspended') {
      // Best-effort resume; ignore rejection (needs a gesture on iOS).
      void ctx.resume().catch(() => undefined);
    }

    const bytes = base64ToBytes(base64);
    // Interpret as 16-bit little-endian signed PCM. Guard odd byte lengths.
    const usableBytes = bytes.byteLength - (bytes.byteLength % 2);
    if (usableBytes <= 0) return;
    const sampleCount = usableBytes / 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, usableBytes);
    const float = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      float[i] = view.getInt16(i * 2, true) / 32768;
    }

    const buffer = ctx.createBuffer(1, sampleCount, OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(float, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Schedule immediately after whatever is already queued (gapless).
    const startAt = Math.max(ctx.currentTime, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;

    if (!this.speaking) {
      this.speaking = true;
      appStore.getState().setCoachSpeaking(true);
    }

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) {
        this.speaking = false;
        appStore.getState().setCoachSpeaking(false);
        this.markLatestCoachingPlayed();
      }
    };

    source.start(startAt);
  }

  /**
   * Hard-stop all scheduled/playing audio and reset the timeline. Used on
   * disconnect and when the user starts talking (don't talk over the coach).
   */
  stop(): void {
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.activeSources.clear();
    this.nextStartTime = this.ctx ? this.ctx.currentTime : 0;
    if (this.speaking) {
      this.speaking = false;
      appStore.getState().setCoachSpeaking(false);
    }
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Flip the most recent shot's coaching.audioPlayed to true, if present. */
  private markLatestCoachingPlayed(): void {
    const state = appStore.getState();
    const latest = selectLatestShot(state);
    if (latest?.coaching && !latest.coaching.audioPlayed) {
      state.updateShot(latest.id, {
        coaching: { ...latest.coaching, audioPlayed: true },
      });
    }
  }
}

export const audioPlayer = new AudioPlayer();

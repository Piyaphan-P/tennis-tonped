// ============================================================================
// ADGE Tennis — always-on microphone capture
//
// Captures the student's voice CONTINUOUSLY and emits PCM 16000 Hz, 16-bit LE,
// mono chunks as base64 strings, ready for session.sendRealtimeInput({ audio }).
// There is no push-to-talk: the stream stays open for the whole session and
// Gemini's native-audio Live model does server-side voice-activity detection
// (VAD) to decide when the student starts/stops talking.
//
// The browser mic runs at the hardware rate (often 48000 Hz); we downsample to
// 16000 Hz by linear interpolation, quantize to Int16, and base64-encode.
//
// In parallel we compute a smoothed input LEVEL (RMS → EMA, throttled to ~10Hz)
// and hand it to the optional onLevel callback so the UI can show a live
// "listening" meter and liveClient can duck the coach on barge-in.
//
// Uses an AudioWorklet when trivially available, otherwise falls back to a
// ScriptProcessorNode (deprecated but universally supported — acceptable for
// Phase 1). No React, no store writes — liveClient owns the listening flag and
// orchestrates audioPlayer.stop().
// ============================================================================

/** Target input sample rate required by the Live API. */
const TARGET_SAMPLE_RATE = 16000;
const SCRIPT_PROCESSOR_BUFFER = 4096;

/** EMA smoothing factor for the level meter (weight of the newest RMS sample). */
const LEVEL_EMA_ALPHA = 0.3;
/** Minimum spacing between onLevel emits (~10Hz), independent of buffer size. */
const LEVEL_EMIT_INTERVAL_MS = 100;

/** Monotonic clock, robust in non-browser test envs. */
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Typed error thrown when the user denies microphone permission. */
export class MicPermissionError extends Error {
  readonly code = 'mic-denied' as const;
  constructor(message = 'mic-denied') {
    super(message);
    this.name = 'MicPermissionError';
  }
}

type AudioCtxCtor = typeof AudioContext;

function resolveAudioContextCtor(): AudioCtxCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioCtxCtor;
    webkitAudioContext?: AudioCtxCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Downsample a mono Float32 buffer from srcRate to TARGET_SAMPLE_RATE (linear). */
function downsample(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate === TARGET_SAMPLE_RATE) return input;
  const ratio = srcRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Float32 [-1,1] -> Int16 LE bytes. */
function floatToInt16Bytes(float: Float32Array): Uint8Array {
  const out = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const s = Math.max(-1, Math.min(1, float[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

/** Uint8Array -> base64, chunked to avoid call-stack overflow on large buffers. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private active = false;
  /** EMA-smoothed RMS level (0..1) carried across buffers. */
  private levelEma = 0;
  /** Clock of the last onLevel emit (for ~10Hz throttling). */
  private lastLevelEmitMs = 0;

  /**
   * Start capturing. onChunk receives base64 PCM16k mono chunks (~85ms each).
   * onLevel (optional) receives a smoothed input level in [0..1], throttled to
   * ~10Hz, for the always-on "listening" meter and barge-in ducking.
   * Throws MicPermissionError on permission denial.
   */
  async start(
    onChunk: (base64: string) => void,
    onLevel?: (level: number) => void,
  ): Promise<void> {
    if (this.active) return;
    this.levelEma = 0;
    this.lastLevelEmitMs = 0;

    const Ctor = resolveAudioContextCtor();
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      throw new MicPermissionError('mic-unavailable');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (e) {
      throw new MicPermissionError(
        (e as Error)?.name === 'NotAllowedError' ? 'mic-denied' : String((e as Error)?.message ?? e),
      );
    }

    this.stream = stream;
    this.ctx = new Ctor();
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore — checked below */
      }
    }
    // On iOS Safari a context created outside a user gesture (we auto-start the
    // mic after the WS connects) can stay 'suspended' even after resume() —
    // onaudioprocess would never fire, leaving a dead "Listening…" meter that
    // streams nothing. Fail loudly instead: liveClient flips the toggle off and
    // surfaces error.micDenied, and the next mic tap (a real gesture) succeeds.
    if (this.ctx.state !== 'running') {
      try {
        stream.getTracks().forEach((t) => t.stop());
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
      this.stream = null;
      throw new MicPermissionError('mic-suspended');
    }

    const srcRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(stream);

    // ScriptProcessorNode: deprecated but reliable and dependency-free for
    // Phase 1. An AudioWorklet would need a separate module file to be "trivial";
    // it is not, so we use the fallback path deliberately.
    const processor = this.ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    this.processor = processor;

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.active) return;
      const channel = event.inputBuffer.getChannelData(0);
      // Copy: the underlying buffer is reused by the audio thread.
      const frame = new Float32Array(channel.length);
      frame.set(channel);
      const down = downsample(frame, srcRate);
      const bytes = floatToInt16Bytes(down);
      onChunk(bytesToBase64(bytes));

      // Level metering (RMS → EMA → throttled ~10Hz). Computed on the raw frame
      // so it reflects true input energy regardless of the downsample ratio.
      if (onLevel) {
        let sumSq = 0;
        for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
        const rms = frame.length > 0 ? Math.sqrt(sumSq / frame.length) : 0;
        this.levelEma = LEVEL_EMA_ALPHA * rms + (1 - LEVEL_EMA_ALPHA) * this.levelEma;
        const t = nowMs();
        if (t - this.lastLevelEmitMs >= LEVEL_EMIT_INTERVAL_MS) {
          this.lastLevelEmitMs = t;
          onLevel(Math.max(0, Math.min(1, this.levelEma)));
        }
      }
    };

    this.source.connect(processor);
    // A destination connection is required for onaudioprocess to fire in some
    // browsers; the node outputs silence so nothing is actually heard.
    processor.connect(this.ctx.destination);

    this.active = true;
  }

  /** Stop capture and release the microphone. */
  stop(): void {
    this.active = false;
    this.levelEma = 0;
    this.lastLevelEmitMs = 0;
    if (this.processor) {
      try {
        this.processor.onaudioprocess = null;
        this.processor.disconnect();
      } catch {
        /* ignore */
      }
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      this.stream = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close().catch(() => undefined);
    }
  }

  isActive(): boolean {
    return this.active;
  }
}

export const mic = new Mic();

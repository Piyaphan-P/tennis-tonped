// ============================================================================
// ต้นและเพชร Tennis Club (Ton & Phet Tennis Club) — microphone capture for "Ask Coach" push-to-talk
//
// Captures the student's voice and emits PCM 16000 Hz, 16-bit LE, mono chunks
// as base64 strings, ready for session.sendRealtimeInput({ audio: {...} }).
//
// The browser mic runs at the hardware rate (often 48000 Hz); we downsample to
// 16000 Hz by linear interpolation, quantize to Int16, and base64-encode.
//
// Uses an AudioWorklet when trivially available, otherwise falls back to a
// ScriptProcessorNode (deprecated but universally supported — acceptable for
// Phase 1). No React, no store writes — liveClient owns the listening flag and
// orchestrates audioPlayer.stop().
// ============================================================================

/** Target input sample rate required by the Live API. */
const TARGET_SAMPLE_RATE = 16000;
const SCRIPT_PROCESSOR_BUFFER = 4096;

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

  /**
   * Start capturing. onChunk receives base64 PCM16k mono chunks (~85ms each).
   * Throws MicPermissionError on permission denial.
   */
  async start(onChunk: (base64: string) => void): Promise<void> {
    if (this.active) return;

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
        /* ignore */
      }
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

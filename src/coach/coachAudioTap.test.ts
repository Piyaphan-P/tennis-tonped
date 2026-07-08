// ============================================================================
// ต้นและเพชร Tennis Club — coach audio tap + WAV encoder tests.
//
// Covers:
//   • encodeWavPcm16      — RIFF/WAVE header bytes, sizes, empty → null
//   • base64ToBytes       — round-trip + bad input tolerance
//   • coachAudioTap       — accumulate → finalize (encode + keep + upload),
//                           empty finalize no-op, discard drops, map cap evict
//
// cloudSync is mocked so the tap can be exercised without the store / network.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  encodeWavPcm16,
  encodeWavBlob,
  COACH_SAMPLE_RATE,
} from './wavEncode';

// Mock the cloud sync so finalizeForShot's fire-and-forget upload is observable
// and never touches the store / fetch.
const syncCoachAudio = vi.fn();
vi.mock('../data/cloudSync', () => ({
  syncCoachAudio: (...args: unknown[]) => syncCoachAudio(...args),
}));

import { coachAudioTap, getCoachAudioBlob } from './coachAudioTap';

// --- helpers ---------------------------------------------------------------

/** base64 of `n` bytes all equal to `val`. */
function b64Bytes(n: number, val = 1): string {
  const bytes = new Uint8Array(n).fill(val);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function readU32LE(bytes: Uint8Array, off: number): number {
  return new DataView(bytes.buffer).getUint32(off, true);
}
function readU16LE(bytes: Uint8Array, off: number): number {
  return new DataView(bytes.buffer).getUint16(off, true);
}
function ascii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(bytes[off + i]);
  return s;
}

// ---------------------------------------------------------------------------
// wavEncode
// ---------------------------------------------------------------------------

describe('base64ToBytes', () => {
  it('round-trips PCM bytes', () => {
    const out = base64ToBytes(b64Bytes(5, 7));
    expect(Array.from(out)).toEqual([7, 7, 7, 7, 7]);
  });

  it('empty / bad input → empty array (never throws)', () => {
    expect(base64ToBytes('').length).toBe(0);
    // atob throws on non-base64; we swallow it.
    expect(base64ToBytes('!!!not base64!!!').length).toBe(0);
    // @ts-expect-error deliberate wrong type
    expect(base64ToBytes(null).length).toBe(0);
  });
});

describe('encodeWavPcm16', () => {
  it('empty input → null (nothing to save)', () => {
    expect(encodeWavPcm16([])).toBeNull();
    expect(encodeWavPcm16([new Uint8Array(0)])).toBeNull();
    expect(encodeWavBlob([])).toBeNull();
  });

  it('writes a canonical 44-byte PCM16 mono 24kHz header', () => {
    const data = new Uint8Array(100).fill(3);
    const wav = encodeWavPcm16([data])!;
    expect(wav).not.toBeNull();
    expect(wav.length).toBe(44 + 100);

    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(readU32LE(wav, 4)).toBe(36 + 100); // chunkSize
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(readU32LE(wav, 16)).toBe(16); // subchunk1Size
    expect(readU16LE(wav, 20)).toBe(1); // PCM
    expect(readU16LE(wav, 22)).toBe(1); // mono
    expect(readU32LE(wav, 24)).toBe(COACH_SAMPLE_RATE); // 24000
    expect(readU32LE(wav, 28)).toBe(COACH_SAMPLE_RATE * 2); // byteRate = sr*1*2
    expect(readU16LE(wav, 32)).toBe(2); // blockAlign
    expect(readU16LE(wav, 34)).toBe(16); // bitsPerSample
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(readU32LE(wav, 40)).toBe(100); // dataSize
  });

  it('concatenates multiple chunks in order after the header', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const wav = encodeWavPcm16([a, b])!;
    expect(readU32LE(wav, 40)).toBe(5);
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// coachAudioTap
// ---------------------------------------------------------------------------

describe('coachAudioTap', () => {
  beforeEach(() => {
    syncCoachAudio.mockClear();
    coachAudioTap.discard(); // clear any residual accumulator between tests
  });

  it('accumulates chunks then finalize encodes, keeps, and uploads once', async () => {
    coachAudioTap.onChunk(b64Bytes(10, 9));
    coachAudioTap.onChunk(b64Bytes(20, 9));
    coachAudioTap.finalizeForShot('shot-A');

    expect(syncCoachAudio).toHaveBeenCalledTimes(1);
    const [id, blob] = syncCoachAudio.mock.calls[0];
    expect(id).toBe('shot-A');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/wav');
    // 44 header + 30 PCM bytes
    expect((blob as Blob).size).toBe(44 + 30);

    const kept = getCoachAudioBlob('shot-A');
    expect(kept).toBe(blob);
  });

  it('finalize with no accumulated audio is a no-op', () => {
    coachAudioTap.finalizeForShot('shot-empty');
    expect(syncCoachAudio).not.toHaveBeenCalled();
    expect(getCoachAudioBlob('shot-empty')).toBeUndefined();
  });

  it('discard drops the accumulator so the next finalize is empty', () => {
    coachAudioTap.onChunk(b64Bytes(15));
    coachAudioTap.discard();
    coachAudioTap.finalizeForShot('shot-discarded');
    expect(syncCoachAudio).not.toHaveBeenCalled();
    expect(getCoachAudioBlob('shot-discarded')).toBeUndefined();
  });

  it('clears the accumulator after finalize (no bleed into next shot)', () => {
    coachAudioTap.onChunk(b64Bytes(8));
    coachAudioTap.finalizeForShot('shot-1');
    expect(syncCoachAudio).toHaveBeenCalledTimes(1);
    // No new chunks for the next shot → empty finalize, no second upload.
    coachAudioTap.finalizeForShot('shot-2');
    expect(syncCoachAudio).toHaveBeenCalledTimes(1);
    expect(getCoachAudioBlob('shot-2')).toBeUndefined();
  });

  it('ignores empty / bad base64 chunks (never throws)', () => {
    expect(() => coachAudioTap.onChunk('')).not.toThrow();
    expect(() => coachAudioTap.onChunk('!!!bad!!!')).not.toThrow();
    coachAudioTap.finalizeForShot('shot-bad');
    // Nothing decoded → nothing to upload.
    expect(syncCoachAudio).not.toHaveBeenCalled();
  });

  it('caps the kept-audio map at 20, evicting the oldest', () => {
    for (let i = 0; i < 25; i += 1) {
      coachAudioTap.onChunk(b64Bytes(4));
      coachAudioTap.finalizeForShot(`cap-${i}`);
    }
    // Oldest 5 evicted, newest 20 retained.
    expect(getCoachAudioBlob('cap-0')).toBeUndefined();
    expect(getCoachAudioBlob('cap-4')).toBeUndefined();
    expect(getCoachAudioBlob('cap-5')).toBeInstanceOf(Blob);
    expect(getCoachAudioBlob('cap-24')).toBeInstanceOf(Blob);
  });
});

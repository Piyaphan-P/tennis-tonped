// ============================================================================
// ADGE Tennis — pure WAV (PCM16) encoder for coach audio capture.
//
// The Gemini Live coach streams native-audio PCM we already pay for. Instead of
// re-synthesizing or re-requesting anything, we simply concatenate the raw PCM
// chunks and wrap them in a standard 44-byte RIFF/WAVE header so the same bytes
// become a playable audio/wav Blob — ZERO extra Gemini tokens.
//
// Native-audio output is 24 kHz, 16-bit signed little-endian, mono. These are
// the fixed encode parameters; nothing here reaches a socket or the disk, so it
// is trivially unit-testable at the repo root.
// ============================================================================

/** Native-audio coach output format (fixed). */
export const COACH_SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;

/** Decode a base64 string into bytes. Returns an empty array on bad input. */
export function base64ToBytes(base64: string): Uint8Array {
  if (typeof base64 !== 'string' || base64.length === 0) return new Uint8Array(0);
  try {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Concatenate raw PCM16 chunks and prepend a canonical 44-byte RIFF/WAVE header
 * (PCM, mono, 24 kHz, 16-bit LE). Returns a fresh Uint8Array of the full file,
 * or null when there is no PCM data (empty input → nothing to save).
 */
export function encodeWavPcm16(
  chunks: Uint8Array[],
  sampleRate: number = COACH_SAMPLE_RATE,
): Uint8Array | null {
  let dataSize = 0;
  for (const c of chunks) dataSize += c.length;
  if (dataSize === 0) return null;

  const byteRate = (sampleRate * NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(out.buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // chunkSize = 36 + dataSize
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // subchunk1Size (PCM)
  view.setUint16(20, 1, true); // audioFormat = 1 (PCM)
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_BYTES;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Build a playable audio/wav Blob from raw PCM16 chunks, or null when empty. */
export function encodeWavBlob(
  chunks: Uint8Array[],
  sampleRate: number = COACH_SAMPLE_RATE,
): Blob | null {
  const bytes = encodeWavPcm16(chunks, sampleRate);
  if (!bytes) return null;
  // encodeWavPcm16 returns a Uint8Array that OWNS its whole ArrayBuffer, so the
  // buffer is exactly the file bytes. Cast narrows ArrayBufferLike → ArrayBuffer
  // (the DOM BlobPart type rejects the SharedArrayBuffer union member).
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' });
}

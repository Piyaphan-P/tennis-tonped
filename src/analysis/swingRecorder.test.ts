// ============================================================================
// ADGE Tennis — swingRecorder pure-logic tests
//
// Only the mimeType negotiation is pure/DOM-free (the predicate is injected),
// so it is the single unit-test surface. The SwingRecorder class itself only
// touches MediaRecorder / canvas.captureStream, which are absent in node — it
// is validated to construct harmlessly (supported === false) here, and its
// lifecycle is exercised on real devices, not in vitest.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  pickRecorderMimeType,
  SwingRecorder,
  CLIP_MAX_MS,
  CLIP_TARGET_WIDTH,
  CLIP_FPS,
  CLIP_BITS_PER_SECOND,
} from './swingRecorder';

describe('pickRecorderMimeType', () => {
  it('returns the first supported type in the preferred chain', () => {
    // mp4/avc1 supported → picked first (iOS Safari path).
    expect(pickRecorderMimeType(() => true)).toBe('video/mp4;codecs=avc1.42E01E');
  });

  it('falls through to the next candidate when earlier ones are unsupported', () => {
    const only = 'video/webm;codecs=vp9';
    expect(pickRecorderMimeType((t) => t === only)).toBe(only);
  });

  it('prefers vp9 over vp8 and bare webm', () => {
    const supported = new Set([
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ]);
    expect(pickRecorderMimeType((t) => supported.has(t))).toBe('video/webm;codecs=vp9');
  });

  it('returns null when nothing is supported', () => {
    expect(pickRecorderMimeType(() => false)).toBeNull();
  });

  it('treats a throwing probe as unsupported and keeps walking the chain', () => {
    const picked = pickRecorderMimeType((t) => {
      if (t.startsWith('video/mp4')) throw new Error('probe blew up');
      return t === 'video/webm;codecs=vp8';
    });
    expect(picked).toBe('video/webm;codecs=vp8');
  });
});

describe('clip tunables', () => {
  it('exposes the documented recording constants', () => {
    expect(CLIP_MAX_MS).toBe(6000);
    expect(CLIP_TARGET_WIDTH).toBe(480);
    expect(CLIP_FPS).toBe(30);
    expect(CLIP_BITS_PER_SECOND).toBe(1_800_000);
  });
});

describe('SwingRecorder in a non-browser env', () => {
  it('constructs harmlessly and reports unsupported (no MediaRecorder/captureStream)', () => {
    const fakeVideo = { videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement;
    const rec = new SwingRecorder(fakeVideo);
    expect(rec.supported).toBe(false);
  });

  it('all lifecycle calls no-op when unsupported', async () => {
    const fakeVideo = { videoWidth: 640, videoHeight: 480 } as unknown as HTMLVideoElement;
    const rec = new SwingRecorder(fakeVideo);
    expect(() => rec.startSwing()).not.toThrow();
    expect(() => rec.drawFrame({ timestampMs: 0, landmarks: [] }, null, 'right')).not.toThrow();
    await expect(rec.finishSwing()).resolves.toBeNull();
    expect(() => rec.discardSwing()).not.toThrow();
    expect(() => rec.dispose()).not.toThrow();
  });
});

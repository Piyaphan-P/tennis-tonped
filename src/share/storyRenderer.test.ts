// ============================================================================
// ADGE Tennis — storyRenderer tests
//
// Test env is node (no jsdom), matching swingRecorder.test.ts. So:
//   • pure layout/text helpers are unit-tested directly, and
//   • the DOM/canvas-heavy render + share paths are smoke-tested with global
//     stubs (vi.stubGlobal), asserting they resolve the right shape and never
//     throw — their pixel output is validated on real devices, not in vitest.
// ============================================================================

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  STORY_W,
  STORY_H,
  STORY_APP_URL,
  STORY_VIDEO_MAX_MS,
  STORY_VIDEO_FPS,
  STORY_VIDEO_BITS_PER_SECOND,
  scoreStoryColor,
  containRect,
  wrapLines,
  extForMime,
  storyFilename,
  pickStoryVideoMimeType,
  composeStoryText,
  renderStoryImage,
  renderStoryVideo,
  shareStory,
  type StoryData,
} from './storyRenderer';
import type { SwingCapture, ShotClip, JointAngles, AngleStatuses } from '../types';

// --- fixtures ---------------------------------------------------------------

const ANGLES: JointAngles = {
  timestampMs: 0,
  leftElbowDeg: 150,
  rightElbowDeg: 150,
  leftShoulderDeg: 90,
  rightShoulderDeg: 90,
  leftKneeDeg: 140,
  rightKneeDeg: 140,
  leftHipDeg: 170,
  rightHipDeg: 170,
  trunkLeanDeg: 5,
  wristSpeed: 1.2,
  wristVelX: 0.8,
};

const STATUSES: AngleStatuses = {
  domElbow: 'fault',
  domShoulder: 'good',
  leftKnee: 'warn',
  rightKnee: 'good',
  trunk: 'neutral',
};

const CAPTURE: SwingCapture = {
  id: 'cap-1',
  shotId: 'shot-1',
  phase: 'contact',
  jpegBase64: 'AAAA',
  atMs: 1000,
  angles: ANGLES,
  landmarks: Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 })),
  statuses: STATUSES,
};

const CLIP: ShotClip = {
  url: 'blob:fake',
  mimeType: 'video/mp4',
  durationMs: 3000,
  sizeBytes: 12345,
  width: 480,
  height: 640,
};

const DATA: StoryData = {
  titleTh: 'แก้จุดกระทบลูก',
  titleEn: 'Fix your contact point',
  lang: 'th',
  score: 58,
  shotLabel: 'โฟร์แฮนด์',
  fixText: 'กระทบลูกให้อยู่ด้านหน้าลำตัวมากขึ้น เหยียดศอกราว 140 องศา',
  cueText: 'ตีข้างหน้า เหยียดแขน',
  dateLabel: '7 ก.ค. 2026',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// pure helpers
// ===========================================================================

describe('story constants', () => {
  it('exposes the 9:16 portrait story format + video tunables', () => {
    expect(STORY_W).toBe(1080);
    expect(STORY_H).toBe(1920);
    expect(STORY_H / STORY_W).toBeCloseTo(16 / 9, 5);
    expect(STORY_VIDEO_MAX_MS).toBe(8000);
    expect(STORY_VIDEO_FPS).toBe(30);
    expect(STORY_VIDEO_BITS_PER_SECOND).toBe(2_500_000);
  });
});

describe('scoreStoryColor', () => {
  it('maps score to the court-night semantic palette (>=80 good, >=60 warn, else fault)', () => {
    expect(scoreStoryColor(80)).toBe('#39d08a');
    expect(scoreStoryColor(100)).toBe('#39d08a');
    expect(scoreStoryColor(60)).toBe('#f1a24a');
    expect(scoreStoryColor(79)).toBe('#f1a24a');
    expect(scoreStoryColor(59)).toBe('#ff6a4d');
    expect(scoreStoryColor(0)).toBe('#ff6a4d');
  });
});

describe('containRect', () => {
  const box = { x: 100, y: 200, w: 900, h: 900 };

  it('letterboxes a landscape media inside the box, centered', () => {
    const r = containRect(1600, 900, box); // 16:9 → limited by width
    expect(r.w).toBeCloseTo(900, 5);
    expect(r.h).toBeCloseTo(506.25, 2);
    expect(r.x).toBeCloseTo(100, 5); // full width, no x inset
    expect(r.y).toBeCloseTo(200 + (900 - 506.25) / 2, 2);
  });

  it('pillarboxes a portrait media inside the box, centered', () => {
    const r = containRect(600, 900, box); // limited by height
    expect(r.h).toBeCloseTo(900, 5);
    expect(r.w).toBeCloseTo(600, 5);
    expect(r.y).toBeCloseTo(200, 5);
    expect(r.x).toBeCloseTo(100 + (900 - 600) / 2, 5);
  });

  it('fills the whole box for degenerate media', () => {
    expect(containRect(0, 0, box)).toEqual(box);
    expect(containRect(-5, 100, box)).toEqual(box);
  });
});

describe('wrapLines', () => {
  // fixed-width measurer: each character is 10 units wide.
  const measure = (s: string) => s.length * 10;

  it('keeps space-delimited words whole and wraps at the width', () => {
    const lines = wrapLines('one two three four', 90, measure);
    // "one two" = 7 chars = 70 ok; + " three" → 13 chars = 130 > 90 → wrap
    expect(lines).toEqual(['one two', 'three', 'four']);
  });

  it('breaks a single over-long token (space-less Thai) character by character', () => {
    const lines = wrapLines('กขคงจฉชญ', 30, measure); // 8 Thai chars, width 3/line
    expect(lines).toEqual(['กขค', 'งจฉ', 'ชญ']);
  });

  it('returns [] for empty text', () => {
    expect(wrapLines('', 100, measure)).toEqual([]);
  });

  it('never emits a line wider than maxWidth when a single word fits alone', () => {
    const lines = wrapLines('aaaa bb', 40, measure);
    lines.forEach((l) => expect(measure(l)).toBeLessThanOrEqual(40));
  });
});

describe('extForMime / storyFilename', () => {
  it('maps container mimeTypes to file extensions', () => {
    expect(extForMime('video/mp4;codecs=avc1.42E01E')).toBe('mp4');
    expect(extForMime('video/webm;codecs=vp9')).toBe('webm');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('application/octet-stream')).toBe('bin');
    expect(extForMime('')).toBe('bin');
  });

  it('builds a sanitized filename with the mime-derived extension', () => {
    expect(storyFilename('adge-shot-3', 'image/png')).toBe('adge-shot-3.png');
    expect(storyFilename('bad name/../x', 'video/mp4')).toBe('bad-name-..-x.mp4');
    expect(storyFilename('', 'video/webm')).toBe('adge-story.webm');
  });
});

describe('pickStoryVideoMimeType', () => {
  it('reuses the swingRecorder chain (mp4/avc1 first)', () => {
    expect(pickStoryVideoMimeType(() => true)).toBe('video/mp4;codecs=avc1.42E01E');
  });

  it('returns null when nothing is supported', () => {
    expect(pickStoryVideoMimeType(() => false)).toBeNull();
  });
});

describe('composeStoryText', () => {
  it('uses Thai labels + Thai title when lang=th', () => {
    const t = composeStoryText(DATA);
    expect(t.brand).toBe('ADGE Tennis');
    expect(t.title).toBe(DATA.titleTh);
    expect(t.scoreLabel).toBe('คะแนน');
    expect(t.fixLabel).toBe('จุดที่ต้องแก้');
    expect(t.cueLabel).toBe('ท่องไว้ตอนตี');
    expect(t.shotLabel).toBe(DATA.shotLabel);
    expect(t.fixText).toBe(DATA.fixText);
    expect(t.cueText).toBe(DATA.cueText);
    expect(t.footer).toContain(DATA.dateLabel);
    expect(t.footer).toContain(STORY_APP_URL);
  });

  it('uses English labels + English title when lang=en', () => {
    const t = composeStoryText({ ...DATA, lang: 'en' });
    expect(t.title).toBe(DATA.titleEn);
    expect(t.scoreLabel).toBe('SCORE');
    expect(t.fixLabel).toBe('FIX THIS');
    expect(t.cueLabel).toBe('REMEMBER');
  });

  it('never emits the forbidden brand misspelling', () => {
    const t = composeStoryText(DATA);
    expect(t.brand).not.toContain('ต้นเป็ด');
    expect(t.brand).not.toMatch(/tonped/i);
  });
});

// ===========================================================================
// DOM/canvas smoke tests (global stubs)
// ===========================================================================

/** A no-op 2D context recording nothing but answering measureText/gradient. */
function fakeCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    save: noop,
    restore: noop,
    translate: noop,
    clip: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    drawImage: noop,
    fillText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    measureText: (s: string) => ({ width: s.length * 12 }),
    set fillStyle(_v: unknown) {},
    set strokeStyle(_v: unknown) {},
    set lineWidth(_v: unknown) {},
    set lineCap(_v: unknown) {},
    set globalAlpha(_v: unknown) {},
    set font(_v: unknown) {},
    set textAlign(_v: unknown) {},
    set textBaseline(_v: unknown) {},
  } as unknown as CanvasRenderingContext2D;
}

function stubImageableDocument(): void {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => fakeCtx(),
    toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob(['png-bytes'], { type })),
  };
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'canvas' ? { ...canvas } : {}),
  });
  // Image whose src setter resolves onload on the next tick.
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 640;
    naturalHeight = 480;
    set src(_v: string) {
      setTimeout(() => this.onload?.(), 0);
    }
  }
  vi.stubGlobal('Image', FakeImage as unknown as typeof Image);
}

describe('renderStoryImage (smoke)', () => {
  it('resolves an image/png Blob when a canvas is available', async () => {
    stubImageableDocument();
    const blob = await renderStoryImage(CAPTURE, 'right', DATA);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('still resolves a png Blob when the capture image fails to decode', async () => {
    stubImageableDocument();
    // Force decode failure.
    class FailImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onerror?.(), 0);
      }
    }
    vi.stubGlobal('Image', FailImage as unknown as typeof Image);
    const blob = await renderStoryImage(CAPTURE, 'right', DATA);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });

  it('resolves an (empty) png Blob with no document, never throwing', async () => {
    vi.stubGlobal('document', undefined);
    const blob = await renderStoryImage(CAPTURE, 'right', DATA);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });
});

describe('renderStoryVideo (smoke)', () => {
  it('returns null in a non-browser env (no MediaRecorder)', async () => {
    // node has no MediaRecorder → pickStoryVideoMimeType/guard bail to null.
    const result = await renderStoryVideo(CLIP, CAPTURE, 'right', DATA);
    expect(result).toBeNull();
  });
});

describe('shareStory', () => {
  it("returns 'shared' via navigator.share when canShare accepts the file", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('File', class {
      constructor(public parts: unknown[], public name: string, public opts: { type?: string }) {}
    } as unknown as typeof File);
    vi.stubGlobal('navigator', { canShare: () => true, share });
    const res = await shareStory(new Blob(['x'], { type: 'video/mp4' }), 'story.mp4');
    expect(res).toBe('shared');
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("treats a user-cancelled share (AbortError) as 'shared'", async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const share = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal('File', class {
      constructor(public parts: unknown[], public name: string, public opts: { type?: string }) {}
    } as unknown as typeof File);
    vi.stubGlobal('navigator', { canShare: () => true, share });
    const res = await shareStory(new Blob(['x'], { type: 'image/png' }), 'story.png');
    expect(res).toBe('shared');
  });

  it("falls back to an anchor download → 'downloaded' when share is unavailable", async () => {
    const click = vi.fn();
    const anchor = { href: '', download: '', rel: '', click, remove: () => {} };
    vi.stubGlobal('navigator', {}); // no share
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: () => {} },
    });
    const createObjectURL = vi.fn(() => 'blob:dl');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const res = await shareStory(new Blob(['x'], { type: 'image/png' }), 'story.png');
    expect(res).toBe('downloaded');
    expect(click).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe('story.png');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("watchdog: a share() that never settles while the page stays visible+focused falls back to download → 'downloaded'", async () => {
    vi.useFakeTimers();
    try {
      const share = vi.fn(() => new Promise<void>(() => {})); // never settles (headless / odd webview)
      vi.stubGlobal('File', class {
        constructor(public parts: unknown[], public name: string, public opts: { type?: string }) {}
      } as unknown as typeof File);
      vi.stubGlobal('navigator', { canShare: () => true, share });
      const click = vi.fn();
      const anchor = { href: '', download: '', rel: '', click, remove: () => {} };
      vi.stubGlobal('document', {
        createElement: () => anchor,
        body: { appendChild: () => {} },
        visibilityState: 'visible',
        hasFocus: () => true,
      });
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:dl'), revokeObjectURL: vi.fn() });
      const pending = shareStory(new Blob(['x'], { type: 'image/png' }), 'story.png');
      await vi.advanceTimersByTimeAsync(3100);
      const res = await pending;
      expect(res).toBe('downloaded');
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('watchdog: keeps waiting while the sheet is open (page hidden) and honors the eventual share() result', async () => {
    vi.useFakeTimers();
    try {
      let resolveShare: () => void = () => {};
      const share = vi.fn(() => new Promise<void>((r) => { resolveShare = r; }));
      vi.stubGlobal('File', class {
        constructor(public parts: unknown[], public name: string, public opts: { type?: string }) {}
      } as unknown as typeof File);
      vi.stubGlobal('navigator', { canShare: () => true, share });
      // Page hidden = OS share sheet genuinely open on a phone.
      vi.stubGlobal('document', {
        visibilityState: 'hidden',
        hasFocus: () => false,
      });
      const pending = shareStory(new Blob(['x'], { type: 'image/png' }), 'story.png');
      await vi.advanceTimersByTimeAsync(10_000); // well past the watchdog
      resolveShare(); // user finally picks an app
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).resolves.toBe('shared');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws even when both share and download are impossible', async () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('URL', undefined);
    await expect(
      shareStory(new Blob(['x'], { type: 'image/png' }), 'story.png'),
    ).resolves.toBe('downloaded');
  });
});

// ============================================================================
// ต้นและเพชร Tennis Club — story renderer (v0.8 share-a-swing)
//
// Turns one bad/missed swing into a share-worthy 9:16 story the player can post
// to IG / Facebook / TikTok:
//   • renderStoryImage()  — always-succeeds 1080×1920 PNG card (skeleton drawn
//                           on the contact frame + clear "fix this / remember").
//   • renderStoryVideo()  — 9:16 canvas video that plays the swing clip
//                           (skeleton already burned in by swingRecorder) inside
//                           the same chrome; null when unsupported/undecodable.
//   • shareStory()        — navigator.share({files}) to open the native share
//                           sheet, else anchor-download. NEVER throws.
//
// No React. Imperative module in the style of captureRenderer / swingRecorder.
// Canvas can't read CSS vars, so the theme palette is mirrored as hex here
// (kept in sync with theme.css). Pure layout/text helpers are exported so the
// heavy DOM paths need only smoke-testing (this repo's test env is node).
// ============================================================================

import { drawSkeleton } from '../analysis/captureRenderer';
import { pickRecorderMimeType, defaultIsTypeSupported } from '../analysis/swingRecorder';
import type { DominantHand, ShotClip, SwingCapture } from '../types';

// ---------------------------------------------------------------------------
// Frozen public data contract (shared with the share-UI agent)
// ---------------------------------------------------------------------------

export interface StoryData {
  titleTh: string;
  titleEn: string;
  lang: 'th' | 'en';
  score: number;
  shotLabel: string;
  fixText: string;
  cueText: string;
  dateLabel: string;
}

// ---------------------------------------------------------------------------
// Canvas / layout constants (portrait story format)
// ---------------------------------------------------------------------------

export const STORY_W = 1080;
export const STORY_H = 1920;

/** Public brand handle shown in the footer. Never a real broken link claim. */
export const STORY_APP_URL = 'tonphet.tennis';

/** Brand header — the ONE canonical spelling. Never "ต้นเป็ด" / "TonPed". */
const BRAND = 'ต้นและเพชร Tennis Club';

/** Video story tunables (a touch richer than the on-court clip). */
export const STORY_VIDEO_MAX_MS = 8000;
export const STORY_VIDEO_FPS = 30;
export const STORY_VIDEO_BITS_PER_SECOND = 2_500_000;

const SIDE_PAD = 72;
const CONTENT_W = STORY_W - SIDE_PAD * 2;
const FRAME_RADIUS = 36;

/** Rounded media box the frame / clip is letterboxed inside. */
const FRAME_BOX = { x: SIDE_PAD, y: 300, w: CONTENT_W, h: 880 } as const;

// --- palette (mirrors theme.css; canvas can't read CSS vars) ----------------
const C_BG_TOP = '#14352b'; // deep court green
const C_BG_MID = '#0e1a19';
const C_BG_BOT = '#0a1113';
const C_TEXT = '#f2f6f4';
const C_DIM = '#9fb0ad';
const C_ACCENT = '#d6f441'; // optic yellow
const C_BLUE = '#4fc0e6'; // hardcourt blue
const C_GOOD = '#39d08a';
const C_WARN = '#f1a24a';
const C_FAULT = '#ff6a4d';
const C_FRAME_BG = '#05090a';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans Thai", sans-serif';

// ===========================================================================
// PURE HELPERS (unit-tested; no DOM)
// ===========================================================================

/** Color a 0–100 score by the court-night semantic palette (mirrors ScoreBadge). */
export function scoreStoryColor(score: number): string {
  if (score >= 80) return C_GOOD;
  if (score >= 60) return C_WARN;
  return C_FAULT;
}

export interface StoryRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Contain (letterbox) media of size (mediaW × mediaH) centered inside `box`,
 * preserving aspect. Degenerate media (≤0) fills the whole box.
 */
export function containRect(
  mediaW: number,
  mediaH: number,
  box: StoryRect,
): StoryRect {
  if (mediaW <= 0 || mediaH <= 0) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const scale = Math.min(box.w / mediaW, box.h / mediaH);
  const w = mediaW * scale;
  const h = mediaH * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * Greedy word/char wrap that works for BOTH space-delimited Latin and
 * space-less Thai. Space-joined tokens are kept whole when they fit; a single
 * token wider than `maxWidth` (a Thai sentence) is broken character by
 * character. `measure` is injectable so this is pure-testable without canvas.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  if (!text) return lines;
  for (const para of text.split('\n')) {
    let current = '';
    const flushChar = (word: string) => {
      // word alone exceeds maxWidth → break into character chunks
      let buf = '';
      for (const ch of word) {
        if (buf && measure(buf + ch) > maxWidth) {
          lines.push(buf);
          buf = ch;
        } else {
          buf += ch;
        }
      }
      current = buf;
    };
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        if (measure(word) <= maxWidth) current = word;
        else flushChar(word);
      }
    }
    lines.push(current);
  }
  return lines;
}

/** File extension for a story blob's mimeType. */
export function extForMime(mimeType: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  return 'bin';
}

/** `${base}.${ext}` derived from the blob mimeType. */
export function storyFilename(base: string, mimeType: string): string {
  const safe = (base || 'tonphet-story').replace(/[^a-z0-9._-]+/gi, '-');
  return `${safe}.${extForMime(mimeType)}`;
}

/** First supported story-video container/codec (reuses swingRecorder's chain). */
export function pickStoryVideoMimeType(
  isSupported: (t: string) => boolean = defaultIsTypeSupported,
): string | null {
  return pickRecorderMimeType(isSupported);
}

export interface StoryText {
  brand: string;
  title: string;
  scoreLabel: string;
  shotLabel: string;
  fixLabel: string;
  fixText: string;
  cueLabel: string;
  cueText: string;
  footer: string;
}

/** Compose every visible string from StoryData (localized labels; brand fixed). */
export function composeStoryText(data: StoryData): StoryText {
  const th = data.lang === 'th';
  return {
    brand: BRAND,
    title: th ? data.titleTh : data.titleEn,
    scoreLabel: th ? 'คะแนน' : 'SCORE',
    shotLabel: data.shotLabel,
    fixLabel: th ? 'จุดที่ต้องแก้' : 'FIX THIS',
    fixText: data.fixText,
    cueLabel: th ? 'ท่องไว้ตอนตี' : 'REMEMBER',
    cueText: data.cueText,
    footer: `${data.dateLabel}  ·  ${STORY_APP_URL}`,
  };
}

// ===========================================================================
// DOM / canvas helpers (smoke-tested with global stubs)
// ===========================================================================

function createStoryCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Decode an image src; resolves null on any failure (never rejects). */
function loadImageSafe(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    } catch {
      resolve(null);
    }
  });
}

function dataUrlToBlob(dataUrl: string, type: string): Blob {
  try {
    const comma = dataUrl.indexOf(',');
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return new Blob([], { type });
  }
}

/** Canvas → Blob of `type`, with toBlob → toDataURL → empty-blob fallbacks. */
function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve) => {
    try {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob(
          (b) => resolve(b ?? new Blob([], { type })),
          type,
          0.92,
        );
        return;
      }
      if (typeof canvas.toDataURL === 'function') {
        resolve(dataUrlToBlob(canvas.toDataURL(type), type));
        return;
      }
      resolve(new Blob([], { type }));
    } catch {
      resolve(new Blob([], { type }));
    }
  });
}

// --- drawing primitives -----------------------------------------------------

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, 0, STORY_H);
  g.addColorStop(0, C_BG_TOP);
  g.addColorStop(0.45, C_BG_MID);
  g.addColorStop(1, C_BG_BOT);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, STORY_W, STORY_H);
}

function drawBrandHeader(ctx: CanvasRenderingContext2D, brand: string): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C_ACCENT;
  ctx.font = `700 44px ${FONT_STACK}`;
  ctx.fillText(`🎾 ${brand}`, STORY_W / 2, 128);
}

function drawTitle(ctx: CanvasRenderingContext2D, title: string): void {
  if (!title) return;
  ctx.textAlign = 'center';
  ctx.fillStyle = C_TEXT;
  ctx.font = `700 52px ${FONT_STACK}`;
  const measure = (s: string) => ctx.measureText(s).width;
  const lines = wrapLines(title, CONTENT_W, measure).slice(0, 2);
  let y = 214;
  for (const line of lines) {
    ctx.fillText(line, STORY_W / 2, y);
    y += 62;
  }
}

function drawFrameBorder(ctx: CanvasRenderingContext2D, box: StoryRect): void {
  roundRectPath(ctx, box.x, box.y, box.w, box.h, FRAME_RADIUS);
  ctx.strokeStyle = C_BLUE;
  ctx.lineWidth = 4;
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Draw the still contact frame + colored skeleton, letterboxed in the box. */
function drawStillFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  capture: SwingCapture,
  hand: DominantHand,
): void {
  const box = FRAME_BOX;
  ctx.save();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, FRAME_RADIUS);
  ctx.clip();
  ctx.fillStyle = C_FRAME_BG;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  if (img) {
    const iw = img.naturalWidth || 640;
    const ih = img.naturalHeight || 480;
    const rect = containRect(iw, ih, box);
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
    // Skeleton mapped into the SAME contained rect (un-mirrored: raw pixels).
    ctx.save();
    ctx.translate(rect.x, rect.y);
    drawSkeleton(ctx, rect.w, rect.h, capture.landmarks, capture.statuses, hand, false);
    ctx.restore();
  }
  ctx.restore();
  drawFrameBorder(ctx, box);
}

function drawScore(
  ctx: CanvasRenderingContext2D,
  score: number,
  scoreLabel: string,
  shotLabel: string,
): void {
  const cx = STORY_W / 2;
  ctx.textAlign = 'center';

  ctx.fillStyle = C_DIM;
  ctx.font = `600 30px ${FONT_STACK}`;
  ctx.fillText(scoreLabel.toUpperCase(), cx, FRAME_BOX.y + FRAME_BOX.h + 78);

  ctx.fillStyle = scoreStoryColor(score);
  ctx.font = `800 150px ${FONT_STACK}`;
  ctx.fillText(String(Math.round(score)), cx, FRAME_BOX.y + FRAME_BOX.h + 214);

  if (shotLabel) {
    ctx.fillStyle = C_BLUE;
    ctx.font = `700 40px ${FONT_STACK}`;
    ctx.fillText(shotLabel, cx, FRAME_BOX.y + FRAME_BOX.h + 274);
  }
}

/** Body line height of the fix/cue text blocks, px. */
const TEXT_LINE_H = 54;

/**
 * Left-aligned "label + wrapped body" block; returns the y after the block.
 * Lines whose baseline would pass `maxY` are dropped so a long fix text can
 * never run into the cue block or the footer (Thai coach copy wraps a lot).
 */
function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  label: string,
  labelColor: string,
  body: string,
  startY: number,
  maxY: number,
): number {
  const x = SIDE_PAD;
  ctx.textAlign = 'left';

  ctx.fillStyle = labelColor;
  ctx.font = `700 30px ${FONT_STACK}`;
  ctx.fillText(label.toUpperCase(), x, startY);

  ctx.fillStyle = C_TEXT;
  ctx.font = `600 44px ${FONT_STACK}`;
  const measure = (s: string) => ctx.measureText(s).width;
  // Decide the kept lines BEFORE drawing so a truncation can mark the last
  // visible line with an ellipsis — dropped copy must be visibly dropped,
  // never silently missing (v0.8 review: EN 3-line fix ate the cue body).
  const allLines = wrapLines(body, CONTENT_W, measure);
  const kept: string[] = [];
  let fitY = startY + 56;
  for (const line of allLines) {
    if (kept.length >= 4 || fitY > maxY) break;
    kept.push(line);
    fitY += TEXT_LINE_H;
  }
  if (kept.length < allLines.length && kept.length > 0) {
    let last = kept[kept.length - 1];
    while (last.length > 1 && measure(`${last}…`) > CONTENT_W) {
      last = last.slice(0, -1);
    }
    kept[kept.length - 1] = `${last}…`;
  }
  let y = startY + 56;
  for (const line of kept) {
    ctx.fillText(line, x, y);
    y += TEXT_LINE_H;
  }
  return y;
}

function drawFooter(ctx: CanvasRenderingContext2D, footer: string): void {
  ctx.textAlign = 'center';
  ctx.fillStyle = C_DIM;
  ctx.font = `500 30px ${FONT_STACK}`;
  ctx.fillText(footer, STORY_W / 2, STORY_H - 72);
}

/** Draw the full chrome (everything except the media itself) onto ctx. */
function drawChrome(ctx: CanvasRenderingContext2D, text: StoryText, score: number): void {
  drawBrandHeader(ctx, text.brand);
  drawTitle(ctx, text.title);
  drawScore(ctx, score, text.scoreLabel, text.shotLabel);
  // Lower third: the cue block is ANCHORED at a fixed y above the footer so it
  // can never be pushed out by a long fix text; the fix block is clamped (with
  // ellipsis) to end above the cue anchor. (v0.8 review fix: a 3-line EN fix
  // used to shove the cue body past the clamp and drop it silently.)
  const cueLabelY = STORY_H - 204; // label 1716, one body line 1772, footer 1848
  const cueMaxY = STORY_H - 130;
  const fixStartY = FRAME_BOX.y + FRAME_BOX.h + 340;
  drawTextBlock(ctx, text.fixLabel, C_WARN, text.fixText, fixStartY, cueLabelY - 48);
  drawTextBlock(ctx, text.cueLabel, C_ACCENT, text.cueText, cueLabelY, cueMaxY);
  drawFooter(ctx, text.footer);
}

// ===========================================================================
// PUBLIC RENDER + SHARE (frozen contract)
// ===========================================================================

/**
 * Render a 1080×1920 PNG story card for one swing. Best-effort but ALWAYS
 * resolves a Blob (empty image/png on a hard failure) so callers can share.
 */
export async function renderStoryImage(
  capture: SwingCapture,
  hand: DominantHand,
  data: StoryData,
): Promise<Blob> {
  const emptyPng = () => new Blob([], { type: 'image/png' });
  try {
    if (typeof document === 'undefined') return emptyPng();
    const canvas = createStoryCanvas(STORY_W, STORY_H);
    const ctx = canvas.getContext('2d');
    if (!ctx) return emptyPng();
    const text = composeStoryText(data);

    drawBackground(ctx);
    const img = capture.jpegBase64
      ? await loadImageSafe(`data:image/jpeg;base64,${capture.jpegBase64}`)
      : null;
    drawStillFrame(ctx, img, capture, hand);
    drawChrome(ctx, text, data.score);

    return await canvasToBlob(canvas, 'image/png');
  } catch {
    return emptyPng();
  }
}

/** Await video readiness; resolves false on error/timeout (never rejects). */
function waitVideoReady(video: HTMLVideoElement): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const ok = () => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    };
    const bad = () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };
    video.onloadeddata = ok;
    video.oncanplay = ok;
    video.onerror = bad;
    setTimeout(bad, 4000);
    try {
      video.load?.();
    } catch {
      bad();
    }
  });
}

/**
 * Render a 9:16 story VIDEO: play the swing clip (skeleton already burned in by
 * swingRecorder) letterboxed inside the same chrome, recording the canvas via
 * captureStream + MediaRecorder. Caps at ~8s. Returns null when MediaRecorder /
 * captureStream is unsupported or the clip can't be decoded — callers fall back
 * to renderStoryImage(). Never throws.
 */
export async function renderStoryVideo(
  clip: ShotClip,
  _capture: SwingCapture,
  _hand: DominantHand,
  data: StoryData,
): Promise<Blob | null> {
  // The clip already carries the burned-in colored skeleton, so _capture/_hand
  // are unused for drawing (kept for the frozen signature).
  const mime = pickStoryVideoMimeType();
  if (!mime || typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
    return null;
  }

  let video: HTMLVideoElement | null = null;
  let rafId = 0;
  try {
    const canvas = createStoryCanvas(STORY_W, STORY_H);
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') return null;

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = clip.url;

    const ready = await waitVideoReady(video);
    if (!ready) return null;

    const text = composeStoryText(data);
    const stream = canvas.captureStream(STORY_VIDEO_FPS);
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: STORY_VIDEO_BITS_PER_SECOND,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((res) => {
      recorder.onstop = () => res();
    });

    const box = FRAME_BOX;
    let running = true;
    const draw = () => {
      const v = video;
      if (!running || !v) return;
      try {
        drawBackground(ctx);
        ctx.save();
        roundRectPath(ctx, box.x, box.y, box.w, box.h, FRAME_RADIUS);
        ctx.clip();
        ctx.fillStyle = C_FRAME_BG;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        const vw = v.videoWidth || clip.width || 16;
        const vh = v.videoHeight || clip.height || 9;
        const rect = containRect(vw, vh, box);
        ctx.drawImage(v, rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
        drawFrameBorder(ctx, box);
        drawChrome(ctx, text, data.score);
      } catch {
        /* drop one frame; keep recording */
      }
      rafId = requestAnimationFrame(draw);
    };

    recorder.start();
    rafId = requestAnimationFrame(draw);
    try {
      await video.play();
    } catch {
      /* autoplay may reject; the cap timer still bounds the recording */
    }

    const maxMs = Math.min(clip.durationMs || STORY_VIDEO_MAX_MS, STORY_VIDEO_MAX_MS);
    await new Promise<void>((res) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          res();
        }
      };
      video!.onended = finish;
      setTimeout(finish, maxMs);
    });

    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* ignore */
    }
    await Promise.race([stopped, new Promise<void>((r) => setTimeout(r, 1000))]);

    if (chunks.length === 0) return null;
    const blob = new Blob(chunks, { type: mime });
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  } finally {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (video) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      try {
        video.removeAttribute('src');
        video.load?.();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * How long to wait for navigator.share() to either settle or visibly open the
 * OS share sheet before assuming the environment silently swallowed it and
 * falling back to download. On real phones the sheet takes focus / hides the
 * page, so a legitimately open sheet is never cut off by this watchdog.
 */
export const SHARE_WATCHDOG_MS = 3000;

/**
 * Await a navigator.share() promise with a hang watchdog. Some environments
 * (headless browsers, odd webviews) leave share() forever pending without
 * showing any UI — without this the share button would stay busy for good.
 * Resolves 'shared' on fulfil (or user-cancel AbortError), 'fallback' on any
 * other rejection, and 'fallback' when the promise hasn't settled after
 * SHARE_WATCHDOG_MS while the page is still visible AND focused (no sheet
 * ever appeared). While the page is hidden/unfocused (sheet genuinely open)
 * it keeps waiting for the user's choice.
 */
function awaitShareWithWatchdog(share: Promise<void>): Promise<'shared' | 'fallback'> {
  return new Promise((resolve) => {
    let settled = false;
    share
      .then(() => {
        settled = true;
        resolve('shared');
      })
      .catch((err) => {
        settled = true;
        resolve(err && (err as { name?: string }).name === 'AbortError' ? 'shared' : 'fallback');
      });
    const check = () => {
      if (settled) return;
      let sheetLikelyOpen = false;
      try {
        sheetLikelyOpen =
          typeof document !== 'undefined' &&
          (document.visibilityState === 'hidden' || !document.hasFocus());
      } catch {
        sheetLikelyOpen = false;
      }
      if (sheetLikelyOpen) {
        // The OS sheet is up — keep waiting for the user to pick/cancel.
        setTimeout(check, 1000);
      } else {
        resolve('fallback');
      }
    };
    setTimeout(check, SHARE_WATCHDOG_MS);
  });
}

/**
 * Share a rendered story. Tries navigator.share({files}) — this is what opens
 * the IG / Facebook / TikTok share sheet on phones — falling back to an
 * anchor download. A user-cancelled share (AbortError) still counts as
 * 'shared'. NEVER throws.
 */
export async function shareStory(
  blob: Blob,
  filename: string,
): Promise<'shared' | 'downloaded'> {
  const type = blob.type || 'application/octet-stream';

  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof File !== 'undefined' &&
      typeof navigator.share === 'function'
    ) {
      const file = new File([blob], filename, { type });
      const canShare =
        typeof navigator.canShare === 'function' ? navigator.canShare({ files: [file] }) : true;
      if (canShare) {
        const outcome = await awaitShareWithWatchdog(
          Promise.resolve(navigator.share({ files: [file], title: BRAND })),
        );
        if (outcome === 'shared') return 'shared';
        /* 'fallback' → download below */
      }
    }
  } catch {
    /* fall through to download */
  }

  try {
    if (
      typeof document !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      (document.body ?? document.documentElement)?.appendChild?.(a);
      a.click();
      a.remove?.();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }, 4000);
    }
  } catch {
    /* ignore — nothing more we can do */
  }
  return 'downloaded';
}

// ============================================================================
// ต้นและเพชร Tennis Club — swing EXPORT renderer (v1.0 history share-a-swing)
//
// Renders one history swing into a share-worthy 9:16 (1080×1920) VIDEO that
// plays the swing clip WITH the coach's recorded voice, laid out like the
// history card the player already knows:
//   brand header · player name · "#N · แบ็คแฮนด์" + big score ·
//   large letterboxed clip · joint-angle radar · improvement bullets · footer.
//
//   • exportSwingVideo() — composites the playing clip + chrome onto a canvas,
//                          captureStream(30) + MediaRecorder; mixes the coach
//                          audio in via an AudioBuffer → MediaStreamDestination
//                          track. Loops the clip when the voice is longer.
//                          Returns null on any failure (never throws to UI).
//
// No React. Imperative module in the style of storyRenderer / swingRecorder.
// Canvas can't read CSS vars, so the theme palette is mirrored as hex here
// (kept in sync with theme.css). Pure layout / radar / duration / mime helpers
// are exported so the heavy DOM path needs only smoke-testing (test env = node).
//
// IMPORTS ONLY SHIPPED MODULES (storyRenderer, swingRecorder) so this file's
// vitest stays green independent of any in-flight sibling agent work. All
// cloud/coach-audio contract wiring lives in HistoryScreen / SwingExportButton.
// ============================================================================

import {
  containRect,
  wrapLines,
  storyFilename,
  type StoryRect,
} from './storyRenderer';
import {
  pickRecorderMimeType,
  defaultIsTypeSupported,
  CLIP_MAX_MS,
} from '../analysis/swingRecorder';
import type { Lang } from '../types';
import type { RadarDatum } from '../history/derive';

// ---------------------------------------------------------------------------
// Canvas / layout constants (portrait export format)
// ---------------------------------------------------------------------------

export const EXPORT_W = 1080;
export const EXPORT_H = 1920;

/** Cap on the exported clip length (a long coach turn is trimmed here). */
export const EXPORT_MAX_MS = 20000;
export const EXPORT_FPS = 30;
export const EXPORT_VIDEO_BITS_PER_SECOND = 2_500_000;

/** Public brand handle shown in the footer (mirrors storyRenderer). */
export const EXPORT_APP_URL = 'tonphet.tennis';

/** Brand header — the ONE canonical spelling. Never "ต้นเป็ด" / "TonPed". */
const BRAND = 'ต้นและเพชร Tennis Club';

const SIDE_PAD = 72;
const CONTENT_W = EXPORT_W - SIDE_PAD * 2;
const FRAME_RADIUS = 32;

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
const C_LINE = 'rgba(255,255,255,0.14)';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans Thai", sans-serif';

// ===========================================================================
// PUBLIC OPTS (frozen contract with the share-UI / HistoryScreen)
// ===========================================================================

export interface SwingExportOpts {
  /** blob: URL (same session) or /api/clips/:id (cloud). */
  clipSrc: string;
  /** Coach voice: same-session Blob (preferred) or same-origin URL. */
  audioSrc?: string | Blob | null;
  /** 1-based shot index within the session. */
  shotIndex: number;
  /** Already-localized stroke label, e.g. "แบ็คแฮนด์" / "Backhand". */
  shotTypeLabel: string;
  score: number;
  /** radarData(...) output — joint angles vs target, 0..1. */
  radar: RadarDatum[];
  /** shotImprovementLines(...) output — worst-first bullet strings. */
  fixLines: string[];
  playerName?: string;
  lang: Lang;
  /**
   * Known clip length in ms when available (same-session ShotClip.durationMs).
   * MediaRecorder-produced WebM omits duration from its header, so a played
   * <video>.duration reads Infinity — passing the real value here avoids a
   * bogus 20s export. Omitted for cloud-historical shots → duration is driven
   * by the decoded coach-audio length, else a CLIP_MAX_MS fallback.
   */
  clipDurationMs?: number;
}

// ===========================================================================
// PURE HELPERS (unit-tested; no DOM)
// ===========================================================================

/** Color a 0–100 score by the app's semantic palette (mirrors HistoryScreen). */
export function scoreExportColor(score: number): string {
  if (score >= 80) return C_GOOD;
  if (score >= 60) return C_WARN;
  return C_FAULT;
}

export interface RadarLayout {
  cx: number;
  cy: number;
  /** Radius of the 100% ring. */
  r: number;
  /** Axis labels sit at r × labelFactor from center (mirrors RadarChart 1.28). */
  labelFactor: number;
}

export interface ExportLayout {
  /** Letterbox box for the swing clip. */
  video: StoryRect;
  /** Radar geometry (center, ring, label ring, title baseline). */
  radar: RadarLayout;
  /** Baseline y where the header row (index/type + score) sits. */
  headerRowY: number;
  /** Baseline y where the fix-bullet block starts. */
  fixStartY: number;
}

/**
 * Fixed layout for the 1080×1920 card (kept pure so it is unit-testable).
 * Clearances are asserted in the test: the radar's top axis label sits BELOW
 * the video box, and the bottom axis label gets a WIDE gap (user feedback:
 * the fix bullets were crowding the chart) before the fix-bullet block.
 */
export function exportLayout(): ExportLayout {
  return {
    video: { x: SIDE_PAD, y: 372, w: CONTENT_W, h: 680 },
    radar: { cx: EXPORT_W / 2, cy: 1268, r: 118, labelFactor: 1.34 },
    headerRowY: 318,
    fixStartY: 1560,
  };
}

/**
 * Vertex on a radar for axis `i` of `n` at radial fraction `f` (0..1), centered
 * at (cx,cy) with 100%-ring radius `r`. Starts at the top, goes clockwise —
 * ported from RadarChart.point().
 */
export function radarAxisPoint(
  i: number,
  n: number,
  f: number,
  cx: number,
  cy: number,
  r: number,
): [number, number] {
  const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, n);
  return [cx + Math.cos(angle) * r * f, cy + Math.sin(angle) * r * f];
}

/** Points for an n-gon at the given per-axis radial fractions. */
export function radarPolygon(
  values: number[],
  cx: number,
  cy: number,
  r: number,
): [number, number][] {
  const n = values.length;
  return values.map((v, i) => radarAxisPoint(i, n, v, cx, cy, r));
}

/**
 * Recording length = max(clip, audio) capped at EXPORT_MAX_MS. A non-finite or
 * ≤0 clip duration (WebM header omits it → <video>.duration = Infinity) falls
 * back to the audio length, else CLIP_MAX_MS — never a bogus 20s max.
 */
export function recordDurationMs(
  clipMs: number,
  audioMs: number,
  capMs: number = EXPORT_MAX_MS,
): number {
  const clipOk = Number.isFinite(clipMs) && clipMs > 0;
  const audioOk = Number.isFinite(audioMs) && audioMs > 0;
  let base: number;
  if (clipOk && audioOk) base = Math.max(clipMs, audioMs);
  else if (clipOk) base = clipMs;
  else if (audioOk) base = audioMs;
  else base = CLIP_MAX_MS;
  return Math.min(base, capMs);
}

/**
 * Loop the (short) swing clip when the coach voice outlasts it, so the video
 * region never freezes/blanks mid-audio. Unknown clip length ⇒ loop (safe: a
 * finite clip that ends early would otherwise hold its last frame).
 */
export function shouldLoopClip(clipMs: number, audioMs: number): boolean {
  const audioOk = Number.isFinite(audioMs) && audioMs > 0;
  if (!audioOk) return false;
  const clipOk = Number.isFinite(clipMs) && clipMs > 0;
  if (!clipOk) return true;
  return audioMs > clipMs;
}

/** First supported export-video container/codec (reuses swingRecorder's chain). */
export function pickExportMimeType(
  isSupported: (t: string) => boolean = defaultIsTypeSupported,
): string | null {
  return pickRecorderMimeType(isSupported);
}

/** Share/save filename for an exported swing, derived from the blob mimeType. */
export function exportFilename(shotIndex: number, mimeType: string): string {
  return storyFilename(`tonphet-swing-${shotIndex}`, mimeType);
}

// ===========================================================================
// DOM / canvas drawing (guarded; the render path is smoke-tested only)
// ===========================================================================

function createCanvas(w: number, h: number): HTMLCanvasElement {
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

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, 0, EXPORT_H);
  g.addColorStop(0, C_BG_TOP);
  g.addColorStop(0.45, C_BG_MID);
  g.addColorStop(1, C_BG_BOT);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, EXPORT_W, EXPORT_H);
}

/** Truncate `text` with an ellipsis so it fits within `maxW` px. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) {
    t = t.slice(0, -1);
  }
  return `${t}…`;
}

/**
 * Brand line: LEFT-aligned on the same left edge as the "ผู้ใช้งาน" and "#N"
 * lines below (v1.0.2 user feedback — centering rendered off-edge on their
 * device, and a single flush-left column reads cleaner). Prominent size.
 */
function drawHeader(ctx: CanvasRenderingContext2D): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C_ACCENT;
  ctx.font = `800 58px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, `🎾 ${BRAND}`, CONTENT_W), SIDE_PAD, 118);
}

/**
 * Left column: "ผู้ใช้งาน : <name>" on the TOP line (aligned with the score's
 * top, per user feedback), "#N · stroke" on the line below. Big semantic-
 * colored score on the right spans both lines.
 */
function drawTitleRow(
  ctx: CanvasRenderingContext2D,
  shotIndex: number,
  shotTypeLabel: string,
  score: number,
  rowY: number,
  playerName?: string,
  lang: Lang = 'th',
): void {
  ctx.textBaseline = 'alphabetic';

  // Score first (right) so the left column can ellipsis-clamp against it.
  ctx.textAlign = 'right';
  ctx.fillStyle = scoreExportColor(score);
  ctx.font = `800 96px ${FONT_STACK}`;
  const scoreText = String(Math.round(score));
  ctx.fillText(scoreText, EXPORT_W - SIDE_PAD, rowY + 14);
  const leftMaxW = CONTENT_W - ctx.measureText(scoreText).width - 40;

  // Left column: both lines share the SAME font (user feedback: equal sizes).
  ctx.textAlign = 'left';
  ctx.fillStyle = C_TEXT;
  ctx.font = `700 52px ${FONT_STACK}`;
  const name = (playerName ?? '').trim();
  if (name) {
    const label = lang === 'th' ? 'ผู้ใช้งาน' : 'Player';
    // Roomier line gap below the brand (user feedback: more breathing space).
    ctx.fillText(fitText(ctx, `${label} : ${name}`, leftMaxW), SIDE_PAD, rowY - 88);
  }

  // Unknown stroke type ⇒ just "#N" — never a "ไม่ทราบชนิด" placeholder.
  const typeLabel = (shotTypeLabel ?? '').trim();
  const shotLine = typeLabel ? `#${shotIndex}  ·  ${typeLabel}` : `#${shotIndex}`;
  ctx.fillText(fitText(ctx, shotLine, leftMaxW), SIDE_PAD, rowY);
}

function drawFrameBorder(ctx: CanvasRenderingContext2D, box: StoryRect): void {
  roundRectPath(ctx, box.x, box.y, box.w, box.h, FRAME_RADIUS);
  ctx.strokeStyle = C_BLUE;
  ctx.lineWidth = 4;
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Draw the currently-playing clip frame letterboxed inside the media box. */
function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  box: StoryRect,
): void {
  ctx.save();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, FRAME_RADIUS);
  ctx.clip();
  ctx.fillStyle = C_FRAME_BG;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const rect = containRect(vw, vh, box);
  try {
    ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
  } catch {
    /* frame not paintable yet — keep the frame bg for this tick */
  }
  ctx.restore();
  drawFrameBorder(ctx, box);
}

/** Canvas-2D port of RadarChart: rings, spokes+labels, target + value polygons. */
function drawRadar(
  ctx: CanvasRenderingContext2D,
  data: RadarDatum[],
  lang: Lang,
  radar: RadarLayout,
): void {
  const n = data.length;
  if (n === 0) return;
  const { cx, cy, r, labelFactor } = radar;

  // (v1.0.3) No title above the radar — the chart explains itself; the freed
  // space goes to a wider gap between the radar and the fix bullets below.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // grid rings
  ctx.strokeStyle = C_LINE;
  ctx.lineWidth = 1.5;
  for (const f of [0.25, 0.5, 0.75, 1]) {
    const pts = radarPolygon(Array(n).fill(f), cx, cy, r);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }

  // axis spokes + labels
  ctx.fillStyle = C_DIM;
  ctx.font = `500 22px ${FONT_STACK}`;
  data.forEach((d, i) => {
    const [ex, ey] = radarAxisPoint(i, n, 1, cx, cy, r);
    ctx.strokeStyle = C_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    const [lx, ly] = radarAxisPoint(i, n, labelFactor, cx, cy, r);
    ctx.textAlign = lx > cx + 1 ? 'left' : lx < cx - 1 ? 'right' : 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lang === 'th' ? d.labelTH : d.labelEN, lx, ly);
  });
  ctx.textBaseline = 'alphabetic';

  // target polygon (all-1.0 ring) — dashed green
  const target = radarPolygon(data.map((d) => d.target), cx, cy, r);
  ctx.strokeStyle = C_GOOD;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  target.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // value polygon — optic-yellow, translucent fill
  const value = radarPolygon(data.map((d) => d.value), cx, cy, r);
  ctx.beginPath();
  value.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = C_ACCENT;
  ctx.globalAlpha = 0.16;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = C_ACCENT;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // vertex dots
  ctx.fillStyle = C_ACCENT;
  value.forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** Worst-first improvement bullets, wrapped + clamped above the footer. */
function drawFixLines(
  ctx: CanvasRenderingContext2D,
  fixLines: string[],
  startY: number,
): void {
  const maxY = EXPORT_H - 120;
  const lineH = 50;
  const x = SIDE_PAD;
  const bulletX = x + 6;
  const textX = x + 40;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 36px ${FONT_STACK}`;
  const measure = (s: string) => ctx.measureText(s).width;
  let y = startY;
  for (const raw of fixLines) {
    if (y > maxY) break;
    const wrapped = wrapLines(raw, CONTENT_W - 40, measure);
    // bullet on the first visual line of each fix
    ctx.fillStyle = C_WARN;
    ctx.fillText('•', bulletX, y);
    ctx.fillStyle = C_TEXT;
    for (const line of wrapped) {
      if (y > maxY) break;
      ctx.fillText(line, textX, y);
      y += lineH;
    }
    y += 12; // gap between fixes
  }
}

function drawFooter(ctx: CanvasRenderingContext2D, lang: Lang): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C_DIM;
  ctx.font = `500 28px ${FONT_STACK}`;
  const tag = lang === 'th' ? 'ฝึกกับโค้ชต้นและเพชร' : 'Coached by Ton & Phet';
  ctx.fillText(`${tag}  ·  ${EXPORT_APP_URL}`, EXPORT_W / 2, EXPORT_H - 64);
}

/** Draw all static chrome (everything except the live video frame). */
function drawChrome(ctx: CanvasRenderingContext2D, opts: SwingExportOpts, layout: ExportLayout): void {
  drawHeader(ctx);
  drawTitleRow(
    ctx,
    opts.shotIndex,
    opts.shotTypeLabel,
    opts.score,
    layout.headerRowY,
    opts.playerName,
    opts.lang,
  );
  drawRadar(ctx, opts.radar, opts.lang, layout.radar);
  drawFixLines(ctx, opts.fixLines, layout.fixStartY);
  drawFooter(ctx, opts.lang);
}

// --- media helpers ----------------------------------------------------------

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
    // 8s: cloud clips stream over court LTE; 4s spuriously failed cold fetches.
    setTimeout(bad, 8000);
    try {
      video.load?.();
    } catch {
      bad();
    }
  });
}

/**
 * Create an AudioContext and kick off resume() synchronously. iOS starts the
 * graph suspended until a user gesture, so this MUST run inside the tap's
 * activation (before any await) — otherwise the mixed track is silent.
 */
function createResumedAudioContext(): AudioContext | null {
  const Ctx: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    const ctx = new Ctx();
    // Fire-and-forget: initiate resume now, while activation is still live.
    void ctx.resume?.().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Candidate mimeTypes to try when the stream carries an AUDIO track. The
 * swingRecorder chain was tuned for video-only streams; iOS Safari can throw
 * NotSupportedError constructing a recorder whose mimeType names only a video
 * codec while an audio track is present — which would kill exactly the
 * with-coach-voice exports. Order: audio-aware mp4 → the picked type → bare.
 */
export function audioAwareMimeCandidates(mime: string, hasAudio: boolean): string[] {
  if (!hasAudio) return [mime];
  const out: string[] = [];
  if (mime.startsWith('video/mp4;codecs=') && !/mp4a/.test(mime)) {
    out.push(`${mime},mp4a.40.2`);
  }
  out.push(mime);
  return out;
}

/**
 * Construct the MediaRecorder with a graceful fallback chain: each audio-aware
 * candidate with bitrate opts → bare constructor → drop the audio track(s) and
 * record silent video. Returns null only when every attempt throws.
 */
function createRecorderWithFallback(stream: MediaStream, mime: string): MediaRecorder | null {
  const hasAudio = stream.getAudioTracks().length > 0;
  for (const candidate of audioAwareMimeCandidates(mime, hasAudio)) {
    try {
      return new MediaRecorder(stream, {
        mimeType: candidate,
        videoBitsPerSecond: EXPORT_VIDEO_BITS_PER_SECOND,
      });
    } catch {
      /* try the next candidate */
    }
  }
  try {
    return new MediaRecorder(stream); // browser picks its own container
  } catch {
    /* fall through to silent-video attempt */
  }
  try {
    for (const t of stream.getAudioTracks()) stream.removeTrack(t);
    return new MediaRecorder(stream);
  } catch {
    return null;
  }
}

/** Fetch/read + decode the coach audio into `ctx`; resolves null on failure. */
async function decodeAudio(src: string | Blob, ctx: AudioContext): Promise<AudioBuffer | null> {
  try {
    const arrayBuf =
      typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : await src.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuf.slice(0));
  } catch {
    return null;
  }
}

// ===========================================================================
// PUBLIC RENDER (frozen contract)
// ===========================================================================

/**
 * Render a 9:16 export video: plays `clipSrc` letterboxed inside the history
 * chrome (score header, radar, fix bullets), mixing the coach voice in when
 * `audioSrc` is present. Loops the clip if the voice is longer; caps at 20s.
 * Returns null when MediaRecorder / captureStream is unsupported or the clip
 * can't be decoded. NEVER throws.
 */
export async function exportSwingVideo(opts: SwingExportOpts): Promise<Blob | null> {
  const mime = pickExportMimeType();
  if (
    !mime ||
    typeof document === 'undefined' ||
    typeof MediaRecorder === 'undefined'
  ) {
    return null;
  }

  let video: HTMLVideoElement | null = null;
  let audioCtx: AudioContext | null = null;
  let startAudio: (() => void) | null = null;
  let rafId = 0;
  // Created BEFORE any await so its resume() runs inside the tap's activation
  // (iOS keeps the graph suspended otherwise → silent export).
  if (opts.audioSrc) audioCtx = createResumedAudioContext();
  try {
    const canvas = createCanvas(EXPORT_W, EXPORT_H);
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.captureStream !== 'function') return null;

    video = document.createElement('video');
    video.muted = true; // muted element; real audio comes from the mixed track
    video.playsInline = true;
    video.preload = 'auto';
    video.src = opts.clipSrc;

    const ready = await waitVideoReady(video);
    if (!ready) return null;

    // --- audio (optional) ---
    let audioMs = 0;
    const stream = canvas.captureStream(EXPORT_FPS);
    if (opts.audioSrc && audioCtx) {
      const buffer = await decodeAudio(opts.audioSrc, audioCtx);
      if (buffer) {
        audioMs = buffer.duration * 1000;
        try {
          const dest = audioCtx.createMediaStreamDestination();
          const source = audioCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(dest);
          const track = dest.stream.getAudioTracks()[0];
          if (track) stream.addTrack(track);
          // Start playback once the recorder is running (below).
          startAudio = () => {
            try {
              source.start();
            } catch {
              /* ignore */
            }
          };
        } catch {
          /* mixing failed → export silent video */
        }
      }
    }

    // --- duration + loop decision (WebM <video>.duration is Infinity) ---
    const clipMs = Number.isFinite(opts.clipDurationMs) && (opts.clipDurationMs ?? 0) > 0
      ? (opts.clipDurationMs as number)
      : (video.duration || 0) * 1000;
    const durationMs = recordDurationMs(clipMs, audioMs);
    video.loop = shouldLoopClip(clipMs, audioMs);

    const layout = exportLayout();
    const recorder = createRecorderWithFallback(stream, mime);
    if (!recorder) return null;
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((res) => {
      recorder.onstop = () => res();
    });

    let running = true;
    const draw = () => {
      const v = video;
      if (!running || !v) return;
      try {
        drawBackground(ctx);
        drawVideoFrame(ctx, v, layout.video);
        drawChrome(ctx, opts, layout);
      } catch {
        /* drop one frame; keep recording */
      }
      rafId = requestAnimationFrame(draw);
    };

    // 1s timeslice: chunks accumulate DURING recording, so a slow final
    // encoder flush after stop() can't leave us with zero data.
    recorder.start(1000);
    rafId = requestAnimationFrame(draw);
    try {
      await video.play();
    } catch {
      /* autoplay may reject; the cap timer still bounds the recording */
    }
    startAudio?.();

    await new Promise<void>((res) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          res();
        }
      };
      // Natural end only ends recording early when we are NOT looping.
      if (!video!.loop) video!.onended = finish;
      setTimeout(finish, durationMs);
    });

    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* ignore */
    }
    // 8s: older phones can take seconds to finalize a 20s 1080×1920 encode.
    await Promise.race([stopped, new Promise<void>((r) => setTimeout(r, 8000))]);

    if (chunks.length === 0) return null;
    const blob = new Blob(chunks, { type: recorder.mimeType || mime });
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
    if (audioCtx) {
      try {
        await audioCtx.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Save a rendered export video to the device via an anchor download. Never
 * routed through navigator.share — Share is a separate action (shareStory).
 * NEVER throws.
 */
export function saveSwingVideo(blob: Blob, filename: string): void {
  try {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return;
    }
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
  } catch {
    /* nothing more we can do */
  }
}

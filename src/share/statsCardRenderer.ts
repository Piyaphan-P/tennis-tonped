// ============================================================================
// ADGE Tennis — session STATS card renderer (v1.8 stats widget + share)
//
// Renders the end-of-session stats overview into a share-worthy 1080×1920 PNG:
//   brand header · player name + date · 4 big metric tiles (minutes / shots /
//   ≈ swing speed / ≈ kcal) · a topspin/backspin/flat bar block · footer.
// Every metric shows the session figure big with the all-time figure beneath.
//
// A still PNG (no clip/audio) — so this ALWAYS resolves a Blob (like
// storyRenderer.renderStoryImage). The two-step activation-safe Save/Share is
// handled by StatsShareButton, reusing shareStory() (native sheet + download +
// hang watchdog) and storyFilename() unchanged.
//
// No React. Canvas can't read CSS vars, so the palette is mirrored as hex
// (kept in sync with theme.css / storyRenderer). Pure layout/format/filename
// helpers are exported for unit tests; the DOM render is smoke-tested only.
// ============================================================================

import { wrapLines, storyFilename, STORY_APP_URL, type StoryRect } from './storyRenderer';
import type { Lang } from '../types';

// ---------------------------------------------------------------------------
// Canvas / layout constants (portrait share format)
// ---------------------------------------------------------------------------

export const STATS_W = 1080;
export const STATS_H = 1920;

/** Brand header — the ONE canonical spelling. Never "ต้นเป็ด" / "TonPed". */
const BRAND = 'ADGE Tennis';

const SIDE_PAD = 72;
const CONTENT_W = STATS_W - SIDE_PAD * 2;
const TILE_GAP = 28;
const TILE_RADIUS = 28;

// --- palette (mirrors theme.css / storyRenderer) ----------------------------
const C_BG_TOP = '#14352b';
const C_BG_MID = '#0e1a19';
const C_BG_BOT = '#0a1113';
const C_TEXT = '#f2f6f4';
const C_DIM = '#9fb0ad';
const C_ACCENT = '#d6f441'; // optic yellow
const C_BLUE = '#4fc0e6'; // hardcourt blue
const C_GOOD = '#39d08a';
const C_WARN = '#f1a24a';
const C_TILE_BG = 'rgba(255,255,255,0.05)';
const C_LINE = 'rgba(255,255,255,0.14)';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans Thai", sans-serif';

// ===========================================================================
// PUBLIC DATA CONTRACT
// ===========================================================================

/** Spin percentages (0–100) — session mix. */
export interface StatsSpinPct {
  topspin: number;
  backspin: number;
  flat: number;
}

export interface StatsCardData {
  lang: Lang;
  playerName?: string;
  /** Already-localized date string (footer). */
  dateLabel: string;

  // --- this session (prominent) ---
  minutes: number;
  shots: number;
  /** ≈ km/h; undefined → shown as "—". */
  avgSpeedKmh: number | undefined;
  kcal: number;
  spin: StatsSpinPct;

  // --- all sessions (secondary line per tile) ---
  cumMinutes: number;
  cumShots: number;
  cumAvgSpeedKmh: number | undefined;
  cumKcal: number;
}

// ===========================================================================
// PURE HELPERS (unit-tested; no DOM)
// ===========================================================================

/** Whole-number-ish minutes label ("12 นาที" / "12 min"). */
export function formatMinutes(minutes: number, lang: Lang): string {
  const n = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  return lang === 'th' ? `${n} นาที` : `${n} min`;
}

/** "≈ 58" (km/h number, unit drawn separately) or "—" when absent. */
export function formatSpeedValue(kmh: number | undefined): string {
  if (kmh === undefined || !Number.isFinite(kmh) || kmh <= 0) return '—';
  return `≈ ${Math.round(kmh)}`;
}

/** Share/save filename for the stats card PNG. */
export function statsCardFilename(): string {
  return storyFilename('adge-stats', 'image/png');
}

export interface StatsTileRect extends StoryRect {}

export interface StatsLayout {
  /** 2×2 grid of metric tiles. */
  tiles: [StatsTileRect, StatsTileRect, StatsTileRect, StatsTileRect];
  /** Spin block box. */
  spin: StatsTileRect;
}

/**
 * Fixed 1080×1920 layout (pure so it is unit-testable). A 2×2 metric grid
 * under the header, then a full-width spin block above the footer. Clearances
 * (grid inside content width, spin block above the footer) are asserted in the
 * test.
 */
export function statsCardLayout(): StatsLayout {
  const gridTop = 380;
  const tileW = (CONTENT_W - TILE_GAP) / 2;
  const tileH = 300;
  const col2X = SIDE_PAD + tileW + TILE_GAP;
  const row2Y = gridTop + tileH + TILE_GAP;
  const tiles: [StatsTileRect, StatsTileRect, StatsTileRect, StatsTileRect] = [
    { x: SIDE_PAD, y: gridTop, w: tileW, h: tileH },
    { x: col2X, y: gridTop, w: tileW, h: tileH },
    { x: SIDE_PAD, y: row2Y, w: tileW, h: tileH },
    { x: col2X, y: row2Y, w: tileW, h: tileH },
  ];
  const spinY = row2Y + tileH + 48;
  return {
    tiles,
    spin: { x: SIDE_PAD, y: spinY, w: CONTENT_W, h: 420 },
  };
}

// ===========================================================================
// DOM / canvas drawing (guarded; smoke-tested only)
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
  const g = ctx.createLinearGradient(0, 0, 0, STATS_H);
  g.addColorStop(0, C_BG_TOP);
  g.addColorStop(0.45, C_BG_MID);
  g.addColorStop(1, C_BG_BOT);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, STATS_W, STATS_H);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function drawHeader(ctx: CanvasRenderingContext2D, data: StatsCardData): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C_ACCENT;
  ctx.font = `800 58px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, `🎾 ${BRAND}`, CONTENT_W), SIDE_PAD, 118);

  ctx.fillStyle = C_TEXT;
  ctx.font = `700 44px ${FONT_STACK}`;
  const title = data.lang === 'th' ? 'สรุปการฝึก' : 'Session summary';
  ctx.fillText(fitText(ctx, title, CONTENT_W), SIDE_PAD, 196);

  const name = (data.playerName ?? '').trim();
  if (name) {
    ctx.fillStyle = C_DIM;
    ctx.font = `500 34px ${FONT_STACK}`;
    const label = data.lang === 'th' ? 'ผู้ใช้งาน' : 'Player';
    ctx.fillText(fitText(ctx, `${label} : ${name}`, CONTENT_W), SIDE_PAD, 252);
  }
}

/** One metric tile: label · big session value (+ unit) · "รวมทุกครั้ง: X" line. */
function drawTile(
  ctx: CanvasRenderingContext2D,
  box: StatsTileRect,
  label: string,
  value: string,
  unit: string,
  cumLabel: string,
  accent: string,
): void {
  roundRectPath(ctx, box.x, box.y, box.w, box.h, TILE_RADIUS);
  ctx.fillStyle = C_TILE_BG;
  ctx.fill();
  ctx.strokeStyle = C_LINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const padX = 32;
  const x = box.x + padX;
  const maxW = box.w - padX * 2;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C_DIM;
  ctx.font = `600 30px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, label, maxW), x, box.y + 60);

  ctx.fillStyle = accent;
  ctx.font = `800 96px ${FONT_STACK}`;
  const valText = fitText(ctx, value, maxW);
  ctx.fillText(valText, x, box.y + 176);
  if (unit) {
    const vw = ctx.measureText(valText).width;
    ctx.fillStyle = C_DIM;
    ctx.font = `600 34px ${FONT_STACK}`;
    ctx.fillText(fitText(ctx, unit, maxW - vw - 14), x + vw + 14, box.y + 176);
  }

  ctx.fillStyle = C_DIM;
  ctx.font = `500 28px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, cumLabel, maxW), x, box.y + 244);
}

/** Spin block: title, three labeled proportional bars, "no ball sensor" note. */
function drawSpin(ctx: CanvasRenderingContext2D, box: StatsTileRect, data: StatsCardData): void {
  const th = data.lang === 'th';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C_TEXT;
  ctx.font = `700 38px ${FONT_STACK}`;
  ctx.fillText(th ? 'สปิน (ประมาณจากวงสวิง)' : 'Spin (from swing path)', box.x, box.y + 6);

  const rows: Array<{ label: string; pct: number; color: string }> = [
    { label: th ? 'topspin (ตวัดขึ้น)' : 'Topspin', pct: data.spin.topspin, color: C_GOOD },
    { label: th ? 'backspin (สไลซ์)' : 'Backspin', pct: data.spin.backspin, color: C_BLUE },
    { label: th ? 'flat (เรียบ)' : 'Flat', pct: data.spin.flat, color: C_WARN },
  ];

  const barX = box.x;
  const barW = box.w;
  const rowH = 96;
  let y = box.y + 62;
  for (const r of rows) {
    ctx.fillStyle = C_DIM;
    ctx.font = `600 30px ${FONT_STACK}`;
    ctx.fillText(r.label, barX, y + 26);
    ctx.textAlign = 'right';
    ctx.fillStyle = C_TEXT;
    ctx.font = `700 32px ${FONT_STACK}`;
    ctx.fillText(`${Math.round(r.pct)}%`, barX + barW, y + 26);
    ctx.textAlign = 'left';

    const trackY = y + 42;
    const trackH = 22;
    roundRectPath(ctx, barX, trackY, barW, trackH, trackH / 2);
    ctx.fillStyle = C_LINE;
    ctx.fill();
    const fillW = Math.max(0, Math.min(1, r.pct / 100)) * barW;
    if (fillW > 1) {
      roundRectPath(ctx, barX, trackY, fillW, trackH, trackH / 2);
      ctx.fillStyle = r.color;
      ctx.fill();
    }
    y += rowH;
  }
}

function drawFooter(ctx: CanvasRenderingContext2D, data: StatsCardData): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C_DIM;
  ctx.font = `500 26px ${FONT_STACK}`;
  const note =
    data.lang === 'th'
      ? 'แคลอรีเป็นค่าประมาณ · สถิติรวม 3 วันล่าสุด'
      : 'Calories are an estimate · all-time = last 3 days';
  const measure = (s: string) => ctx.measureText(s).width;
  const lines = wrapLines(note, CONTENT_W, measure).slice(0, 2);
  let ny = STATS_H - 138;
  for (const line of lines) {
    ctx.fillText(line, STATS_W / 2, ny);
    ny += 34;
  }

  ctx.fillStyle = C_ACCENT;
  ctx.font = `500 28px ${FONT_STACK}`;
  const tag = data.lang === 'th' ? 'ฝึกกับโค้ช ADGE' : 'Coached by ADGE';
  ctx.fillText(`${tag}  ·  ${data.dateLabel}  ·  ${STORY_APP_URL}`, STATS_W / 2, STATS_H - 64);
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

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve) => {
    try {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((b) => resolve(b ?? new Blob([], { type })), type, 0.92);
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

// ===========================================================================
// PUBLIC RENDER (frozen contract)
// ===========================================================================

/**
 * Render the 1080×1920 stats card PNG. Best-effort but ALWAYS resolves a Blob
 * (empty image/png on a hard failure) so callers can share/save. Never throws.
 */
export async function renderStatsCard(data: StatsCardData): Promise<Blob> {
  const emptyPng = () => new Blob([], { type: 'image/png' });
  try {
    if (typeof document === 'undefined') return emptyPng();
    const canvas = createCanvas(STATS_W, STATS_H);
    const ctx = canvas.getContext('2d');
    if (!ctx) return emptyPng();

    const th = data.lang === 'th';
    const layout = statsCardLayout();

    drawBackground(ctx);
    drawHeader(ctx, data);

    const cum = (label: string) => (th ? `รวมทุกครั้ง: ${label}` : `All-time: ${label}`);
    const speedUnit = th ? 'กม./ชม.' : 'km/h';

    drawTile(
      ctx,
      layout.tiles[0],
      th ? 'นาทีที่ตี' : 'Minutes played',
      String(Math.round(data.minutes)),
      th ? 'นาที' : 'min',
      cum(`${Math.round(data.cumMinutes)} ${th ? 'นาที' : 'min'}`),
      C_ACCENT,
    );
    drawTile(
      ctx,
      layout.tiles[1],
      th ? 'ตีโดนลูก' : 'Balls hit',
      String(Math.round(data.shots)),
      th ? 'ครั้ง' : 'shots',
      cum(String(Math.round(data.cumShots))),
      C_BLUE,
    );
    drawTile(
      ctx,
      layout.tiles[2],
      th ? 'ความเร็วสวิงเฉลี่ย' : 'Avg swing speed',
      formatSpeedValue(data.avgSpeedKmh),
      data.avgSpeedKmh === undefined ? '' : speedUnit,
      cum(
        data.cumAvgSpeedKmh === undefined
          ? '—'
          : `${formatSpeedValue(data.cumAvgSpeedKmh)} ${speedUnit}`,
      ),
      C_GOOD,
    );
    drawTile(
      ctx,
      layout.tiles[3],
      th ? 'เผาผลาญ (ประมาณ)' : 'Burned (est.)',
      `≈ ${Math.round(data.kcal)}`,
      'kcal',
      cum(`≈ ${Math.round(data.cumKcal)} kcal`),
      C_WARN,
    );

    drawSpin(ctx, layout.spin, data);
    drawFooter(ctx, data);

    return await canvasToBlob(canvas, 'image/png');
  } catch {
    return emptyPng();
  }
}

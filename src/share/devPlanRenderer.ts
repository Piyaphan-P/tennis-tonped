// ============================================================================
// ADGE Tennis — Development-Plan card renderer (v2.4)
//
// The DevPlan "แชร์สรุปวันนี้" share used to be wired to storyRenderer, which is
// a per-swing PHOTO/CLIP story — so the shared card showed the player's swing
// picture instead of the development plan. This renderer draws the PLAN itself:
// a 1080×1920 text card listing the top coaching areas with the
// อาการ → เพราะอะไร → วิธีซ้อม → cue guidance (already-resolved copy passed in,
// so this stays i18n-free like statsCardRenderer). NO swing photo/clip.
//
// Always resolves a Blob (empty image/png on hard failure); never throws. The
// two-step activation-safe Save/Share lives in DevPlanShareButton, reusing
// shareStory()/saveSwingVideo() unchanged. Pure layout/format helpers exported
// for unit tests; DOM render smoke-tested only.
// ============================================================================

import { wrapLines, storyFilename, STORY_APP_URL } from './storyRenderer';
import type { Lang } from '../types';

export const PLAN_W = 1080;
export const PLAN_H = 1920;

/** Brand header — the ONE canonical spelling. Never "ต้นเป็ด" / "TonPed". */
const BRAND = 'ADGE Tennis';

const SIDE_PAD = 72;
const CONTENT_W = PLAN_W - SIDE_PAD * 2;
const CARD_RADIUS = 28;

// --- palette (mirrors theme.css / statsCardRenderer) ------------------------
const C_BG_TOP = '#14352b';
const C_BG_MID = '#0e1a19';
const C_BG_BOT = '#0a1113';
const C_TEXT = '#f2f6f4';
const C_DIM = '#9fb0ad';
const C_ACCENT = '#d6f441'; // optic yellow
const C_GOOD = '#39d08a';
const C_FAULT = '#f16a6a';
const C_CARD_BG = 'rgba(255,255,255,0.05)';
const C_LINE = 'rgba(255,255,255,0.14)';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans Thai", sans-serif';

// ===========================================================================
// PUBLIC DATA CONTRACT
// ===========================================================================

/** One coaching area, with its copy already localized by the caller. */
export interface PlanAreaCard {
  title: string;
  symptom: string;
  why: string;
  drill: string;
  cue: string;
  /** How many shots this area was seen in (0 → the "affected" line is hidden). */
  shots: number;
}

export interface DevPlanCardData {
  lang: Lang;
  playerName?: string;
  /** Already-localized date string (header + footer). */
  dateLabel: string;
  /** Top coaching areas (worst first). Empty ⇒ the "clean form" positive card. */
  areas: PlanAreaCard[];
  /** Positive message shown when `areas` is empty (a clean session). */
  cleanTitle: string;
  cleanBody: string;
  /** Section labels (localized): [symptom, why, drill, cue, affected, shotsUnit]. */
  labels: {
    guideTitle: string;
    symptom: string;
    why: string;
    drill: string;
    cue: string;
    affected: string;
    shotsUnit: string;
  };
}

// ===========================================================================
// PURE HELPERS (unit-tested; no DOM)
// ===========================================================================

/** Share/save filename for the dev-plan card PNG. */
export function devPlanCardFilename(): string {
  return storyFilename('adge-devplan', 'image/png');
}

/** How many area cards fit the fixed layout (keeps the card from overflowing). */
export const MAX_PLAN_AREAS = 3;

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
  const g = ctx.createLinearGradient(0, 0, 0, PLAN_H);
  g.addColorStop(0, C_BG_TOP);
  g.addColorStop(0.45, C_BG_MID);
  g.addColorStop(1, C_BG_BOT);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PLAN_W, PLAN_H);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

function drawHeader(ctx: CanvasRenderingContext2D, data: DevPlanCardData): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C_ACCENT;
  ctx.font = `800 58px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, `🎾 ${BRAND}`, CONTENT_W), SIDE_PAD, 118);

  ctx.fillStyle = C_TEXT;
  ctx.font = `700 46px ${FONT_STACK}`;
  const title = data.lang === 'th' ? 'แผนพัฒนา' : 'Development Plan';
  ctx.fillText(fitText(ctx, title, CONTENT_W), SIDE_PAD, 192);

  const name = (data.playerName ?? '').trim();
  const sub = name
    ? `${data.lang === 'th' ? 'ผู้ใช้งาน' : 'Player'} : ${name}  ·  ${data.dateLabel}`
    : data.dateLabel;
  ctx.fillStyle = C_DIM;
  ctx.font = `500 32px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, sub, CONTENT_W), SIDE_PAD, 248);
}

/** One guidance row (tag + wrapped text); returns the y after the row. */
function drawGuideRow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  maxW: number,
  label: string,
  text: string,
  tagColor: string,
): number {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = tagColor;
  ctx.font = `700 28px ${FONT_STACK}`;
  ctx.fillText(label, x, y);

  ctx.fillStyle = C_TEXT;
  ctx.font = `400 30px ${FONT_STACK}`;
  const measure = (s: string) => ctx.measureText(s).width;
  const lines = wrapLines(text, maxW, measure).slice(0, 2);
  let ly = y + 42;
  for (const line of lines) {
    ctx.fillText(line, x, ly);
    ly += 40;
  }
  return ly + 8;
}

/** One area card. Returns the y-bottom used (caller advances). */
function drawAreaCard(
  ctx: CanvasRenderingContext2D,
  y: number,
  rank: number,
  area: PlanAreaCard,
  data: DevPlanCardData,
): number {
  const padX = 36;
  const x = SIDE_PAD + padX;
  const maxW = CONTENT_W - padX * 2;
  const cardH = 356;

  roundRectPath(ctx, SIDE_PAD, y, CONTENT_W, cardH, CARD_RADIUS);
  ctx.fillStyle = C_CARD_BG;
  ctx.fill();
  ctx.strokeStyle = C_LINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Title row: rank dot + title (+ "seen in N shots").
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C_ACCENT;
  ctx.font = `800 40px ${FONT_STACK}`;
  ctx.fillText(`${rank}`, x, y + 58);
  ctx.fillStyle = C_TEXT;
  ctx.font = `700 36px ${FONT_STACK}`;
  const titleX = x + 44;
  ctx.fillText(fitText(ctx, area.title, maxW - 44), titleX, y + 58);
  if (area.shots > 0) {
    ctx.fillStyle = C_DIM;
    ctx.font = `500 26px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.fillText(
      `${data.labels.affected} ${area.shots} ${data.labels.shotsUnit}`,
      SIDE_PAD + CONTENT_W - padX,
      y + 56,
    );
    ctx.textAlign = 'left';
  }

  let ry = y + 116;
  ry = drawGuideRow(ctx, x, ry, maxW, data.labels.symptom, area.symptom, C_FAULT);
  ry = drawGuideRow(ctx, x, ry, maxW, data.labels.drill, area.drill, C_GOOD);

  // Cue (quoted, accent).
  ctx.fillStyle = C_ACCENT;
  ctx.font = `600 28px ${FONT_STACK}`;
  ctx.fillText(fitText(ctx, `${data.labels.cue}: “${area.cue}”`, maxW), x, ry + 6);

  return y + cardH;
}

/** The clean-session positive card (no faults this session). */
function drawCleanCard(ctx: CanvasRenderingContext2D, y: number, data: DevPlanCardData): void {
  const padX = 36;
  const x = SIDE_PAD + padX;
  const maxW = CONTENT_W - padX * 2;
  const cardH = 420;

  roundRectPath(ctx, SIDE_PAD, y, CONTENT_W, cardH, CARD_RADIUS);
  ctx.fillStyle = C_CARD_BG;
  ctx.fill();
  ctx.strokeStyle = C_LINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C_GOOD;
  ctx.font = `800 44px ${FONT_STACK}`;
  const measure = (s: string) => ctx.measureText(s).width;
  const titleLines = wrapLines(data.cleanTitle, maxW, measure).slice(0, 2);
  let ly = y + 80;
  for (const line of titleLines) {
    ctx.fillText(line, x, ly);
    ly += 56;
  }

  ctx.fillStyle = C_TEXT;
  ctx.font = `400 34px ${FONT_STACK}`;
  const bodyLines = wrapLines(data.cleanBody, maxW, measure).slice(0, 5);
  ly += 12;
  for (const line of bodyLines) {
    ctx.fillText(line, x, ly);
    ly += 46;
  }
}

function drawFooter(ctx: CanvasRenderingContext2D, data: DevPlanCardData): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C_ACCENT;
  ctx.font = `500 28px ${FONT_STACK}`;
  const tag = data.lang === 'th' ? 'ฝึกกับโค้ช ADGE' : 'Coached by ADGE';
  ctx.fillText(`${tag}  ·  ${STORY_APP_URL}`, PLAN_W / 2, PLAN_H - 64);
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
 * Render the 1080×1920 development-plan card PNG. Best-effort but ALWAYS
 * resolves a Blob (empty image/png on a hard failure). Never throws. When
 * `areas` is empty renders the positive clean-session card instead of a blank.
 */
export async function renderDevPlanCard(data: DevPlanCardData): Promise<Blob> {
  const emptyPng = () => new Blob([], { type: 'image/png' });
  try {
    if (typeof document === 'undefined') return emptyPng();
    const canvas = createCanvas(PLAN_W, PLAN_H);
    const ctx = canvas.getContext('2d');
    if (!ctx) return emptyPng();

    drawBackground(ctx);
    drawHeader(ctx, data);

    const areas = data.areas.slice(0, MAX_PLAN_AREAS);
    if (areas.length === 0) {
      drawCleanCard(ctx, 340, data);
    } else {
      // Section label above the cards.
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = C_DIM;
      ctx.font = `600 32px ${FONT_STACK}`;
      ctx.fillText(fitText(ctx, data.labels.guideTitle, CONTENT_W), SIDE_PAD, 320);

      let y = 360;
      areas.forEach((area, i) => {
        const bottom = drawAreaCard(ctx, y, i + 1, area, data);
        y = bottom + 28;
      });
    }

    drawFooter(ctx, data);
    return await canvasToBlob(canvas, 'image/png');
  } catch {
    return emptyPng();
  }
}

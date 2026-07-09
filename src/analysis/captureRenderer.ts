// ============================================================================
// ADGE Tennis — swing-capture renderer + shared skeleton drawer
//
// Two exports:
//   • drawSkeleton() — the SINGLE source of truth for skeleton coloring. Used
//     BOTH by the live overlay (PoseCanvas) and by captured-frame rendering, so
//     the two never diverge. Bones start GREY (neutral / tracked movement) and
//     turn GREEN/AMBER/RED per the angle-group form status, with precedence
//     fault > warn > good > neutral when a bone belongs to several groups.
//   • renderCaptureToDataUrl() — draws a SwingCapture's JPEG to an offscreen
//     canvas, then overlays the colored skeleton, and returns a data: URL for
//     an <img>. Async because it must decode the JPEG first.
//
// COORDINATE / MIRROR CONTRACT (critical): MediaPipe landmarks and the raw
// video pixels drawImage() samples are both in the UN-mirrored intrinsic frame.
// The live <video> is only *visually* mirrored via CSS scaleX(-1) for a front
// camera. So:
//   • live overlay  → drawSkeleton(..., mirrored = <front camera?>)
//   • captured image → drawSkeleton(..., mirrored = false)   (raw pixels)
// The mirror is baked into the coordinate map, never into the context, so any
// future text stays upright.
// ============================================================================

import { LM, angleSegments } from '../types';
import type {
  AngleKey,
  AngleStatuses,
  DominantHand,
  JointStatus,
  Landmark,
  SwingCapture,
} from '../types';

// --- palette (hex; canvas can't read CSS vars) ------------------------------
const COLOR_NEUTRAL = '#8a9ba0'; // grey — tracked movement, no judgement
const COLOR_GOOD = '#39d08a';
const COLOR_WARN = '#f1a24a';
const COLOR_FAULT = '#ff6a4d';
const COLOR_WRIST = '#4fc0e6'; // hardcourt blue — dominant wrist marker

const MIN_VIS = 0.3;

const STATUS_PRIORITY: Record<JointStatus, number> = {
  neutral: 0,
  good: 1,
  warn: 2,
  fault: 3,
};

/** Skeleton bone connections (MediaPipe indices). */
const BONES: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
];

/** Map any joint status to its skeleton/arc color. */
export function colorForStatus(status: JointStatus): string {
  switch (status) {
    case 'good':
      return COLOR_GOOD;
    case 'warn':
      return COLOR_WARN;
    case 'fault':
      return COLOR_FAULT;
    default:
      return COLOR_NEUTRAL;
  }
}

function boneKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function visible(lm: Landmark | undefined): boolean {
  return !!lm && (lm.visibility === undefined || lm.visibility >= MIN_VIS);
}

/**
 * Build the per-bone status map from the angle-group statuses, honoring the
 * fault > warn > good > neutral precedence when a bone is shared across groups.
 */
function buildBoneStatuses(
  statuses: AngleStatuses | null,
  hand: DominantHand,
): Map<string, JointStatus> {
  const map = new Map<string, JointStatus>();
  if (!statuses) return map;
  const segs = angleSegments(hand);
  (Object.keys(segs) as AngleKey[]).forEach((key) => {
    const st = statuses[key];
    if (st === 'neutral') return;
    for (const [a, b] of segs[key]) {
      const k = boneKey(a, b);
      const prev = map.get(k);
      if (!prev || STATUS_PRIORITY[st] > STATUS_PRIORITY[prev]) map.set(k, st);
    }
  });
  return map;
}

/**
 * Draw the colored skeleton onto `ctx`, sized to (w, h) in the ctx's own pixel
 * units, from normalized [0..1] landmarks. `mirrored` flips X (front camera /
 * mirrored video); pass false for captured raw frames. Shared by the live
 * overlay and the capture renderer so both color identically.
 */
export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  landmarks: Landmark[] | undefined,
  statuses: AngleStatuses | null,
  hand: DominantHand,
  mirrored: boolean,
): void {
  if (!landmarks || landmarks.length < 33) return;
  const lm = landmarks;
  const px = (x: number): number => (mirrored ? 1 - x : x) * w;
  const py = (y: number): number => y * h;

  const boneStatuses = buildBoneStatuses(statuses, hand);

  // --- bones: grey baseline, colored where a form rule applies ---
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    const la = lm[a];
    const lb = lm[b];
    if (!visible(la) || !visible(lb)) continue;
    const st = boneStatuses.get(boneKey(a, b));
    if (st && st !== 'neutral') {
      ctx.strokeStyle = colorForStatus(st);
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 4;
    } else {
      ctx.strokeStyle = COLOR_NEUTRAL;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 3;
    }
    ctx.beginPath();
    ctx.moveTo(px(la.x), py(la.y));
    ctx.lineTo(px(lb.x), py(lb.y));
    ctx.stroke();
  }

  // --- joints (grey dots) ---
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = COLOR_NEUTRAL;
  const seen = new Set<number>();
  for (const [a, b] of BONES) {
    for (const idx of [a, b]) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      const p = lm[idx];
      if (!visible(p)) continue;
      ctx.beginPath();
      ctx.arc(px(p.x), py(p.y), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- dominant wrist highlight (hardcourt blue) ---
  const wristIdx = hand === 'left' ? LM.LEFT_WRIST : LM.RIGHT_WRIST;
  const wrist = lm[wristIdx];
  if (visible(wrist)) {
    ctx.beginPath();
    ctx.fillStyle = COLOR_WRIST;
    ctx.arc(px(wrist.x), py(wrist.y), 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * Decode a capture's JPEG, draw it, overlay the colored skeleton (un-mirrored,
 * to match the raw pixels), and return a data: URL. Rejects if the JPEG fails
 * to decode. Runs off the render loop — call once per capture and memoize by id.
 */
export function renderCaptureToDataUrl(
  capture: SwingCapture,
  dominantHand: DominantHand,
): Promise<string> {
  const src = `data:image/jpeg;base64,${capture.jpegBase64}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 640;
      const h = img.naturalHeight || 480;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        // No 2D context — fall back to the raw frame rather than failing.
        resolve(src);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      drawSkeleton(ctx, w, h, capture.landmarks, capture.statuses, dominantHand, false);
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch {
        resolve(src);
      }
    };
    img.onerror = () => reject(new Error('capture image decode failed'));
    img.src = src;
  });
}

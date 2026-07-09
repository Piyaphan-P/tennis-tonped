// ============================================================================
// ADGE Tennis — skeleton overlay canvas
//
// A transparent <canvas> that fills its (position:relative) parent and draws the
// MediaPipe skeleton over the camera video. PERF CONTRACT: it never re-renders
// per pose frame. It subscribes imperatively to the store and draws on the 2D
// context, reading the latest pose via getState(). Mirrors horizontally to match
// a front-camera (mirrored) video so the overlay lines up with the player.
//
// Skeleton coloring is delegated to drawSkeleton() in analysis/captureRenderer
// so the live overlay and captured frames color IDENTICALLY (grey = tracked,
// green/amber/red = form status). This component adds the angle arcs + numeric
// badges on top, colored from the same store.pose.statuses.
// ============================================================================

import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { LM } from '../types';
import type { AngleStatuses, JointAngles, JointStatus, Landmark, PoseFrame } from '../types';
import { drawSkeleton, colorForStatus } from '../analysis/captureRenderer';

interface PoseCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  /** True when the underlying video is mirrored (front camera). */
  mirrored: boolean;
}

const COLOR_BADGE_BG = 'rgba(10, 17, 19, 0.72)';
const MIN_VIS = 0.3;

function visible(lm: Landmark | undefined): boolean {
  return !!lm && (lm.visibility === undefined || lm.visibility >= MIN_VIS);
}

export default function PoseCanvas({ videoRef, mirrored }: PoseCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Keep the backing store matched to the displayed size * DPR.
    function resize(): void {
      const c = canvasRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(c.clientWidth * dpr);
      const h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }

    function drawPose(
      frame: PoseFrame | null,
      angles: JointAngles | null,
      statuses: AngleStatuses | null,
    ): void {
      const c = canvasRef.current;
      if (!c || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = c.clientWidth;
      const cssH = c.clientHeight;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);

      const lm = frame?.landmarks;
      if (!lm || lm.length < 33) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const dominantHand = useAppStore.getState().settings.dominantHand;

      // Shared skeleton (grey baseline + status coloring), mirrored to match the
      // displayed front-camera video.
      drawSkeleton(ctx, cssW, cssH, lm, statuses, dominantHand, mirrored);

      const px = (x: number): number => (mirrored ? 1 - x : x) * cssW;
      const py = (y: number): number => y * cssH;

      // --- angle arcs + numeric badges, colored from the store statuses ---
      if (angles) {
        const elbowShoulder = dominantHand === 'left' ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER;
        const elbowJoint = dominantHand === 'left' ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW;
        const elbowWrist = dominantHand === 'left' ? LM.LEFT_WRIST : LM.RIGHT_WRIST;
        const elbowDeg = dominantHand === 'left' ? angles.leftElbowDeg : angles.rightElbowDeg;
        const st = (k: keyof AngleStatuses): JointStatus => statuses?.[k] ?? 'neutral';

        drawAngle(
          ctx,
          lm[elbowShoulder],
          lm[elbowJoint],
          lm[elbowWrist],
          elbowDeg,
          colorForStatus(st('domElbow')),
          px,
          py,
        );
        drawAngle(
          ctx,
          lm[LM.LEFT_HIP],
          lm[LM.LEFT_KNEE],
          lm[LM.LEFT_ANKLE],
          angles.leftKneeDeg,
          colorForStatus(st('leftKnee')),
          px,
          py,
        );
        drawAngle(
          ctx,
          lm[LM.RIGHT_HIP],
          lm[LM.RIGHT_KNEE],
          lm[LM.RIGHT_ANKLE],
          angles.rightKneeDeg,
          colorForStatus(st('rightKnee')),
          px,
          py,
        );
      }
    }

    // Initial size + first paint.
    resize();
    const pose0 = useAppStore.getState().pose;
    drawPose(pose0.frame, pose0.angles, pose0.statuses);

    // Draw on pose-frame change only (avoid idle redraws on unrelated state).
    let lastFrame: PoseFrame | null = pose0.frame;
    const unsub = useAppStore.subscribe((state) => {
      const { frame, angles, statuses } = state.pose;
      if (frame === lastFrame) return;
      lastFrame = frame;
      drawPose(frame, angles, statuses);
    });

    // Track displayed-size changes (rotation, layout, DPR moves).
    const ro = new ResizeObserver(() => {
      resize();
      const pose = useAppStore.getState().pose;
      drawPose(pose.frame, pose.angles, pose.statuses);
    });
    ro.observe(canvas);

    return () => {
      unsub();
      ro.disconnect();
    };
    // videoRef is accepted for API symmetry; the canvas sizes to its own parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirrored]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
}

/**
 * Draw the interior-angle arc at joint `b` (formed by b->a and b->c) plus a
 * mono numeric badge in `color`. Skips silently if any of the three landmarks
 * is missing or low-visibility.
 */
function drawAngle(
  ctx: CanvasRenderingContext2D,
  a: Landmark | undefined,
  b: Landmark | undefined,
  c: Landmark | undefined,
  deg: number,
  color: string,
  px: (x: number) => number,
  py: (y: number) => number,
): void {
  if (!visible(a) || !visible(b) || !visible(c)) return;
  const ax = px(a!.x);
  const ay = py(a!.y);
  const bx = px(b!.x);
  const by = py(b!.y);
  const cx = px(c!.x);
  const cy = py(c!.y);

  const a1 = Math.atan2(ay - by, ax - bx);
  const a2 = Math.atan2(cy - by, cx - bx);

  // Shortest signed sweep between the two bone directions (the interior angle).
  let diff = a2 - a1;
  while (diff <= -Math.PI) diff += Math.PI * 2;
  while (diff > Math.PI) diff -= Math.PI * 2;

  const radius = 22;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.95;
  ctx.arc(bx, by, radius, a1, a1 + diff, diff < 0);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Badge placed along the angle bisector, just outside the arc.
  const bis = a1 + diff / 2;
  const label = `${Math.round(deg)}°`;
  const labelX = bx + Math.cos(bis) * (radius + 14);
  const labelY = by + Math.sin(bis) * (radius + 14);

  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  const padX = 5;
  const bw = tw + padX * 2;
  const bh = 16;
  roundRect(ctx, labelX - bw / 2, labelY - bh / 2, bw, bh, 5);
  ctx.fillStyle = COLOR_BADGE_BG;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(label, labelX, labelY);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

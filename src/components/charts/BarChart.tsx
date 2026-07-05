// ============================================================================
// ต้นและเพชร Tennis Club — hand-rolled SVG bar chart of per-shot scores.
// No chart lib. Bar color bands (good/warn/fault) come from theme.css tokens,
// with the shot index printed under every bar so identity is never color-alone.
// Wide sessions scroll horizontally inside .barchart-wrap (set in history.css).
// ============================================================================

import type { Lang } from '../../types';

interface Props {
  /** Per-shot scores 0..100, in shot order. */
  values: number[];
  /** Guide line + good-band threshold. Default 80. */
  goodThreshold?: number;
  lang: Lang;
}

const H = 150;
const PAD_TOP = 10;
const PAD_BOTTOM = 20; // room for x labels
const STEP = 26; // px per bar (bar + gap)
const BAR_W = 18;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;

function bandColor(score: number, good: number): string {
  if (score >= good) return 'var(--good)';
  if (score >= 60) return 'var(--warn)';
  return 'var(--fault)';
}

/** Rounded-top bar path anchored to the baseline. */
function barPath(x: number, baseline: number, w: number, h: number): string {
  const top = baseline - h;
  const rr = Math.min(4, w / 2, Math.max(0, h));
  return `M${x},${baseline} L${x},${top + rr} Q${x},${top} ${x + rr},${top} L${x + w - rr},${top} Q${x + w},${top} ${x + w},${top + rr} L${x + w},${baseline} Z`;
}

export default function BarChart({ values, goodThreshold = 80, lang }: Props) {
  const n = values.length;
  if (n === 0) return null;

  const width = Math.max(n * STEP + 8, 260);
  const baseline = PAD_TOP + PLOT_H;
  const y = (v: number) => baseline - (Math.max(0, Math.min(100, v)) / 100) * PLOT_H;
  const thresholdY = y(goodThreshold);
  // Thin the x labels when crowded so they never collide.
  const labelEvery = n <= 12 ? 1 : Math.ceil(n / 12);

  return (
    <svg
      className="barchart"
      viewBox={`0 0 ${width} ${H}`}
      width={width}
      height={H}
      role="img"
      aria-label={
        (lang === 'th' ? 'คะแนนรายลูก' : 'Per-shot scores') +
        `: ${values.map((v) => Math.round(v)).join(', ')}`
      }
    >
      {/* baseline */}
      <line x1={0} y1={baseline} x2={width} y2={baseline} stroke="var(--line-strong)" strokeWidth={1} />

      {/* good-form threshold guide */}
      <line
        x1={0}
        y1={thresholdY}
        x2={width}
        y2={thresholdY}
        stroke="var(--good)"
        strokeWidth={1}
        strokeDasharray="4 4"
        opacity={0.6}
      />
      <text x={2} y={thresholdY - 3} fontSize={8} fill="var(--good)" opacity={0.85}>
        {goodThreshold}
      </text>

      {values.map((v, i) => {
        const x = i * STEP + 6;
        const h = baseline - y(v);
        const showLabel = i % labelEvery === 0 || i === n - 1;
        return (
          <g key={i}>
            <path d={barPath(x, baseline, BAR_W, h)} fill={bandColor(v, goodThreshold)} />
            {showLabel && (
              <text
                x={x + BAR_W / 2}
                y={baseline + 13}
                textAnchor="middle"
                fontSize={8}
                fill="var(--text-faint)"
              >
                {i + 1}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

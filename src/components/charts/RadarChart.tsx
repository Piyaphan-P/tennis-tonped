// ============================================================================
// ADGE Tennis — hand-rolled SVG radar (joint angles vs target).
// No chart lib. Colors come from theme.css tokens so it matches the app in
// light/dark. value/target are pre-normalized 0..1 by history/derive.radarData.
// ============================================================================

import type { Lang } from '../../types';
import type { RadarDatum } from '../../history/derive';

interface Props {
  data: RadarDatum[];
  lang: Lang;
  /** SVG pixel size (square). Default 200. */
  size?: number;
}

const VIEW = 200;
const CX = VIEW / 2;
const CY = VIEW / 2;
const R = 66; // radius of the 100% ring
const RINGS = [0.25, 0.5, 0.75, 1];

/** Vertex on the radar for axis `i` of `n` at radial fraction `f` (0..1). */
function point(i: number, n: number, f: number): [number, number] {
  const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n; // start at top, clockwise
  return [CX + Math.cos(angle) * R * f, CY + Math.sin(angle) * R * f];
}

function polygon(n: number, values: number[]): string {
  return values.map((v, i) => point(i, n, v).join(',')).join(' ');
}

export default function RadarChart({ data, lang, size = 200 }: Props) {
  const n = data.length;
  if (n === 0) return null;

  const ariaParts = data.map(
    (d) => `${lang === 'th' ? d.labelTH : d.labelEN} ${Math.round(d.value * 100)}%`,
  );

  return (
    <svg
      className="radar-chart"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      width={size}
      height={size}
      role="img"
      aria-label={`${lang === 'th' ? 'มุมข้อต่อเทียบเป้าหมาย' : 'Joints vs target'}: ${ariaParts.join(', ')}`}
    >
      {/* grid rings */}
      {RINGS.map((f) => (
        <polygon
          key={f}
          points={polygon(n, Array(n).fill(f))}
          fill="none"
          stroke="var(--line)"
          strokeWidth={0.75}
        />
      ))}

      {/* axis spokes + labels */}
      {data.map((d, i) => {
        const [ex, ey] = point(i, n, 1);
        const [lx, ly] = point(i, n, 1.28);
        const anchor = lx > CX + 1 ? 'start' : lx < CX - 1 ? 'end' : 'middle';
        return (
          <g key={d.key}>
            <line x1={CX} y1={CY} x2={ex} y2={ey} stroke="var(--line)" strokeWidth={0.5} />
            <text
              x={lx}
              y={ly}
              textAnchor={anchor}
              dominantBaseline="middle"
              fontSize={9}
              fill="var(--text-dim)"
            >
              {lang === 'th' ? d.labelTH : d.labelEN}
            </text>
          </g>
        );
      })}

      {/* target polygon (all-1.0 ring) — dashed green */}
      <polygon
        points={polygon(n, data.map((d) => d.target))}
        fill="none"
        stroke="var(--good)"
        strokeWidth={1.25}
        strokeDasharray="3 3"
        opacity={0.7}
      />

      {/* value polygon — optic-yellow accent, translucent fill */}
      <polygon
        points={polygon(n, data.map((d) => d.value))}
        fill="var(--accent)"
        fillOpacity={0.16}
        stroke="var(--accent)"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* vertex dots */}
      {data.map((d, i) => {
        const [x, y] = point(i, n, d.value);
        return <circle key={d.key} cx={x} cy={y} r={2.6} fill="var(--accent)" />;
      })}
    </svg>
  );
}

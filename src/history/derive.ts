// ============================================================================
// ต้นและเพชร Tennis Club — History screen pure derivations (unit-testable).
//
// No React, no store, no I/O. Turns cloud shot metadata into the shapes the
// radar/bar charts and the end-of-session summary render. Target ranges mirror
// src/analysis/scoring.ts and store.evaluateAngleStatuses EXACTLY so the radar
// agrees with the score the player already saw.
// ============================================================================

import type {
  CloudShot,
  DominantHand,
  JointAngles,
  Lang,
  SessionImprovement,
  ShotIssue,
} from '../types';

// ---------------------------------------------------------------------------
// Target ranges (mirror scoring.ts rules / evaluateAngleStatuses)
// ---------------------------------------------------------------------------

/** Good-form angle windows in degrees, matching the scorer's rules. */
const ELBOW = { lo: 120, hi: 160, falloff: 60 } as const;
const SHOULDER = { lo: 60, hi: 110, falloff: 60 } as const;
const KNEE = { lo: 125, hi: 160, falloff: 60 } as const;
/** Trunk lean is one-sided: 0° (upright) is ideal, ≤15° still good. */
const TRUNK = { lo: 0, hi: 15, falloff: 30 } as const;
/** Peak wrist-speed reference = the scorer's "good" threshold (≥2.5 units/s). */
const SPEED_TARGET = 2.5;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Closeness of a measured degree to a good range, mapped to 0..1:
 *   inside [lo,hi] → 1; outside → 1 − (distance past nearest edge)/falloff,
 *   clamped, so a value `falloff` degrees outside the window reads ~0.
 */
function rangeCloseness(
  deg: number,
  { lo, hi, falloff }: { lo: number; hi: number; falloff: number },
): number {
  if (!Number.isFinite(deg)) return 0;
  if (deg >= lo && deg <= hi) return 1;
  const dist = deg < lo ? lo - deg : deg - hi;
  return clamp01(1 - dist / falloff);
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

export interface RadarDatum {
  key: 'elbow' | 'shoulder' | 'kneeL' | 'kneeR' | 'trunk' | 'speed';
  labelTH: string;
  labelEN: string;
  /** Measured metric normalized to 0..1 (1 = on target). */
  value: number;
  /** Target ring, always 1.0. */
  target: number;
}

/**
 * Six-axis radar comparing the dominant-hand joint angles + swing speed at
 * contact against their good-form targets (all normalized 0..1, target = 1).
 */
export function radarData(
  angles: JointAngles,
  peakWristSpeed: number,
  hand: DominantHand,
): RadarDatum[] {
  const elbowDeg = hand === 'right' ? angles.rightElbowDeg : angles.leftElbowDeg;
  const shoulderDeg = hand === 'right' ? angles.rightShoulderDeg : angles.leftShoulderDeg;
  return [
    { key: 'elbow', labelTH: 'ศอก', labelEN: 'Elbow', value: rangeCloseness(elbowDeg, ELBOW), target: 1 },
    {
      key: 'shoulder',
      labelTH: 'ไหล่',
      labelEN: 'Shoulder',
      value: rangeCloseness(shoulderDeg, SHOULDER),
      target: 1,
    },
    { key: 'kneeL', labelTH: 'เข่าซ้าย', labelEN: 'L knee', value: rangeCloseness(angles.leftKneeDeg, KNEE), target: 1 },
    { key: 'kneeR', labelTH: 'เข่าขวา', labelEN: 'R knee', value: rangeCloseness(angles.rightKneeDeg, KNEE), target: 1 },
    { key: 'trunk', labelTH: 'ลำตัว', labelEN: 'Trunk', value: rangeCloseness(angles.trunkLeanDeg, TRUNK), target: 1 },
    {
      key: 'speed',
      labelTH: 'ความเร็ว',
      labelEN: 'Speed',
      value: clamp01((peakWristSpeed || 0) / SPEED_TARGET),
      target: 1,
    },
  ];
}

// ---------------------------------------------------------------------------
// Improvement lines (per clip card)
// ---------------------------------------------------------------------------

/** Rank: faults first, then warnings. */
function severityRank(sev: ShotIssue['severity']): number {
  return sev === 'fault' ? 0 : sev === 'warn' ? 1 : 2;
}

/**
 * Non-'good' issues formatted as "message (target)", worst severity first,
 * capped at 3. Returns [] for a clean shot.
 */
export function shotImprovementLines(issues: ShotIssue[], lang: Lang): string[] {
  return issues
    .filter((i) => i.severity !== 'good')
    .slice()
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 3)
    .map((i) => {
      const msg = (lang === 'th' ? i.messageTH : i.messageEN) || i.key;
      return i.target ? `${msg} (${i.target})` : msg;
    });
}

// ---------------------------------------------------------------------------
// End-of-session overall summary
// ---------------------------------------------------------------------------

export type SessionTrend = 'improving' | 'declining' | 'flat';

export interface OverallSummary {
  topFaults: SessionImprovement[];
  trend: SessionTrend;
  firstHalfAvg: number;
  secondHalfAvg: number;
}

/**
 * Aggregate cloud-shot issues into the top-3 recurring faults (frequency then
 * severity — same policy as store.deriveImprovements, reimplemented over
 * CloudShot[] to avoid coupling to the Shot shape) and compute a first-half vs
 * second-half score trend (±3-point deadband = 'flat').
 */
export function overallSummary(shots: CloudShot[]): OverallSummary {
  const byKey = new Map<string, SessionImprovement>();
  for (const shot of shots) {
    for (const issue of shot.issues) {
      if (issue.severity === 'good') continue;
      const cur = byKey.get(issue.key);
      if (cur) {
        cur.count += 1;
        if (issue.severity === 'fault') cur.severity = 'fault';
      } else {
        byKey.set(issue.key, {
          key: issue.key,
          count: 1,
          severity: issue.severity,
          messageTH: issue.messageTH,
          messageEN: issue.messageEN,
          target: issue.target,
        });
      }
    }
  }
  const topFaults = [...byKey.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        (b.severity === 'fault' ? 1 : 0) - (a.severity === 'fault' ? 1 : 0),
    )
    .slice(0, 3);

  const avg = (arr: CloudShot[]): number =>
    arr.length === 0 ? 0 : Math.round(arr.reduce((s, x) => s + x.score, 0) / arr.length);

  const n = shots.length;
  if (n < 2) {
    const a = avg(shots);
    return { topFaults, trend: 'flat', firstHalfAvg: a, secondHalfAvg: a };
  }
  const mid = Math.floor(n / 2);
  const firstHalfAvg = avg(shots.slice(0, mid));
  const secondHalfAvg = avg(shots.slice(mid));
  const diff = secondHalfAvg - firstHalfAvg;
  const trend: SessionTrend = diff > 3 ? 'improving' : diff < -3 ? 'declining' : 'flat';
  return { topFaults, trend, firstHalfAvg, secondHalfAvg };
}

// ---------------------------------------------------------------------------
// Date formatting (TH primary → Buddhist-era calendar via th-TH locale)
// ---------------------------------------------------------------------------

/** Localized medium date + short time. TH uses the Buddhist-era calendar. */
export function formatSessionDate(iso: string, lang: Lang): string {
  try {
    return new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

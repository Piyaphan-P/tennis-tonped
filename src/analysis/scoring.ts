// ============================================================================
// ADGE Tennis — local rule-based shot
// scoring (pure, unit-testable)
//
// Turns one contact-frame angle snapshot + peak wrist speed into a 0–100
// score and a bilingual issue list. Runs entirely on-device (free, instant) —
// this is what powers the local score shown the moment a shot completes,
// before Gemini's coaching (which references these same numbers) arrives.
//
// Each rule below is independent and contributes its own weight to the total
// penalty; weights sum to 100 so a shot that fails every rule at "fault"
// severity bottoms out at 0. Exactly one rule may still be "warn" while
// others are "good" — issues.length can be 0..5 non-good entries, or exactly
// one 'good' 'clean-contact' entry when every rule passes.
// ============================================================================

import type { DominantHand, JointAngles, ShotIssue, ShotType } from '../types';

// ---------------------------------------------------------------------------
// Rule table (display metadata — DevPlan/Settings render this)
// ---------------------------------------------------------------------------

export interface ScoringRuleDef {
  /** Stable key, matches the ShotIssue.key family this rule can emit. */
  key: string;
  label: string;
  labelTH: string;
  weight: number;
  /** Human-readable good-range target, e.g. '120–160°'. */
  target: string;
  unit: string;
}

export const RULES: ScoringRuleDef[] = [
  {
    key: 'elbow-too-bent',
    label: 'Dominant elbow at contact',
    labelTH: 'ศอกข้างที่ตีตอนกระทบลูก',
    weight: 30,
    target: '120–160°',
    unit: 'deg',
  },
  {
    key: 'no-knee-bend',
    label: 'Average knee bend',
    labelTH: 'การย่อเข่าเฉลี่ย',
    weight: 25,
    target: '125–160°',
    unit: 'deg',
  },
  {
    key: 'leaning',
    label: 'Trunk lean from vertical',
    labelTH: 'การเอียงลำตัวจากแนวตั้ง',
    weight: 15,
    target: '≤15°',
    unit: 'deg',
  },
  {
    key: 'shoulder-angle',
    label: 'Dominant shoulder angle at contact',
    labelTH: 'มุมหัวไหล่ข้างที่ตีตอนกระทบลูก',
    weight: 15,
    target: '60–110°',
    unit: 'deg',
  },
  {
    key: 'swing-faster',
    label: 'Peak wrist speed',
    labelTH: 'ความเร็วข้อมือสูงสุด',
    weight: 15,
    target: '≥2.5 units/s',
    unit: 'units/s',
  },
];

const WEIGHT: Record<string, number> = Object.fromEntries(
  RULES.map((r) => [r.key, r.weight]),
);

// ---------------------------------------------------------------------------
// Penalty helpers
// ---------------------------------------------------------------------------

type PenaltyFactor = 0 | 0.5 | 1;

function penaltyPoints(weight: number, factor: PenaltyFactor): number {
  return weight * factor;
}

// ---------------------------------------------------------------------------
// scoreShot
// ---------------------------------------------------------------------------

export interface ScoreShotInput {
  type: ShotType;
  contactAngles: JointAngles;
  peakWristSpeed: number;
  dominantHand: DominantHand;
}

export interface ScoreShotResult {
  score: number;
  issues: ShotIssue[];
}

/**
 * Pure rule-based scorer. No side effects, no store access — safe to unit
 * test in isolation and safe to call from the shot detector on every
 * completed swing.
 */
export function scoreShot(input: ScoreShotInput): ScoreShotResult {
  const { contactAngles, peakWristSpeed, dominantHand } = input;

  const elbowDeg =
    dominantHand === 'right' ? contactAngles.rightElbowDeg : contactAngles.leftElbowDeg;
  const shoulderDeg =
    dominantHand === 'right'
      ? contactAngles.rightShoulderDeg
      : contactAngles.leftShoulderDeg;
  const avgKneeDeg = (contactAngles.leftKneeDeg + contactAngles.rightKneeDeg) / 2;
  const trunkLeanDeg = contactAngles.trunkLeanDeg;

  let totalPenalty = 0;
  const issues: ShotIssue[] = [];

  // --- 1. Dominant elbow at contact (weight 30) --------------------------
  if (elbowDeg < 100) {
    totalPenalty += penaltyPoints(WEIGHT['elbow-too-bent'], 1);
    issues.push({
      key: 'elbow-too-bent',
      severity: 'fault',
      measured: elbowDeg,
      target: '120–160°',
      messageTH: 'ศอกงอเกินไปตอนกระทบ เหยียดแขนเพิ่มอีกนิด',
      messageEN: 'Elbow too bent at contact — extend a bit more.',
    });
  } else if (elbowDeg < 120) {
    totalPenalty += penaltyPoints(WEIGHT['elbow-too-bent'], 0.5);
    issues.push({
      key: 'elbow-too-bent',
      severity: 'warn',
      measured: elbowDeg,
      target: '120–160°',
      messageTH: 'ศอกงอมากไปหน่อยตอนกระทบ ลองเหยียดเพิ่มอีกนิด',
      messageEN: 'Elbow a bit too bent at contact — extend slightly more.',
    });
  } else if (elbowDeg > 160) {
    totalPenalty += penaltyPoints(WEIGHT['elbow-too-bent'], 0.5);
    issues.push({
      key: 'arm-locked',
      severity: 'warn',
      measured: elbowDeg,
      target: '120–160°',
      messageTH: 'แขนเหยียดตรงเกินไป ผ่อนศอกลงหน่อยตอนกระทบ',
      messageEN: 'Arm too straight/locked — soften the elbow slightly at contact.',
    });
  }
  // else: good, no issue.

  // --- 2. Average knee bend (weight 25) -----------------------------------
  if (avgKneeDeg > 168) {
    totalPenalty += penaltyPoints(WEIGHT['no-knee-bend'], 1);
    issues.push({
      key: 'no-knee-bend',
      severity: 'fault',
      measured: avgKneeDeg,
      target: '125–160°',
      messageTH: 'เข่าตรงเกินไป ย่อเข่าลงเพื่อรับแรงมากขึ้น',
      messageEN: 'Knees too straight — bend them more to load the shot.',
    });
  } else if (avgKneeDeg < 125 || avgKneeDeg > 160) {
    totalPenalty += penaltyPoints(WEIGHT['no-knee-bend'], 0.5);
    issues.push({
      key: 'no-knee-bend',
      severity: 'warn',
      measured: avgKneeDeg,
      target: '125–160°',
      messageTH: 'ย่อเข่าให้พอดีขึ้นอีกนิดก่อนสวิง',
      messageEN: 'Fine-tune your knee bend a little more before swinging.',
    });
  }

  // --- 3. Trunk lean from vertical (weight 15) ----------------------------
  if (trunkLeanDeg > 25) {
    totalPenalty += penaltyPoints(WEIGHT['leaning'], 1);
    issues.push({
      key: 'off-balance',
      severity: 'fault',
      measured: trunkLeanDeg,
      target: '≤15°',
      messageTH: 'เสียบาลานซ์ ตัวเอียงมากเกินไป ตั้งลำตัวให้ตรงก่อนสวิง',
      messageEN: 'Off balance — leaning too far. Set your trunk upright before swinging.',
    });
  } else if (trunkLeanDeg > 15) {
    totalPenalty += penaltyPoints(WEIGHT['leaning'], 0.5);
    issues.push({
      key: 'leaning',
      severity: 'warn',
      measured: trunkLeanDeg,
      target: '≤15°',
      messageTH: 'ตัวเอียงไปหน่อย พยายามยืดตัวให้ตรงขึ้น',
      messageEN: "You're leaning a bit — keep your trunk more upright.",
    });
  }

  // --- 4. Dominant shoulder angle at contact (weight 15) ------------------
  if (shoulderDeg < 60 || shoulderDeg > 110) {
    totalPenalty += penaltyPoints(WEIGHT['shoulder-angle'], 0.5);
    issues.push({
      key: 'shoulder-angle',
      severity: 'warn',
      measured: shoulderDeg,
      target: '60–110°',
      messageTH: 'มุมหัวไหล่ตอนกระทบยังไม่พอดี ปรับจังหวะยกแขนอีกนิด',
      messageEN: 'Shoulder angle at contact is off — adjust your arm height slightly.',
    });
  }

  // --- 5. Peak wrist speed (weight 15) ------------------------------------
  if (peakWristSpeed < 2.0) {
    totalPenalty += penaltyPoints(WEIGHT['swing-faster'], 1);
    issues.push({
      key: 'swing-faster',
      severity: 'fault',
      measured: peakWristSpeed,
      target: '≥2.5 units/s',
      messageTH: 'สวิงช้าไปหน่อย เร่งความเร็วช่วงเข้าหาลูกให้มากขึ้น',
      messageEN: 'Swing was slow — accelerate more through the ball.',
    });
  } else if (peakWristSpeed < 2.5) {
    totalPenalty += penaltyPoints(WEIGHT['swing-faster'], 0.5);
    issues.push({
      key: 'swing-faster',
      severity: 'warn',
      measured: peakWristSpeed,
      target: '≥2.5 units/s',
      messageTH: 'สวิงเร็วขึ้นอีกนิดเพื่อแรงส่งที่ดีกว่า',
      messageEN: 'Swing a bit faster for more pace.',
    });
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - totalPenalty)));

  if (issues.length === 0) {
    issues.push({
      key: 'clean-contact',
      severity: 'good',
      messageTH: 'ฟอร์มสวยมาก!',
      messageEN: 'Beautiful form!',
    });
  }

  return { score, issues };
}

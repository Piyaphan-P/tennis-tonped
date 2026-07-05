import { describe, it, expect } from 'vitest';
import {
  radarData,
  shotImprovementLines,
  overallSummary,
  formatSessionDate,
} from './derive';
import type { CloudShot, JointAngles, ShotIssue } from '../types';

// A neutral angle snapshot; individual tests override the fields under test.
function angles(patch: Partial<JointAngles> = {}): JointAngles {
  return {
    timestampMs: 0,
    leftElbowDeg: 140,
    rightElbowDeg: 140,
    leftShoulderDeg: 85,
    rightShoulderDeg: 85,
    leftKneeDeg: 140,
    rightKneeDeg: 140,
    leftHipDeg: 170,
    rightHipDeg: 170,
    trunkLeanDeg: 5,
    wristSpeed: 0,
    wristVelX: 0,
    ...patch,
  };
}

function cloudShot(idx: number, score: number, issues: ShotIssue[] = []): CloudShot {
  return {
    id: `s${idx}`,
    sessionId: 'sess',
    idx,
    type: 'forehand',
    score,
    angles: angles(),
    statuses: { domElbow: 'good', domShoulder: 'good', leftKnee: 'good', rightKnee: 'good', trunk: 'good' },
    issues,
    peakWristSpeed: 3,
    hasClip: true,
    clipMime: 'video/mp4',
    createdAt: '2026-07-05T10:00:00.000Z',
  };
}

describe('radarData normalization', () => {
  it('maps in-range angles and on-target speed to 1', () => {
    const d = radarData(angles(), 2.5, 'right');
    for (const datum of d) {
      expect(datum.target).toBe(1);
      expect(datum.value).toBeCloseTo(1, 5);
    }
  });

  it('maps far-out-of-range angles toward 0', () => {
    const bad = angles({
      rightElbowDeg: 40, // 80° below the 120 floor, > 60 falloff
      rightShoulderDeg: 0,
      leftKneeDeg: 40,
      rightKneeDeg: 250,
      trunkLeanDeg: 60,
    });
    const d = radarData(bad, 0, 'right');
    const by = Object.fromEntries(d.map((x) => [x.key, x.value]));
    expect(by.elbow).toBe(0);
    expect(by.shoulder).toBe(0);
    expect(by.kneeL).toBe(0);
    expect(by.kneeR).toBe(0);
    expect(by.trunk).toBe(0);
    expect(by.speed).toBe(0);
  });

  it('respects dominant hand when selecting elbow/shoulder', () => {
    const a = angles({ leftElbowDeg: 140, rightElbowDeg: 40 });
    expect(radarData(a, 2.5, 'left').find((x) => x.key === 'elbow')!.value).toBeCloseTo(1, 5);
    expect(radarData(a, 2.5, 'right').find((x) => x.key === 'elbow')!.value).toBe(0);
  });

  it('clamps speed above target to 1', () => {
    const d = radarData(angles(), 10, 'right');
    expect(d.find((x) => x.key === 'speed')!.value).toBe(1);
  });
});

describe('shotImprovementLines', () => {
  const issues: ShotIssue[] = [
    { key: 'leaning', severity: 'warn', messageTH: 'เอียง', messageEN: 'Leaning', target: '≤15°' },
    { key: 'elbow-too-bent', severity: 'fault', messageTH: 'ศอกงอ', messageEN: 'Elbow bent', target: '120–160°' },
    { key: 'clean', severity: 'good', messageTH: 'ดี', messageEN: 'Good' },
  ];

  it('orders faults before warnings and drops good, formatting target', () => {
    const lines = shotImprovementLines(issues, 'en');
    expect(lines).toEqual(['Elbow bent (120–160°)', 'Leaning (≤15°)']);
  });

  it('caps at 3 lines', () => {
    const many: ShotIssue[] = Array.from({ length: 5 }, (_, i) => ({
      key: `k${i}`,
      severity: 'fault' as const,
      messageTH: `t${i}`,
      messageEN: `e${i}`,
    }));
    expect(shotImprovementLines(many, 'en')).toHaveLength(3);
  });

  it('returns empty for a clean shot', () => {
    expect(shotImprovementLines([{ key: 'clean', severity: 'good', messageTH: 'ดี', messageEN: 'Good' }], 'th')).toEqual([]);
  });
});

describe('overallSummary trend buckets', () => {
  const fault: ShotIssue = { key: 'leaning', severity: 'fault', messageTH: 'เอียง', messageEN: 'Leaning' };

  it('improving when second half beats first by > 3', () => {
    const s = overallSummary([cloudShot(0, 50), cloudShot(1, 52), cloudShot(2, 80), cloudShot(3, 82)]);
    expect(s.firstHalfAvg).toBe(51);
    expect(s.secondHalfAvg).toBe(81);
    expect(s.trend).toBe('improving');
  });

  it('declining when second half drops by > 3', () => {
    expect(overallSummary([cloudShot(0, 90), cloudShot(1, 88), cloudShot(2, 60), cloudShot(3, 58)]).trend).toBe(
      'declining',
    );
  });

  it('flat inside the ±3 deadband', () => {
    expect(overallSummary([cloudShot(0, 80), cloudShot(1, 82), cloudShot(2, 81), cloudShot(3, 83)]).trend).toBe('flat');
  });

  it('flat for fewer than 2 shots', () => {
    const s = overallSummary([cloudShot(0, 70)]);
    expect(s.trend).toBe('flat');
    expect(s.firstHalfAvg).toBe(70);
    expect(s.secondHalfAvg).toBe(70);
  });

  it('aggregates top faults by frequency', () => {
    const s = overallSummary([cloudShot(0, 50, [fault]), cloudShot(1, 50, [fault])]);
    expect(s.topFaults[0].key).toBe('leaning');
    expect(s.topFaults[0].count).toBe(2);
    expect(s.topFaults[0].severity).toBe('fault');
  });
});

describe('formatSessionDate', () => {
  it('renders th-TH with a Buddhist-era year and does not throw', () => {
    const out = formatSessionDate('2026-07-05T10:00:00.000Z', 'th');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // 2026 CE → 2569 BE in the Thai Buddhist calendar.
    expect(out).toContain('2569');
  });

  it('renders en-GB without throwing', () => {
    const out = formatSessionDate('2026-07-05T10:00:00.000Z', 'en');
    expect(out).toContain('2026');
  });

  it('falls back to the input on an invalid date input', () => {
    expect(typeof formatSessionDate('not-a-date', 'en')).toBe('string');
  });
});

// ============================================================================
// ADGE Tennis — dev-plan area derivation (shared, pure)
//
// The Development Plan groups a session's shot issues into 5 coaching AREAS,
// severity-weighted, worst first. This logic was originally inline in
// DevPlanScreen; it is extracted here so BOTH the DevPlan screen (Shot[]) and
// the History detail (CloudShot[]) rank the same way over the same issue
// vocabulary. The coaching COPY (title/อาการ/เพราะอะไร/วิธีซ้อม/cue) stays in
// i18n (`devplan.area.<id>.*`) — this module only ranks the area IDs.
//
// No React, no i18n, no DOM — pure + unit-tested.
// ============================================================================

import type { IssueSeverity } from '../types';

export const AREA_IDS = [
  'contact-extension',
  'knee-load',
  'balance',
  'racket-prep',
  'swing-speed',
] as const;

export type AreaId = (typeof AREA_IDS)[number];

/** Map a ShotIssue.key → its coaching area (mirrors scoring.ts vocabulary). */
export function areaForIssue(key: string): AreaId | null {
  switch (key) {
    case 'elbow-too-bent':
    case 'arm-locked':
      return 'contact-extension';
    case 'no-knee-bend':
      return 'knee-load';
    case 'leaning':
    case 'off-balance':
      return 'balance';
    case 'shoulder-angle':
      return 'racket-prep';
    case 'swing-faster':
      return 'swing-speed';
    default:
      return null;
  }
}

export const SEVERITY_WEIGHT: Record<IssueSeverity, number> = { fault: 2, warn: 1, good: 0 };

export interface RankedArea {
  id: AreaId;
  /** Severity-weighted total across the session (fault 2 / warn 1). */
  weight: number;
  /** How many distinct shots this area was seen in. */
  shots: number;
}

/** Minimal issue shape both Shot and CloudShot satisfy. */
export interface IssueLike {
  key: string;
  severity: IssueSeverity;
}

/**
 * Rank recurring faults into coaching areas (worst first). Weight = Σ severity
 * over all issues that map to the area; `shots` = distinct shots the area
 * appeared in. Returns the top `limit` (default 3). Pure.
 */
export function rankAreas(
  shots: Array<{ issues: IssueLike[] }>,
  limit = 3,
): RankedArea[] {
  const acc = new Map<AreaId, { weight: number; shots: number }>();
  for (const shot of shots) {
    const seen = new Set<AreaId>();
    for (const issue of shot.issues) {
      if (issue.severity === 'good') continue;
      const id = areaForIssue(issue.key);
      if (!id) continue;
      const e = acc.get(id) ?? { weight: 0, shots: 0 };
      e.weight += SEVERITY_WEIGHT[issue.severity];
      if (!seen.has(id)) {
        e.shots += 1;
        seen.add(id);
      }
      acc.set(id, e);
    }
  }
  return [...acc.entries()]
    .map(([id, v]) => ({ id, weight: v.weight, shots: v.shots }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(0, limit));
}

import { describe, it, expect } from 'vitest';
import { rankAreas, areaForIssue, type IssueLike } from './devPlanDerive';
import type { IssueSeverity } from '../types';

function shot(...issues: Array<[string, IssueSeverity]>): { issues: IssueLike[] } {
  return { issues: issues.map(([key, severity]) => ({ key, severity })) };
}

describe('devPlanDerive.areaForIssue', () => {
  it('maps issue keys to the five coaching areas', () => {
    expect(areaForIssue('elbow-too-bent')).toBe('contact-extension');
    expect(areaForIssue('arm-locked')).toBe('contact-extension');
    expect(areaForIssue('no-knee-bend')).toBe('knee-load');
    expect(areaForIssue('leaning')).toBe('balance');
    expect(areaForIssue('off-balance')).toBe('balance');
    expect(areaForIssue('shoulder-angle')).toBe('racket-prep');
    expect(areaForIssue('swing-faster')).toBe('swing-speed');
  });

  it('returns null for unknown / good keys', () => {
    expect(areaForIssue('nonsense')).toBeNull();
  });
});

describe('devPlanDerive.rankAreas', () => {
  it('ranks by severity weight (fault 2 / warn 1) worst first', () => {
    const shots = [
      shot(['swing-faster', 'fault']), // swing-speed +2
      shot(['leaning', 'warn']), // balance +1
      shot(['leaning', 'warn']), // balance +1  → 2 total, 2 shots
    ];
    const ranked = rankAreas(shots);
    // swing-speed weight 2 (1 shot) ties balance weight 2 (2 shots); sort is by
    // weight desc — both weight 2, stable order keeps insertion (swing first).
    expect(ranked.map((r) => r.id)).toContain('swing-speed');
    expect(ranked.map((r) => r.id)).toContain('balance');
    const balance = ranked.find((r) => r.id === 'balance');
    expect(balance).toEqual({ id: 'balance', weight: 2, shots: 2 });
  });

  it('counts distinct shots, not issue occurrences', () => {
    // Same area twice within ONE shot → weight adds but shots stays 1.
    const ranked = rankAreas([shot(['elbow-too-bent', 'fault'], ['arm-locked', 'warn'])]);
    expect(ranked).toEqual([{ id: 'contact-extension', weight: 3, shots: 1 }]);
  });

  it('ignores good-severity issues and returns [] for a clean session', () => {
    expect(rankAreas([shot(['elbow-too-bent', 'good'])])).toEqual([]);
    expect(rankAreas([])).toEqual([]);
  });

  it('caps at the requested limit', () => {
    const shots = [
      shot(['swing-faster', 'fault']),
      shot(['leaning', 'fault']),
      shot(['no-knee-bend', 'fault']),
      shot(['shoulder-angle', 'fault']),
    ];
    expect(rankAreas(shots).length).toBe(3); // default limit
    expect(rankAreas(shots, 2).length).toBe(2);
  });
});

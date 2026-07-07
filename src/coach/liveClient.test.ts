// ============================================================================
// ต้นและเพชร Tennis Club — coach prompt builder tests (v0.6 whole-swing reading)
//
// Pure-function coverage for the per-swing coaching payload:
//   • orderedCaptures    — canonical phase ordering, stable within a phase
//   • buildShotPrompt    — multi-frame enumeration matches the sent frame order,
//                          missing-phase handling, no-capture fallback, name
//   • buildCoachSystemPrompt — {{PLAYER_NAME}} substitution / clean empty name
//
// These functions are the contract that keeps image order == text order, so the
// coach's "Frame N = <phase>" mapping never lies. Adds to the test baseline.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  buildCoachSystemPrompt,
  buildShotPrompt,
  COACH_SYSTEM_PROMPT,
  orderedCaptures,
} from './liveClient';
import type { AngleStatuses, JointAngles, Shot, ShotPhase, SwingCapture } from '../types';

// --- fixtures ---------------------------------------------------------------

function angles(overrides: Partial<JointAngles> = {}): JointAngles {
  return {
    timestampMs: 0,
    leftElbowDeg: 150,
    rightElbowDeg: 150,
    leftShoulderDeg: 40,
    rightShoulderDeg: 40,
    leftKneeDeg: 160,
    rightKneeDeg: 160,
    leftHipDeg: 170,
    rightHipDeg: 170,
    trunkLeanDeg: 10,
    wristSpeed: 0,
    wristVelX: 0,
    ...overrides,
  };
}

const goodStatuses: AngleStatuses = {
  domElbow: 'good',
  domShoulder: 'good',
  leftKnee: 'good',
  rightKnee: 'good',
  trunk: 'good',
};

function capture(phase: ShotPhase, atMs: number, over: Partial<SwingCapture> = {}): SwingCapture {
  return {
    id: `cap-${phase}-${atMs}`,
    shotId: 'shot-1',
    phase,
    jpegBase64: `jpeg-${phase}`,
    atMs,
    angles: angles(),
    landmarks: [],
    statuses: goodStatuses,
    ...over,
  };
}

function shot(over: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    index: 3,
    type: 'forehand',
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    contactAngles: angles({ rightElbowDeg: 120 }),
    peakWristSpeed: 1.42,
    score: 88,
    issues: [],
    captures: [],
    ...over,
  };
}

// --- orderedCaptures --------------------------------------------------------

describe('orderedCaptures', () => {
  it('sorts captures into canonical phase order regardless of input order', () => {
    const s = shot({
      captures: [
        capture('follow-through', 300),
        capture('backswing', 100),
        capture('contact', 200),
      ],
    });
    expect(orderedCaptures(s).map((c) => c.phase)).toEqual([
      'backswing',
      'contact',
      'follow-through',
    ]);
  });

  it('keeps capture-time order for two frames of the same phase', () => {
    const s = shot({
      captures: [capture('contact', 250), capture('contact', 150)],
    });
    expect(orderedCaptures(s).map((c) => c.atMs)).toEqual([150, 250]);
  });

  it('does not mutate the original captures array', () => {
    const caps = [capture('contact', 200), capture('backswing', 100)];
    const s = shot({ captures: caps });
    orderedCaptures(s);
    expect(caps.map((c) => c.phase)).toEqual(['contact', 'backswing']);
  });
});

// --- buildShotPrompt --------------------------------------------------------

describe('buildShotPrompt', () => {
  it('enumerates every captured frame in phase order with a phase label', () => {
    const s = shot({
      captures: [
        capture('follow-through', 300),
        capture('backswing', 100),
        capture('contact', 200),
      ],
    });
    const p = buildShotPrompt(s, 'th', 'right', 'both', 'Ton');

    expect(p).toContain('You are shown 3 still frames of this one swing, in order:');
    const f1 = p.indexOf('Frame 1 = backswing');
    const f2 = p.indexOf('Frame 2 = ball contact');
    const f3 = p.indexOf('Frame 3 = follow-through');
    expect(f1).toBeGreaterThan(-1);
    expect(f2).toBeGreaterThan(f1);
    expect(f3).toBeGreaterThan(f2);
    expect(p).toContain('Reply in Thai.');
  });

  it('labels only the phases that exist (missing backswing/follow-through)', () => {
    const s = shot({ captures: [capture('contact', 200)] });
    const p = buildShotPrompt(s, 'en', 'right', 'both', 'Ton');
    expect(p).toContain('You are shown 1 still frame of this one swing, in order:');
    expect(p).toContain('Frame 1 = ball contact');
    expect(p).not.toContain('Frame 2');
    expect(p).not.toContain('backswing');
    expect(p).toContain('Reply in English.');
  });

  it('honors an explicit captures argument (what dispatchShot actually sent)', () => {
    // Shot has 3 captures but caller passes only the 2 it streamed.
    const s = shot({
      captures: [capture('backswing', 100), capture('contact', 200), capture('follow-through', 300)],
    });
    const p = buildShotPrompt(s, 'th', 'right', 'both', 'Ton', [
      capture('backswing', 100),
      capture('contact', 200),
    ]);
    expect(p).toContain('You are shown 2 still frames');
    expect(p).toContain('Frame 2 = ball contact');
    expect(p).not.toContain('Frame 3');
  });

  it('falls back to a contact-angle-only line when no frames were captured', () => {
    const s = shot({ captures: [] });
    const p = buildShotPrompt(s, 'th', 'right', 'both', 'Ton', []);
    expect(p).toContain('No swing frames were captured');
    expect(p).not.toContain('Frame 1');
    // dominant elbow snapshot from contactAngles (rightElbowDeg 120) is present
    expect(p).toContain('dominant elbow 120');
  });

  it('surfaces off-target joints (warn/fault) per frame, hides good ones', () => {
    const badStatuses: AngleStatuses = { ...goodStatuses, domElbow: 'fault', trunk: 'warn' };
    const s = shot({
      captures: [capture('contact', 200, { statuses: badStatuses })],
    });
    const p = buildShotPrompt(s, 'en', 'right', 'both', '');
    expect(p).toContain('dominant elbow clearly off');
    expect(p).toContain('trunk slightly off');
    // good joints are never flagged as off-target
    expect(p).not.toContain('shoulder slightly off');
    expect(p).not.toContain('shoulder clearly off');
  });

  it('uses left-hand angles when dominant hand is left', () => {
    const s = shot({
      captures: [
        capture('contact', 200, {
          angles: angles({ leftElbowDeg: 95, rightElbowDeg: 178 }),
        }),
      ],
    });
    const p = buildShotPrompt(s, 'en', 'left', 'both', '');
    expect(p).toContain('dominant elbow 95');
    expect(p).not.toContain('dominant elbow 178');
  });

  it('includes the student name only when provided', () => {
    const s = shot({ captures: [capture('contact', 200)] });
    expect(buildShotPrompt(s, 'th', 'right', 'both', 'Petch')).toContain("Student's name: Petch.");
    expect(buildShotPrompt(s, 'th', 'right', 'both', '   ')).not.toContain("Student's name");
  });
});

// --- buildCoachSystemPrompt -------------------------------------------------

describe('buildCoachSystemPrompt', () => {
  it('substitutes every {{PLAYER_NAME}} placeholder', () => {
    const out = buildCoachSystemPrompt('Ton');
    expect(out).not.toContain('{{PLAYER_NAME}}');
    expect(out).toContain('Ton');
  });

  it('collapses placeholders cleanly when the name is empty', () => {
    const out = buildCoachSystemPrompt('   ');
    expect(out).not.toContain('{{PLAYER_NAME}}');
  });

  it('is a whole-swing, coach-style prompt (praise → one fix → cue), no voice-input references', () => {
    // The system prompt template still carries placeholders (substituted at build).
    expect(COACH_SYSTEM_PROMPT).toContain('{{PLAYER_NAME}}');
    expect(COACH_SYSTEM_PROMPT).toContain('WHOLE SWING');
    expect(COACH_SYSTEM_PROMPT).toContain('PRAISE');
    expect(COACH_SYSTEM_PROMPT).toContain('THE ONE FIX');
    expect(COACH_SYSTEM_PROMPT).toContain('CUE');
    // v0.6 cut voice input — no lingering "asks you a question by voice" copy.
    expect(COACH_SYSTEM_PROMPT.toLowerCase()).not.toContain('by voice');
  });
});

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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCoachSystemPrompt,
  buildShotPrompt,
  COACH_SYSTEM_PROMPT,
  COACHING_STYLES,
  CoachLiveClient,
  orderedCaptures,
  selectCoachingStyle,
  shotOpener,
} from './liveClient';
import { audioPlayer } from './audioPlayer';
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

// --- selectCoachingStyle (v0.9 communication variety) -----------------------
//
// Pure style picker keyed on (score band × rotation). Four bands, two tonal
// variants each = ≥8 distinct voices. The load-bearing guarantee: two
// CONSECUTIVE shots never share a style — tested at a CONSTANT score (the only
// case a naive design could repeat), where the rotation must still alternate.

describe('selectCoachingStyle', () => {
  it('maps score to the right band', () => {
    expect(selectCoachingStyle(92, 0).band).toBe('hype');
    expect(selectCoachingStyle(85, 0).band).toBe('hype');
    expect(selectCoachingStyle(84, 0).band).toBe('praise-refine');
    expect(selectCoachingStyle(70, 0).band).toBe('praise-refine');
    expect(selectCoachingStyle(69, 0).band).toBe('technical');
    expect(selectCoachingStyle(55, 0).band).toBe('technical');
    expect(selectCoachingStyle(54, 0).band).toBe('encourage');
    expect(selectCoachingStyle(0, 0).band).toBe('encourage');
  });

  it('great shots (hype band) carry NO fix directive', () => {
    const s = selectCoachingStyle(90, 0);
    expect(s.band).toBe('hype');
    expect(s.directive).toMatch(/NO correction|do NOT give any correction/);
  });

  it('the palette exposes at least 8 distinct style voices', () => {
    const all = Object.values(COACHING_STYLES).flat();
    const ids = all.map((v) => v.id);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    // every band holds ≥2 tonal variants (so same-band rotation can alternate)
    for (const variants of Object.values(COACHING_STYLES)) {
      expect(variants.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('never repeats a style on consecutive shots — even at a constant score in one band', () => {
    for (const score of [95, 78, 62, 40]) {
      for (let i = 0; i < 12; i += 1) {
        expect(selectCoachingStyle(score, i).id).not.toBe(
          selectCoachingStyle(score, i + 1).id,
        );
      }
    }
  });

  it('never repeats a style on consecutive shots across a mixed-score rally', () => {
    const scores = [90, 88, 72, 60, 45, 50, 95, 30, 30, 82];
    let prev = '';
    scores.forEach((score, i) => {
      const id = selectCoachingStyle(score, i).id;
      expect(id).not.toBe(prev);
      prev = id;
    });
  });

  it('is deterministic and stays in range for large / odd indices', () => {
    expect(selectCoachingStyle(90, 7).id).toBe(selectCoachingStyle(90, 7).id);
    expect(selectCoachingStyle(90, 999).band).toBe('hype');
    expect(selectCoachingStyle(40, -3).band).toBe('encourage'); // negatives don't crash
  });
});

// --- buildShotPrompt — v0.9 coaching-style directive ------------------------

describe('buildShotPrompt — coaching-style directive injection', () => {
  it('injects the assigned style directive matching the shot score/index', () => {
    // score 90, index 0 → hype band, variant 0 (hype-a, FULL HYPE)
    const s = shot({ index: 0, score: 90, captures: [capture('contact', 200)] });
    const expected = selectCoachingStyle(90, 0).directive;
    const p = buildShotPrompt(s, 'th', 'right', 'both', 'Ton');
    expect(p).toContain('COACHING STYLE for this shot');
    expect(p).toContain(expected);
  });

  it('defers the reply shape to the style directive (no hard-coded praise/fix/cue tail)', () => {
    const s = shot({ index: 1, score: 60, captures: [capture('contact', 200)] });
    const p = buildShotPrompt(s, 'th', 'right', 'both', 'Ton');
    expect(p).toContain('then follow the coaching-style directive below');
    // the shot-name opener mandate still leads
    expect(p).toContain('OPEN your spoken reply by naming this shot first');
  });

  it('a low-score shot gets an encouragement-band directive', () => {
    const s = shot({ index: 2, score: 40, captures: [capture('contact', 200)] });
    const p = buildShotPrompt(s, 'en', 'right', 'both', 'Ton');
    expect(p).toContain(selectCoachingStyle(40, 2).directive);
    expect(selectCoachingStyle(40, 2).band).toBe('encourage');
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

  it('v0.7: reply shape now opens with the SHOT NAME before praise/fix/cue', () => {
    expect(COACH_SYSTEM_PROMPT).toContain('SHOT NAME');
    // ordering: shot name step appears before praise/fix/cue steps
    const iName = COACH_SYSTEM_PROMPT.indexOf('SHOT NAME');
    const iPraise = COACH_SYSTEM_PROMPT.indexOf('PRAISE');
    const iFix = COACH_SYSTEM_PROMPT.indexOf('THE ONE FIX');
    const iCue = COACH_SYSTEM_PROMPT.indexOf('CUE');
    expect(iName).toBeGreaterThan(-1);
    expect(iPraise).toBeGreaterThan(iName);
    expect(iFix).toBeGreaterThan(iPraise);
    expect(iCue).toBeGreaterThan(iFix);
  });

  it('v0.9: describes the style palette and DEMANDS variety, opener still mandatory', () => {
    // palette: the four coaching intents are named
    expect(COACH_SYSTEM_PROMPT).toContain('COACHING STYLE PER SHOT');
    expect(COACH_SYSTEM_PROMPT).toContain('FULL HYPE');
    expect(COACH_SYSTEM_PROMPT).toContain('WARM ENCOURAGEMENT');
    // variety mandate + rotating openers
    expect(COACH_SYSTEM_PROMPT).toContain('VARIETY');
    expect(COACH_SYSTEM_PROMPT).toContain('never reuse the previous reply');
    expect(COACH_SYSTEM_PROMPT).toContain('โอ้โห');
    // the shot-name opener is still step 1 in every style
    expect(COACH_SYSTEM_PROMPT).toContain('it is step 1 no matter which coaching style');
    // hype styles skip the fix
    expect(COACH_SYSTEM_PROMPT).toContain('SKIP the fix');
  });
});

// --- shotOpener (v0.7 spoken shot-name opener) ------------------------------

describe('shotOpener', () => {
  it('names shot number + stroke in the reply language (TH/EN)', () => {
    expect(shotOpener(5, 'forehand', 'th')).toBe('ช็อตที่ 5 โฟร์แฮนด์');
    expect(shotOpener(5, 'forehand', 'en')).toBe('Shot 5, forehand');
    expect(shotOpener(7, 'backhand', 'th')).toBe('ช็อตที่ 7 แบ็คแฮนด์');
    expect(shotOpener(7, 'backhand', 'en')).toBe('Shot 7, backhand');
  });

  it('collapses to just the shot number when the stroke type is unknown', () => {
    expect(shotOpener(9, 'unknown', 'th')).toBe('ช็อตที่ 9');
    expect(shotOpener(9, 'unknown', 'en')).toBe('Shot 9');
  });
});

describe('buildShotPrompt — v0.7 shot-name opener instruction', () => {
  it('instructs the coach to OPEN with the shot number + stroke (TH)', () => {
    const s = shot({ index: 5, type: 'forehand', captures: [capture('contact', 200)] });
    const p = buildShotPrompt(s, 'th', 'right', 'both', 'Ton');
    expect(p).toContain('OPEN your spoken reply by naming this shot first');
    expect(p).toContain('ช็อตที่ 5 โฟร์แฮนด์');
  });

  it('uses the English opener + backhand label when replying in English', () => {
    const s = shot({ index: 12, type: 'backhand', captures: [capture('contact', 200)] });
    const p = buildShotPrompt(s, 'en', 'right', 'both', 'Ton');
    expect(p).toContain('Shot 12, backhand');
  });

  it('collapses the opener to the number alone for an unknown stroke', () => {
    const s = shot({ index: 4, type: 'unknown', captures: [capture('contact', 200)] });
    const p = buildShotPrompt(s, 'th', 'right', 'both', 'Ton');
    expect(p).toContain('ช็อตที่ 4');
    expect(p).not.toContain('โฟร์แฮนด์');
    expect(p).not.toContain('แบ็คแฮนด์');
  });
});

// --- pacing gate + single-slot queue (v0.7) ---------------------------------
//
// A shot may only dispatch when connected, no turn is in flight, AND the coach
// has finished SPEAKING the previous critique. While blocked, the newest shot
// replaces any older queued one (freshest-wins); the queue flushes only after
// audioPlayer signals playback done, and resets on disconnect.

describe('CoachLiveClient pacing gate / queue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    audioPlayer.onPlaybackDone = null;
  });

  /** A connected client with dispatch stubbed so we observe queue decisions only. */
  function connectedClient() {
    const client = new CoachLiveClient();
    // Force "connected" without a real socket (private fields; runtime-only).
    (client as unknown as { connected: boolean }).connected = true;
    (client as unknown as { session: unknown }).session = {};
    const dispatch = vi.fn();
    (client as unknown as { dispatchShot: (s: Shot) => void }).dispatchShot = dispatch;
    return { client, dispatch };
  }

  it('dispatches immediately when connected, idle, and not speaking', () => {
    const { client, dispatch } = connectedClient();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(false);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].id).toBe('a');
  });

  it('queues (does not dispatch) while the coach is still speaking', () => {
    const { client, dispatch } = connectedClient();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    expect(dispatch).not.toHaveBeenCalled();
    expect((client as unknown as { queuedShot: Shot | null }).queuedShot?.id).toBe('a');
  });

  it('keeps only the latest queued shot while blocked (freshest-wins)', () => {
    const { client, dispatch } = connectedClient();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    client.sendShotForCoaching(shot({ id: 'b', index: 2 }));
    client.sendShotForCoaching(shot({ id: 'c', index: 3 }));
    expect(dispatch).not.toHaveBeenCalled();
    expect((client as unknown as { queuedShot: Shot | null }).queuedShot?.id).toBe('c');
    expect((client as unknown as { queuedReplaced: number }).queuedReplaced).toBe(2);
  });

  it('flushes the queued shot when playback finishes (onPlaybackDone)', () => {
    const { client, dispatch } = connectedClient();
    const speaking = vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    client.sendShotForCoaching(shot({ id: 'b', index: 2 }));
    expect(dispatch).not.toHaveBeenCalled();
    // Coach finished speaking → gate opens → the freshest queued shot dispatches.
    speaking.mockReturnValue(false);
    audioPlayer.onPlaybackDone?.();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].id).toBe('b');
    expect((client as unknown as { queuedShot: Shot | null }).queuedShot).toBeNull();
  });

  it('clears the queue on disconnect and never dispatches it afterward', () => {
    const { client, dispatch } = connectedClient();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    expect((client as unknown as { queuedShot: Shot | null }).queuedShot?.id).toBe('a');

    client.disconnect();
    expect((client as unknown as { queuedShot: Shot | null }).queuedShot).toBeNull();
    expect((client as unknown as { queuedReplaced: number }).queuedReplaced).toBe(0);

    // A late playback-done signal must not resurrect a dead/stale shot.
    audioPlayer.onPlaybackDone?.();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

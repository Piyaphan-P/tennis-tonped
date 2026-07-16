// ============================================================================
// ADGE Tennis — coach prompt builder tests (v0.6 whole-swing reading)
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCoachSystemPrompt,
  buildRelaySetupFrame,
  buildShotPrompt,
  COACH_SYSTEM_PROMPT,
  COACHING_STYLES,
  CoachLiveClient,
  orderedCaptures,
  selectCoachingStyle,
  serializeClientContent,
  serializeRealtimeInput,
  shotOpener,
  thaiNumberWords,
} from './liveClient';
import { audioPlayer } from './audioPlayer';
import { coachAudioTap } from './coachAudioTap';
import { appStore } from '../store';
import type { AngleStatuses, JointAngles, Shot, ShotPhase, SwingCapture } from '../types';

/** Toggle the store's coachVoiceOn setting for the audio-tap wiring tests below. */
function setCoachVoiceOn(on: boolean): void {
  appStore.setState((s) => ({ settings: { ...s.settings, coachVoiceOn: on } }));
}

vi.mock('./coachAudioTap', () => ({
  coachAudioTap: {
    onChunk: vi.fn(),
    finalizeForShot: vi.fn(),
    discard: vi.fn(),
  },
}));

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

// --- selectCoachingStyle (v0.9 communication variety, widened v3) -----------
//
// Pure style picker keyed on (score band × rotation). Four bands, 7–8 tonal
// variants each = ≥30 distinct voices (v3 widening — a 1-hour session's
// ~150–200 critiques concentrate 60–70% in one band, so even 3–4 variants/band
// repeated too often). The load-bearing guarantee: two CONSECUTIVE shots never
// share a style — tested at a CONSTANT score (the only case a naive design
// could repeat), where the rotation must still alternate.

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

  it('every hype variant carries NO fix directive (not just the first)', () => {
    for (const s of COACHING_STYLES.hype) {
      expect(s.directive).toMatch(/NO correction|do NOT give any correction/i);
    }
  });

  it('the palette exposes at least 30 distinct style voices (variety v3)', () => {
    const all = Object.values(COACHING_STYLES).flat();
    const ids = all.map((v) => v.id);
    expect(ids.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    // every band holds ≥7 tonal variants (so same-band rotation can alternate
    // AND the stateful recentIds window of 5 never starves a band)
    for (const variants of Object.values(COACHING_STYLES)) {
      expect(variants.length).toBeGreaterThanOrEqual(7);
    }
  });

  it('every style directive pins spoken length to the 2–4-sentence / ~4–9s band', () => {
    const all = Object.values(COACHING_STYLES).flat();
    for (const s of all) {
      expect(s.directive).toMatch(/2 to 4 short sentences/);
      expect(s.directive).toMatch(/4–9 seconds spoken|~4–9s spoken/);
    }
  });

  it('praise-refine band includes a PRAISE-ONLY variant (good shots sometimes get no fix)', () => {
    const variants = COACHING_STYLES['praise-refine'];
    const praiseOnly = variants.find((v) => /PRAISE-ONLY|do NOT give any correction/i.test(v.directive));
    expect(praiseOnly).toBeDefined();
    expect(praiseOnly?.directive).toMatch(/NOT give any correction/i);
  });

  it('every encourage variant carries explicit try-again ("ลองดูอีกที" / "ลองใหม่อีกที") framing', () => {
    for (const variant of COACHING_STYLES.encourage) {
      expect(variant.directive).toMatch(/ลองดูอีกที|ลองใหม่อีกที/);
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

  // --- recentIds (v1.0 stateful no-repeat window) ---------------------------

  it('recentIds=[] (default) reproduces the old pure index-rotation behavior', () => {
    for (const score of [95, 78, 62, 40]) {
      for (let i = 0; i < 8; i += 1) {
        expect(selectCoachingStyle(score, i)).toEqual(selectCoachingStyle(score, i, []));
      }
    }
  });

  it('skips any id present in recentIds, rotating forward from index', () => {
    const band = 'hype';
    const variants = COACHING_STYLES[band];
    const picked = selectCoachingStyle(90, 0, [variants[0].id]);
    expect(picked.id).not.toBe(variants[0].id);
    expect(picked.band).toBe('hype');
  });

  it('falls back to plain rotation when every variant in the band is recent', () => {
    const band = 'technical';
    const allIds = COACHING_STYLES[band].map((v) => v.id);
    const picked = selectCoachingStyle(60, 2, allIds);
    // Still returns a valid technical style rather than throwing/undefined.
    expect(picked).toBeDefined();
    expect(picked.band).toBe('technical');
  });

  it('threading a window of recent ids prevents a same-band repeat several shots later', () => {
    // Simulate: shot 0 (hype) spoken, several shots in other bands, then back to
    // hype at the SAME index parity (index === band length) that a naive
    // index%length rotation would have repeated — recentIds must steer it away.
    const first = selectCoachingStyle(90, 0, []);
    const recent = [first.id];
    const hypeLen = COACHING_STYLES.hype.length;
    const second = selectCoachingStyle(90, hypeLen, recent); // index ≡ 0 mod hypeLen
    expect(second.id).not.toBe(first.id);
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
    expect(COACH_SYSTEM_PROMPT).toContain('Never reuse the previous reply');
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

  /** The FIFO queue contents (ids), oldest first. */
  function queueIds(client: CoachLiveClient): string[] {
    return (client as unknown as { queue: Shot[] }).queue.map((s) => s.id);
  }

  it('queues (does not dispatch) while the coach is still speaking', () => {
    const { client, dispatch } = connectedClient();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(queueIds(client)).toEqual(['a']);
  });

  it('keeps EVERY queued shot in FIFO order while blocked (no drops — coach every shot)', () => {
    const { client, dispatch } = connectedClient();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    client.sendShotForCoaching(shot({ id: 'b', index: 2 }));
    client.sendShotForCoaching(shot({ id: 'c', index: 3 }));
    expect(dispatch).not.toHaveBeenCalled();
    // All three retained, oldest first — nothing dropped (v0.7 freshest-wins gone).
    expect(queueIds(client)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a duplicate send of a shot already waiting in the queue', () => {
    const { client } = connectedClient();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    client.sendShotForCoaching(shot({ id: 'a', index: 1 })); // same id again
    expect(queueIds(client)).toEqual(['a']);
  });

  it('flushes the queue in FIFO order, ONE shot per playback-done (coach every shot, in turn)', () => {
    const { client, dispatch } = connectedClient();
    const speaking = vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    client.sendShotForCoaching(shot({ id: 'b', index: 2 }));
    client.sendShotForCoaching(shot({ id: 'c', index: 3 }));
    expect(dispatch).not.toHaveBeenCalled();

    // Gate opens: the OLDEST queued shot dispatches first (FIFO, not freshest).
    speaking.mockReturnValue(false);
    audioPlayer.onPlaybackDone?.();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].id).toBe('a');
    expect(queueIds(client)).toEqual(['b', 'c']);

    // Each subsequent playback-done drains the next in order — nothing skipped.
    audioPlayer.onPlaybackDone?.();
    expect(dispatch.mock.calls[1][0].id).toBe('b');
    audioPlayer.onPlaybackDone?.();
    expect(dispatch.mock.calls[2][0].id).toBe('c');
    expect(queueIds(client)).toEqual([]);
  });

  it('dispatches at most one shot per gate-open (pacing gate intact)', () => {
    const { client, dispatch } = connectedClient();
    // isSpeaking stays false, but a turn is already in flight (pendingShotId set):
    // the gate must still hold every queued shot until the turn finalizes.
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(false);
    (client as unknown as { pendingShotId: string | null }).pendingShotId = 'in-flight';
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    client.sendShotForCoaching(shot({ id: 'b', index: 2 }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(queueIds(client)).toEqual(['a', 'b']);
  });

  it('bounds memory with a soft cap of 30, dropping the OLDEST when the coach falls far behind', () => {
    const { client } = connectedClient();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    for (let i = 1; i <= 32; i += 1) {
      client.sendShotForCoaching(shot({ id: `s${i}`, index: i }));
    }
    const ids = queueIds(client);
    expect(ids).toHaveLength(30);
    // The two OLDEST (s1, s2) were dropped; the freshest 30 survive, in order.
    expect(ids[0]).toBe('s3');
    expect(ids[29]).toBe('s32');
    expect(debug).toHaveBeenCalled();
    expect((client as unknown as { droppedForCap: number }).droppedForCap).toBe(2);
  });

  it('clears the queue on disconnect and never dispatches it afterward', () => {
    const { client, dispatch } = connectedClient();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(true);
    client.sendShotForCoaching(shot({ id: 'a', index: 1 }));
    client.sendShotForCoaching(shot({ id: 'b', index: 2 }));
    expect(queueIds(client)).toEqual(['a', 'b']);

    client.disconnect();
    expect(queueIds(client)).toEqual([]);
    expect((client as unknown as { droppedForCap: number }).droppedForCap).toBe(0);

    // A late playback-done signal must not resurrect a dead/stale shot.
    audioPlayer.onPlaybackDone?.();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// --- connect flush: the FIRST shot (bug B) ----------------------------------
//
// The first completed swing almost always finishes while connect() is still in
// flight (token fetch / socket open), so it is enqueued BEFORE the client is
// connected. It must NOT be lost: it sits in the FIFO and flushes the instant
// the session goes live. (Under v0.7 freshest-wins a second early swing would
// replace and DROP the first — that was bug B: "ช็อตแรกไม่อ่านเลย".)

describe('CoachLiveClient connect flush (first shot is never dropped)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    audioPlayer.onPlaybackDone = null;
  });

  it('a shot enqueued while DISCONNECTED dispatches once the relay session goes live', async () => {
    vi.stubEnv('VITE_LIVE_TRANSPORT', 'relay');
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(false);

    // Minimal fake relay WS that opens + acks setup on a microtask.
    class FakeWS {
      static OPEN = 1;
      static instances: FakeWS[] = [];
      readyState = 0;
      url: string;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        FakeWS.instances.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
      send(s: string): void {
        this.sent.push(s);
      }
      close(): void {
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: '' });
      }
    }
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('fetch', vi.fn());

    const client = new CoachLiveClient();
    const dispatch = vi.fn();
    (client as unknown as { dispatchShot: (s: Shot) => void }).dispatchShot = dispatch;

    // First swing completes BEFORE connect — not connected yet, so it queues.
    client.sendShotForCoaching(shot({ id: 'first', index: 1 }));
    expect(dispatch).not.toHaveBeenCalled();
    expect((client as unknown as { queue: Shot[] }).queue.map((s) => s.id)).toEqual(['first']);

    // Now connect: the awaited session goes live and connect() flushes the queue.
    await client.connect();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].id).toBe('first');

    client.disconnect();
  });
});

// --- end-to-end shot numbering (TASK 4) -------------------------------------
//
// Bug A on court: card labeled "ช็อต N" showed a critique whose spoken opener
// said "ช็อตที่ N-1". This walk proves the numbering is self-consistent inside
// liveClient: for every shot, the OPENER in the dispatched prompt names that
// shot's own index AND the finalized critique attaches to that same shot's id +
// its contact capture — no shift. It is the positive regression guard the FIFO
// refactor must not break (attribution code is untouched by that refactor).

describe('end-to-end shot numbering (each critique lands on its OWN shot)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    audioPlayer.onPlaybackDone = null;
    appStore.setState(() => ({ shots: [] }));
  });

  function connectedClient() {
    const client = new CoachLiveClient();
    (client as unknown as { connected: boolean }).connected = true;
    const sent: string[] = [];
    const session = {
      sendRealtimeInput: vi.fn(),
      sendClientContent: vi.fn((p: { turns: unknown }) => {
        sent.push(typeof p.turns === 'string' ? p.turns : JSON.stringify(p.turns));
      }),
      close: vi.fn(),
    };
    (client as unknown as { session: unknown }).session = session;
    return { client, session, sent };
  }

  /** Simulate one clean coach turn: streamed transcript then turnComplete. */
  function feedTurn(client: CoachLiveClient, transcript: string) {
    const hm = (
      client as unknown as { handleMessage: (m: unknown) => void }
    ).handleMessage.bind(client);
    hm({ serverContent: { outputTranscription: { text: transcript } } });
    hm({ serverContent: { turnComplete: true } });
  }

  it('walks 3 sequential shots: each prompt opener names its own index, each critique attaches to its own shot + contact capture', () => {
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(false);
    appStore.setState((s) => ({
      settings: { ...s.settings, sendContactFrame: true },
      lang: 'th',
    }));

    const shots = [1, 2, 3].map((n) =>
      shot({
        id: `shot-${n}`,
        index: n,
        type: 'forehand',
        captures: [capture('contact', 200, { id: `cap-contact-${n}`, shotId: `shot-${n}` })],
      }),
    );
    // Seed the store so attachCoaching / attachCaptureCritique have real targets.
    appStore.setState(() => ({ shots }));

    const { client, sent } = connectedClient();

    shots.forEach((s, i) => {
      client.sendShotForCoaching(s);
      // The prompt dispatched THIS turn opens by naming THIS shot's index.
      expect(sent[i]).toContain(`ช็อตที่ ${s.index}`);
      // Coach speaks a shot-specific line, then the turn completes.
      feedTurn(client, `ช็อตที่ ${s.index} โฟร์แฮนด์ ดีมาก`);
    });

    // Exactly three turns dispatched, in order — nothing dropped, nothing shifted.
    expect(sent).toHaveLength(3);

    for (const s of appStore.getState().shots) {
      const expected = `ช็อตที่ ${s.index} โฟร์แฮนด์ ดีมาก`;
      expect(s.coaching?.text).toBe(expected);
      const contact = s.captures.find((c) => c.phase === 'contact');
      expect(contact?.critique).toBe(expected);
    }
  });
});

// --- pickCoachingStyle statefulness (v1.0 variety v2) -----------------------
//
// The stateful wrapper (private on CoachLiveClient) must never hand out a
// style id that is still inside its own 3-entry recency window, even when the
// same score band recurs a few "shots" later — this is the actual fix for the
// v0.9 known-minor (queue-dropped shots letting two HEARD critiques repeat a
// style). We reach the private method the same way other tests in this file
// reach private fields: a runtime cast.

describe('CoachLiveClient.pickCoachingStyle (stateful no-repeat window)', () => {
  function pick(client: CoachLiveClient, score: number, index: number) {
    return (
      client as unknown as { pickCoachingStyle: (s: number, i: number) => { id: string; band: string } }
    ).pickCoachingStyle(score, index);
  }
  /** Simulate the clean-turn commit finalizeTurn performs once a critique is SPOKEN. */
  function commit(client: CoachLiveClient) {
    (client as unknown as { commitPendingStyle: () => void }).commitPendingStyle();
  }

  it('never repeats a HEARD style id across consecutive spoken turns, even at a constant (score, index)', () => {
    const client = new CoachLiveClient();
    let prev = '';
    for (let i = 0; i < 20; i += 1) {
      const id = pick(client, 90, 0).id; // constant score+index would repeat under the old pure selector
      expect(id).not.toBe(prev);
      commit(client); // the critique was spoken to completion
      prev = id;
    }
  });

  it('does not repeat a same-band style within its own 5-entry recency window', () => {
    const client = new CoachLiveClient();
    const ids: string[] = [];
    for (const idx of [0, 1, 2, 3, 4]) {
      ids.push(pick(client, 62, idx).id);
      commit(client);
    }
    // technical band has ≥7 variants — all five spoken picks in the window must be distinct.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the recency window capped at exactly 5 entries, evicting the oldest', () => {
    const client = new CoachLiveClient();
    const ids: string[] = [];
    for (const idx of [0, 1, 2, 3, 4, 5]) {
      ids.push(pick(client, 62, idx).id);
      commit(client);
    }
    const recentIds = (client as unknown as { recentStyleIds: string[] }).recentStyleIds;
    // Six spoken picks, but the window caps at 5 — the oldest (ids[0]) is evicted.
    expect(recentIds).toHaveLength(5);
    expect(recentIds).toEqual(ids.slice(-5));
    expect(recentIds).not.toContain(ids[0]);
  });

  it('a pick that is never spoken (failed send) does not pollute the window', () => {
    const client = new CoachLiveClient();
    const first = pick(client, 90, 0).id;
    commit(client); // heard
    // Two failed dispatches: picked but never committed (error path nulls pendingStyleId;
    // here simply not committing models "never spoken").
    pick(client, 90, 1);
    pick(client, 90, 2);
    const recentIds = (client as unknown as { recentStyleIds: string[] }).recentStyleIds;
    // Only the HEARD style is in the window — failed picks must not evict it.
    expect(recentIds).toEqual([first]);
    // And the next spoken pick still avoids the heard id.
    const next = pick(client, 90, 3).id;
    expect(next).not.toBe(first);
  });

  it('resets its recency memory on disconnect()', () => {
    const client = new CoachLiveClient();
    const first = pick(client, 90, 0).id;
    client.disconnect();
    // With a cleared window, the very next pick is free to return the same id
    // as a fresh session's first pick (index 0, no history) would.
    const recentIds = (client as unknown as { recentStyleIds: string[] }).recentStyleIds;
    expect(recentIds).toEqual([]);
    // Sanity: a fresh CoachLiveClient's first pick at the same score/index
    // matches what this client now produces post-reset.
    const freshFirst = pick(new CoachLiveClient(), 90, 0).id;
    expect(pick(client, 90, 0).id).toBe(freshFirst);
    void first;
  });
});

// --- coachAudioTap wiring (v1.0 audio persistence) --------------------------
//
// liveClient forwards every coach PCM chunk to coachAudioTap.onChunk
// regardless of the coachVoiceOn speaker toggle, finalizes the accumulated
// turn to the pending shot on a CLEAN turnComplete, and discards on
// interruption / close / disconnect. Mocked at the top of this file.

describe('coachAudioTap wiring', () => {
  beforeEach(() => {
    // Earlier describes in this file exercise real disconnect()/handleClose()
    // paths (e.g. the pacing-gate tests), which call the real coachAudioTap
    // mock and leave call history behind — clear it so each test here starts
    // from a clean slate regardless of run order.
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    audioPlayer.onPlaybackDone = null;
  });

  function pcmMessage(base64: string) {
    return {
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: base64, mimeType: 'audio/pcm;rate=24000' } }],
        },
      },
    };
  }

  function readyClient() {
    const client = new CoachLiveClient();
    (client as unknown as { connected: boolean }).connected = true;
    (client as unknown as { session: unknown }).session = { sendRealtimeInput: vi.fn(), sendClientContent: vi.fn() };
    return client;
  }

  it('taps every PCM chunk and finalizes for the pending shot on a clean turnComplete', () => {
    const client = readyClient();
    (client as unknown as { pendingShotId: string | null }).pendingShotId = 'shot-a';
    const handleMessage = (
      client as unknown as { handleMessage: (m: unknown) => void }
    ).handleMessage.bind(client);

    handleMessage(pcmMessage('AAA='));
    handleMessage(pcmMessage('BBB='));
    expect(coachAudioTap.onChunk).toHaveBeenCalledWith('AAA=');
    expect(coachAudioTap.onChunk).toHaveBeenCalledWith('BBB=');
    expect(coachAudioTap.finalizeForShot).not.toHaveBeenCalled();

    handleMessage({ serverContent: { turnComplete: true } });
    expect(coachAudioTap.finalizeForShot).toHaveBeenCalledWith('shot-a');
    expect(coachAudioTap.discard).not.toHaveBeenCalled();
  });

  it('taps chunks even when coachVoiceOn is off (persist regardless of speaker mute)', () => {
    const client = readyClient();
    (client as unknown as { pendingShotId: string | null }).pendingShotId = 'shot-b';
    const handleMessage = (
      client as unknown as { handleMessage: (m: unknown) => void }
    ).handleMessage.bind(client);
    const spy = vi.spyOn(audioPlayer, 'enqueue').mockImplementation(() => {});

    setCoachVoiceOn(false);
    handleMessage(pcmMessage('CCC='));
    expect(coachAudioTap.onChunk).toHaveBeenCalledWith('CCC=');
    expect(spy).not.toHaveBeenCalled(); // speaker gated off, tap is not
    setCoachVoiceOn(true);
  });

  it('discards accumulated audio on an interrupted turn', () => {
    const client = readyClient();
    (client as unknown as { pendingShotId: string | null }).pendingShotId = 'shot-c';
    const handleMessage = (
      client as unknown as { handleMessage: (m: unknown) => void }
    ).handleMessage.bind(client);
    vi.spyOn(audioPlayer, 'stop').mockImplementation(() => {});

    handleMessage(pcmMessage('DDD='));
    handleMessage({ serverContent: { interrupted: true } });
    expect(coachAudioTap.discard).toHaveBeenCalled();
    expect(coachAudioTap.finalizeForShot).not.toHaveBeenCalled();
  });

  it('discards on handleClose (socket died mid-turn)', () => {
    const client = readyClient();
    (client as unknown as { pendingShotId: string | null }).pendingShotId = 'shot-d';
    (client as unknown as { handleClose: (s: string, e?: unknown) => void }).handleClose('disconnected');
    expect(coachAudioTap.discard).toHaveBeenCalled();
  });

  it('discards on disconnect()', () => {
    const client = readyClient();
    client.disconnect();
    expect(coachAudioTap.discard).toHaveBeenCalled();
  });
});

// --- Vertex server-relay transport (SIT migration) --------------------------
//
// The relay wrapper speaks the Gemini Live BidiGenerateContent JSON protocol
// directly to a same-origin server WS. These cover the load-bearing pieces:
//   • frame serialization is BYTE-EXACT to what the @google/genai SDK emits for
//     Vertex (setup / clientContent / realtimeInput)
//   • relay-mode connect() SKIPS token fetch entirely (no AQ., no fetch)
//   • the default (no env) path is UNCHANGED — relay is strictly opt-in

describe('relay frame serialization (mirrors the SDK Vertex wire format)', () => {
  it('buildRelaySetupFrame pins responseModalities/outputAudioTranscription + carries systemInstruction', () => {
    const frame = buildRelaySetupFrame('gemini-live-2.5-flash', 'COACH PERSONA TEXT');
    expect(frame.setup.model).toBe('gemini-live-2.5-flash');
    // NO speechConfig: prod pins no voice and its default female voice is the
    // one the user wants — SIT must stay identical (v1.3.1).
    expect(frame.setup.generationConfig).toEqual({ responseModalities: ['AUDIO'] });
    // outputAudioTranscription MUST be present (empty object) to get transcript back.
    expect(frame.setup.outputAudioTranscription).toEqual({});
    // systemInstruction shaped exactly as contentToVertex(tContent(string)).
    expect(frame.setup.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'COACH PERSONA TEXT' }],
    });
  });

  it('serializeClientContent normalizes a string turn to Vertex Content[]', () => {
    const f = serializeClientContent({ turns: 'Comment on this forehand.', turnComplete: true });
    expect(f).toEqual({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: 'Comment on this forehand.' }] }],
        turnComplete: true,
      },
    });
  });

  it('serializeClientContent passes through an already-structured turns array', () => {
    const turns = [{ role: 'user', parts: [{ text: 'a' }] }];
    const f = serializeClientContent({ turns, turnComplete: false });
    expect(f.clientContent.turns).toEqual(turns);
    expect(f.clientContent.turnComplete).toBe(false);
  });

  it('serializeClientContent WRAPS a bare Content object (the inline-image dispatch path)', () => {
    // dispatchShot (relay) sends a single Content object { role, parts:[…images, {text}] };
    // normalizeTurns must wrap it as [obj] so the wire frame matches the proven
    // E2E frame { clientContent: { turns: [Content] } }. This is the exact hop the
    // inline-image fix depends on.
    const turn = {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'IMG' } }, { text: 'coach text' }],
    };
    const f = serializeClientContent({ turns: turn, turnComplete: true });
    expect(f.clientContent.turns).toEqual([turn]);
    expect(f.clientContent.turnComplete).toBe(true);
  });

  it('serializeRealtimeInput wraps a video JPEG blob under realtimeInput.video', () => {
    const f = serializeRealtimeInput({ video: { data: 'BASE64', mimeType: 'image/jpeg' } });
    expect(f).toEqual({
      realtimeInput: { video: { mimeType: 'image/jpeg', data: 'BASE64' } },
    });
  });
});

describe('relay-mode connect()', () => {
  // Minimal fake WebSocket (node test env has no WebSocket). Opens on a
  // microtask so RelayLiveSession has wired its handlers first.
  class FakeWS {
    static OPEN = 1;
    static instances: FakeWS[] = [];
    readyState = 0;
    url: string;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      FakeWS.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(s: string): void {
      this.sent.push(s);
    }
    close(): void {
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: '' });
    }
  }

  // envVar() falls back to process.env (browser-guarded), which is exactly what
  // vi.stubEnv patches in this vitest setup — so the source module sees it.
  beforeEach(() => {
    FakeWS.instances = [];
    // Clean, tokenless store so any AQ. token path would be forced to fail —
    // proving the relay path genuinely skips it.
    appStore.getState().setAuthToken('');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    audioPlayer.onPlaybackDone = null;
  });

  it('skips token fetch, opens the same-origin relay WS, and sends the setup frame first', async () => {
    vi.stubEnv('VITE_LIVE_TRANSPORT', 'relay');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', FakeWS);

    const client = new CoachLiveClient();
    await client.connect();

    // Token fetch NEVER happens on the relay transport.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Exactly one relay socket, to the default same-origin /api/live path.
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0].url).toContain('/api/live');
    expect(client.isConnected()).toBe(true);

    // The FIRST frame on the wire is the setup frame: pins the response
    // modality + transcription and carries the coach persona. `model` is a
    // non-empty advisory id (the relay SERVER pins the real global path); its
    // exact value is env/deploy-dependent, so we only assert it's present.
    const first = JSON.parse(FakeWS.instances[0].sent[0]);
    expect(typeof first.setup.model).toBe('string');
    expect(first.setup.model.length).toBeGreaterThan(0);
    expect(first.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(first.setup.outputAudioTranscription).toEqual({});
    expect(first.setup.systemInstruction.parts[0].text).toContain('โค้ช ADGE');

    client.disconnect();
  });

  it('buffers client frames until setupComplete, then flushes them in order', async () => {
    vi.stubEnv('VITE_LIVE_TRANSPORT', 'relay');
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('WebSocket', FakeWS);

    const client = new CoachLiveClient();
    await client.connect();
    const ws = FakeWS.instances[0];
    // Only the setup frame is on the wire so far (setupComplete not yet acked).
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).setup).toBeDefined();

    // Reach the underlying relay session and send two client frames pre-ack —
    // they must be HELD, not written, and not throw.
    const session = (client as unknown as { session: { sendRealtimeInput: (p: unknown) => void; sendClientContent: (p: unknown) => void } }).session;
    session.sendRealtimeInput({ video: { data: 'IMG', mimeType: 'image/jpeg' } });
    session.sendClientContent({ turns: 'hello', turnComplete: true });
    expect(ws.sent).toHaveLength(1); // still only the setup frame

    // Server acks setup → buffered frames flush in order.
    ws.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
    expect(ws.sent).toHaveLength(3);
    expect(JSON.parse(ws.sent[1]).realtimeInput.video.data).toBe('IMG');
    expect(JSON.parse(ws.sent[2]).clientContent.turnComplete).toBe(true);

    // A frame sent AFTER the ack goes straight to the wire.
    session.sendClientContent({ turns: 'again', turnComplete: true });
    expect(ws.sent).toHaveLength(4);

    client.disconnect();
  });

  it('is strictly opt-in: without VITE_LIVE_TRANSPORT it uses the token path and never opens a relay WS', async () => {
    // No relay env, no token → the AQ. path must reject and NO WebSocket opens.
    vi.stubEnv('VITE_GEMINI_TOKEN', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', FakeWS);

    const client = new CoachLiveClient();
    await expect(client.connect()).rejects.toThrow(/token missing/);
    expect(FakeWS.instances).toHaveLength(0);

    client.disconnect();
  });
});

// --- dispatchShot image delivery per transport (integrator fix) -------------
//
// Empirically proven E2E through /api/live: Vertex half-cascade
// gemini-live-2.5-flash IGNORES images sent via sendRealtimeInput({video}) once
// the mic is cut (v0.6) — the model replies "NO IMAGE RECEIVED" and prompt
// tokens stay TEXT-only. The frames MUST ride INSIDE the clientContent turn as
// inlineData parts (images in phase order, text last), which makes the model
// read the swing and Vertex bill the IMAGE-modality tokens. The AI-Studio path
// keeps its verified realtimeInput behavior so a merge to main is unaffected.

describe('dispatchShot image delivery per transport', () => {
  function connectedClient() {
    const client = new CoachLiveClient();
    (client as unknown as { connected: boolean }).connected = true;
    const session = {
      sendRealtimeInput: vi.fn(),
      sendClientContent: vi.fn(),
      close: vi.fn(),
    };
    (client as unknown as { session: unknown }).session = session;
    return { client, session };
  }

  beforeEach(() => {
    // dispatchShot only sends frames when this setting is on (default), be explicit.
    appStore.setState((s) => ({ settings: { ...s.settings, sendContactFrame: true } }));
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    audioPlayer.onPlaybackDone = null;
  });

  it('RELAY: sends frames INLINE in one clientContent turn (never realtimeInput), images in phase order then text last', () => {
    vi.stubEnv('VITE_LIVE_TRANSPORT', 'relay');
    const { client, session } = connectedClient();
    const s = shot({
      captures: [
        capture('follow-through', 300),
        capture('backswing', 100),
        capture('contact', 200),
      ],
    });
    client.sendShotForCoaching(s);

    // No streaming realtimeInput frames on the relay path — the bug being fixed.
    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
    // Exactly one turn, carrying the images inline + the text.
    expect(session.sendClientContent).toHaveBeenCalledTimes(1);
    const arg = session.sendClientContent.mock.calls[0][0] as {
      turns: { role: string; parts: Array<{ inlineData?: { data: string }; text?: string }> };
      turnComplete: boolean;
    };
    expect(arg.turnComplete).toBe(true);
    expect(arg.turns.role).toBe('user');
    const parts = arg.turns.parts;
    expect(parts).toHaveLength(4); // 3 images + 1 text
    // Images in canonical phase order.
    expect(parts.slice(0, 3).map((p) => p.inlineData?.data)).toEqual([
      'jpeg-backswing',
      'jpeg-contact',
      'jpeg-follow-through',
    ]);
    // Text part is LAST and its Frame-N mapping matches the image order.
    const text = parts[3].text ?? '';
    expect(text).toContain('Frame 1 = backswing');
    expect(text.indexOf('Frame 2 = ball contact')).toBeGreaterThan(text.indexOf('Frame 1 = backswing'));
    // Critique attribution still pins to the contact capture.
    expect(
      (client as unknown as { pendingContactCaptureId: string | null }).pendingContactCaptureId,
    ).toBe('cap-contact-200');
  });

  it('AI-STUDIO (no relay env): frames go via realtimeInput + a plain string turn (main-branch behavior unchanged)', () => {
    const { client, session } = connectedClient();
    const s = shot({
      captures: [capture('backswing', 100), capture('contact', 200)],
    });
    client.sendShotForCoaching(s);

    expect(session.sendRealtimeInput).toHaveBeenCalledTimes(2);
    expect((session.sendRealtimeInput.mock.calls[0][0] as { video: { data: string } }).video.data).toBe(
      'jpeg-backswing',
    );
    expect(session.sendClientContent).toHaveBeenCalledTimes(1);
    const arg = session.sendClientContent.mock.calls[0][0] as { turns: unknown };
    // A plain STRING turn on the AI-Studio path, not an inline Content object.
    expect(typeof arg.turns).toBe('string');
    expect(arg.turns as string).toContain('Frame 1 = backswing');
  });
});

// ---------------------------------------------------------------------------
// v1.1: Thai spoken numbers for the half-cascade (relay) voice.
// ---------------------------------------------------------------------------
describe('thaiNumberWords', () => {
  it('spells 0-999 correctly incl. Thai irregulars (เอ็ด/ยี่สิบ)', () => {
    expect(thaiNumberWords(5)).toBe('ห้า');
    expect(thaiNumberWords(11)).toBe('สิบเอ็ด');
    expect(thaiNumberWords(15)).toBe('สิบห้า');
    expect(thaiNumberWords(21)).toBe('ยี่สิบเอ็ด');
    expect(thaiNumberWords(82)).toBe('แปดสิบสอง');
    expect(thaiNumberWords(101)).toBe('หนึ่งร้อยเอ็ด');
    expect(thaiNumberWords(115)).toBe('หนึ่งร้อยสิบห้า');
  });
  it('falls back to digits outside 0-999', () => {
    expect(thaiNumberWords(1000)).toBe('1000');
    expect(thaiNumberWords(-1)).toBe('-1');
  });
});

// ---------------------------------------------------------------------------
// v1.3.1: TURN WATCHDOG — a model that never answers can never wedge the
// pipeline (on court this froze coaching AND, via the holdArm capture gate,
// all new captures — "ค้างไปเลย").
// ---------------------------------------------------------------------------
describe('turn watchdog (silent model can never wedge the pipeline)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    audioPlayer.onPlaybackDone = null;
    appStore.setState(() => ({ shots: [] }));
  });

  it('no reply within 20s → pending turn released, un-spoken shot requeued at the front and redispatched', () => {
    vi.useFakeTimers();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(false);

    const client = new CoachLiveClient();
    (client as unknown as { connected: boolean }).connected = true;
    const session = {
      sendRealtimeInput: vi.fn(),
      sendClientContent: vi.fn(),
      close: vi.fn(),
    };
    (client as unknown as { session: unknown }).session = session;

    const s1 = shot({ id: 'wedge-1', index: 1 });
    appStore.setState(() => ({ shots: [s1] }));

    client.sendShotForCoaching(s1);
    const internals = client as unknown as { pendingShotId: string | null; queue: Shot[] };
    expect(internals.pendingShotId).toBe('wedge-1');
    expect(session.sendClientContent).toHaveBeenCalledTimes(1);

    // Model stays silent past the watchdog deadline: the dead turn is released
    // and the SAME shot (nothing was spoken) is retried — isBusyCoaching (and
    // with it the capture holdArm gate) can therefore never stick closed.
    vi.advanceTimersByTime(20_001);
    expect(session.sendClientContent).toHaveBeenCalledTimes(2);
    expect(internals.pendingShotId).toBe('wedge-1'); // the retry is in flight

    client.disconnect();
    expect(internals.pendingShotId).toBeNull();
  });

  it('a turn that DID stream text before going silent is not repeated — released and the next shot proceeds', () => {
    vi.useFakeTimers();
    vi.spyOn(audioPlayer, 'isSpeaking').mockReturnValue(false);

    const client = new CoachLiveClient();
    (client as unknown as { connected: boolean }).connected = true;
    const session = {
      sendRealtimeInput: vi.fn(),
      sendClientContent: vi.fn(),
      close: vi.fn(),
    };
    (client as unknown as { session: unknown }).session = session;

    const s1 = shot({ id: 'spoke-1', index: 1 });
    const s2 = shot({ id: 'next-2', index: 2 });
    appStore.setState(() => ({ shots: [s1, s2] }));

    client.sendShotForCoaching(s1);
    // Partial transcript streams, then the model dies before turnComplete.
    (client as unknown as { handleMessage: (m: unknown) => void }).handleMessage({
      serverContent: { outputTranscription: { text: 'ช็อตที่หนึ่ง สวยมากค่ะ' } },
    });
    client.sendShotForCoaching(s2); // waits behind the pending turn

    vi.advanceTimersByTime(20_001);
    // The half-spoken shot is NOT retried (no repeat of a half-heard critique);
    // the queue moves on to shot 2.
    const internals = client as unknown as { pendingShotId: string | null };
    expect(internals.pendingShotId).toBe('next-2');

    client.disconnect();
  });
});

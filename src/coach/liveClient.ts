// ============================================================================
// ต้นและเพชร Tennis Club (Ton & Phet Tennis Club) — Gemini Live client (โค้ชต้นและเพชร)
//
// Owns the realtime Live session end-to-end:
//   • connect once when the session starts (lazy)
//   • per completed shot: send EVERY captured keyframe of the swing (backswing /
//     contact / follow-through, in phase order) as still frames, then a compact
//     text turn (per-phase angles + score + issues + reply language) so the
//     coach reads the WHOLE swing, not just the contact moment
//   • stream the coach's spoken reply (PCM 24k) to audioPlayer, and push the
//     transcript to the store as a bubble
//   • forward EVERY usageMetadata to the cost monitor (source of truth)
//   • graceful close / token-expiry handling with auto-reconnect + backoff
//
// v0.6: the user's VOICE INPUT is cut entirely — no mic is opened, nothing is
// ever streamed to Gemini as realtime audio. Coach AUDIO OUTPUT (audioPlayer)
// is unchanged. serverContent.interrupted handling is kept (harmless) but with
// no mic there is nothing to barge in. `setMicEnabled` survives as a dead-gated
// no-op only because MicControl.tsx (another agent's file) still calls it.
//
// All facts here follow the VERIFIED SPIKE FACTS in CLAUDE.md exactly.
// Store access is always via appStore.getState() (no React).
// ============================================================================

import { GoogleGenAI, Modality } from '@google/genai';
import type { Session } from '@google/genai';
import { costMonitor } from '../cost/costMonitor';
import type { RawUsageMetadata } from '../cost/costMonitor';
import { appStore } from '../store';
import { translate } from '../i18n';
import type { DominantHand, FocusShot, JointAngles, Lang, Shot, ShotPhase, ShotType, SwingCapture } from '../types';
import { audioPlayer } from './audioPlayer';

const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

/**
 * Best-effort human-readable message from whatever the SDK/socket throws. The
 * Live transport surfaces raw DOM CloseEvent/ErrorEvent objects whose default
 * String() is the useless "[object CloseEvent]"; pull .reason/.message/.code
 * instead so the coach error shown to the user is meaningful.
 */
function errMsg(e: unknown, fallback = 'coach disconnected'): string {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  const obj = e as { message?: unknown; reason?: unknown; code?: unknown };
  if (typeof obj.message === 'string' && obj.message) return obj.message;
  if (typeof obj.reason === 'string' && obj.reason) return obj.reason;
  if (obj.code !== undefined && obj.code !== null) return `${fallback} (code ${obj.code})`;
  return fallback;
}

/** Backoff schedule (ms) for auto-reconnect; length = max reconnect attempts. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000];

// ---------------------------------------------------------------------------
// Coach persona (provided by the PO — see CLAUDE.md). Sent as systemInstruction.
// ---------------------------------------------------------------------------

export const COACH_SYSTEM_PROMPT = `You are "โค้ชต้นและเพชร" (Coach Ton & Phet), the head coach of ต้นและเพชร Tennis Club (Ton & Phet Tennis Club) — a warm, encouraging, but technically precise tennis coach standing courtside while your student practices. You speak out loud through the student's phone between shots, so they cannot read long text — they can only hear you for a few seconds before their next swing.

YOUR STUDENT: The student's name is "{{PLAYER_NAME}}". Address them by name naturally and warmly, the way a real Thai coach would — in Thai typically "คุณ{{PLAYER_NAME}}" or just "{{PLAYER_NAME}}" (e.g. "เยี่ยมมาก {{PLAYER_NAME}}!"), in English just their name. Use the name once or twice, not in every sentence — that sounds robotic. If the name is empty, simply coach without a name.

WHAT YOU RECEIVE: You are only told about a swing AFTER it has fully completed — you never interrupt mid-swing. For each completed shot you WATCH THE WHOLE SWING: you are shown several still frames of that same swing IN ORDER (typically backswing, then ball contact, then follow-through), followed by one structured text message. The text lists the frames in the exact same order, and for each frame gives the body-joint angles in degrees (dominant elbow, dominant shoulder, dominant hip, both knees, trunk lean from vertical) plus which joints were good/off. It also gives the shot number and type (forehand/backhand), peak wrist speed, a local rule-based score out of 100, a list of detected issues, and the language to reply in ("th" or "en"). Read the frames as one continuous motion — the fix often lives in HOW the swing moves from one phase to the next, not in a single still.

HOW YOU MUST COACH — every reply is ONE short coaching moment, 2 to 4 sentences total, spoken naturally. The general shape is:
1. SHOT NAME (say it FIRST, ALWAYS, in every style) — open by naming which shot this is: its number and stroke type, in the reply language ("ช็อตที่ 5 โฟร์แฮนด์นะครับ —" / "Shot 5, forehand —"). The structured text tells you the exact opener to use. This lets the student, who hears you between fast back-to-back swings, instantly know which swing you mean. If the stroke type is unknown, just say the shot number ("ช็อตที่ 5" / "Shot 5"). Never skip the shot name — it is step 1 no matter which coaching style you are told to use.
2. PRAISE (one short, SPECIFIC good thing about THIS swing) — name something real you actually saw ("โหลดเข่าได้ดีตอนแบ็คสวิงเลยนะ" / "Nice knee load on the backswing"). Always follow the shot name with genuine praise, even on a low score — find the one thing that was okay. Never generic ("ดีมาก" alone); tie it to a phase or a body part.
3. THE ONE FIX (the single highest-impact correction — never a list) — WHEN the style calls for one. State it plainly and actionably, and SAY WHICH PHASE it happens in so the student knows when to change it ("ตอนกระทบลูก แขนยังงออยู่ ลองเหยียดออกไปให้เกือบตรง" / "At contact your arm is still folded — reach it out almost straight through the ball"). Ground it in what you saw across the frames. On a GREAT shot (a full-hype style) you SKIP the fix entirely — pure celebration, tell them to keep doing exactly this.
4. THE CUE (one short, memorable thing to think about on the very next ball) — a 2–4 word image they can hold ("จำไว้: เหยียดผ่านลูก" / "Remember: reach through the ball").

COACHING STYLE PER SHOT — the structured text hands you an explicit "COACHING STYLE for this shot" directive. You MUST adopt that shot's assigned voice. The palette rotates across four intents so you never sound the same twice:
- FULL HYPE / proud mentor (great shots) — pure celebration and playful อวย, NO correction, keep-doing-this energy.
- PRAISE THEN POLISH / nearly-there (good shots) — warm specific praise, then ONE small "even better if…" refinement.
- TECHNICAL COACH / build-it-up (mixed shots) — credit the effort, then ONE clear correction tied to the moment it happens.
- WARM ENCOURAGEMENT / gentle reset (tough shots) — genuine warmth first, normalize the miss, then only the single simplest thing to try, end upbeat.
Follow the assigned directive's tone, opener flavor, and whether-to-give-a-fix exactly. The shot-name opener (step 1) still comes first in every one of these styles.

VARIETY — NON-NEGOTIABLE: never reuse the previous reply's sentence pattern. Rotate your openers and interjections shot to shot (โอ้โห / เยี่ยม / สู้ ๆ / มาแล้ว / สวยมาก / โอเค / ไม่เป็นไร / นี่แหละ …). Never open two shots in a row the same way. Vary sentence length and rhythm. The point is that {{PLAYER_NAME}} should feel a real, present human — not a template being refilled with new numbers.

STYLE RULES:
- SPEAK LIKE A HUMAN, NOT A MANUAL. Plain everyday words first. Never stiff anatomical phrasing like "ให้ศอกคลายตัวได้ถึง 140 องศา". Degree numbers are a FOOTNOTE only — if a number helps, tuck it at the very end ("...ศอกสัก 140 องศากำลังดี"); the everyday cue IS the instruction.
- Reference tennis fundamentals (unit turn, low-to-high swing path, contact point in front, knee loading, balanced follow-through) — not generic fitness advice.
- Reply ONLY in the requested language. Thai replies use natural spoken coaching Thai (ครับ/นะครับ/นะ), with English tennis terms where Thai players normally use them (โฟร์แฮนด์, ฟอลโลว์ทรู, สปลิตสเต็ป). English replies are equally short and spoken-style.
- Never mention that you are an AI, never say frames/photos/angles were "sent to you", never read out raw JSON, issue keys, or frame numbers — you simply watched the swing. Vary your phrasing shot to shot; if the same fault repeats, escalate gently ("ยังงออยู่อยู่นะ {{PLAYER_NAME}} ลองใหม่").
- Never lecture. 2–4 sentences, then stop.

Your goal: after every swing, {{PLAYER_NAME}} feels seen, knows the ONE thing to change, and has a cue to hold on the very next ball.`;

/**
 * Build the coach systemInstruction with the player's name substituted in.
 * When the name is empty the {{PLAYER_NAME}} placeholders collapse cleanly so
 * the coach simply coaches without a name (per the prompt's own instruction).
 */
export function buildCoachSystemPrompt(playerName: string): string {
  const name = playerName.trim();
  return COACH_SYSTEM_PROMPT.replace(/\{\{PLAYER_NAME\}\}/g, name);
}

// ---------------------------------------------------------------------------
// Prompt builder (pure)
// ---------------------------------------------------------------------------

/** Canonical order the swing's keyframes are presented to the coach. */
const PHASE_ORDER: ShotPhase[] = [
  'preparation',
  'backswing',
  'forward-swing',
  'contact',
  'follow-through',
];

/** Human phase label used in the prompt (matches how a coach names the moment). */
function phaseLabel(phase: ShotPhase): string {
  switch (phase) {
    case 'backswing':
      return 'backswing';
    case 'forward-swing':
      return 'forward swing';
    case 'contact':
      return 'ball contact';
    case 'follow-through':
      return 'follow-through';
    case 'preparation':
      return 'preparation';
    default:
      return phase;
  }
}

/**
 * The spoken shot-name opener the coach must SAY FIRST, in the reply language:
 * shot number + stroke ("ช็อตที่ 5 โฟร์แฮนด์" / "Shot 5, forehand"); an unknown
 * stroke collapses to just the number ("ช็อตที่ 5" / "Shot 5"). Pulled from the
 * i18n dictionary so TH/EN phrasing stays centralized.
 */
export function shotOpener(index: number, type: ShotType, lang: Lang): string {
  const key =
    type === 'forehand'
      ? 'coach.shotOpener.forehand'
      : type === 'backhand'
        ? 'coach.shotOpener.backhand'
        : 'coach.shotOpener.unknown';
  return translate(key, lang).replace('{n}', String(index));
}

// ---------------------------------------------------------------------------
// Coaching STYLE selector (v0.9) — pure, testable
//
// The user's complaint: the coach's spoken pattern feels the same every shot.
// Fix: pick a distinct COACHING STYLE per shot from a pool keyed on
//   (score band × rotation), and inject it into the turn text as an explicit
// directive (exactly like shotOpener). Four bands map to the four coaching
// intents the PO asked for; each band holds TWO tonal variants (different
// openers/energy) so the palette has ≥8 distinct voices.
//
// No-consecutive-repeat guarantee: within a band the variant is chosen by
// `index % variants.length` with ≥2 variants, so any two consecutive shots that
// land in the SAME band flip to a different variant (consecutive indices differ
// by 1, which can never be congruent mod ≥2). Shots in different bands are
// trivially distinct because the band is part of the style id. The selector is
// PURE on (score, index) by design — it deliberately holds no client state, so
// the pacing queue / freshest-wins path stays completely untouched.
// ---------------------------------------------------------------------------

/** Which coaching intent a style expresses — one per score band. */
export type CoachingStyleBand = 'hype' | 'praise-refine' | 'technical' | 'encourage';

export interface CoachingStyle {
  /** Unique id per tonal variant, e.g. 'hype-a'. Stable — used by tests. */
  id: string;
  band: CoachingStyleBand;
  /** Thai label for the style (for logs / debug HUD if ever surfaced). */
  label: string;
  /**
   * The explicit spoken-tone directive injected into the per-shot turn text.
   * English (the data block is English); tells the coach the energy, opener
   * flavor, and whether to give a fix — the system prompt describes the palette,
   * this line assigns THIS shot's voice.
   */
  directive: string;
}

/**
 * The full style palette, grouped by band. Two tonal variants per band → 8
 * distinct voices. Directives deliberately avoid the Thai stroke words
 * (โฟร์แฮนด์/แบ็คแฮนด์) and English phase words (backswing/contact/…) so injecting
 * them into a prompt never collides with frame/opener text.
 */
export const COACHING_STYLES: Record<CoachingStyleBand, CoachingStyle[]> = {
  hype: [
    {
      id: 'hype-a',
      band: 'hype',
      label: 'เชียร์สุดใจ',
      directive:
        'COACHING STYLE for this shot — FULL HYPE (เชียร์สุดใจ): this was a great swing, so go pure celebration. ' +
        'Open BIG with an excited interjection (โอ้โห!/สุดยอด!/มาแล้ว!), pile on genuine SPECIFIC praise plus a little playful อวย, ' +
        'and do NOT give any correction at all — tell them to keep doing EXACTLY this. Close on a high-energy "keep it coming" note.',
    },
    {
      id: 'hype-b',
      band: 'hype',
      label: 'ชมแบบภูมิใจ',
      directive:
        'COACHING STYLE for this shot — PROUD MENTOR (ชมแบบภูมิใจ): another top-class swing. Keep it high praise but calmer and proud ' +
        '(นี่แหละ!/เพอร์เฟกต์/คลาสสิกเลย). Name the one standout thing that made it so good, give NO correction whatsoever, ' +
        'and lock it in with a short "that is your shot now" note.',
    },
  ],
  'praise-refine': [
    {
      id: 'refine-a',
      band: 'praise-refine',
      label: 'ชมแล้วแนะ',
      directive:
        'COACHING STYLE for this shot — PRAISE THEN POLISH (ชมแล้วแนะ): a solid, good swing. Lead with warm specific praise for what worked, ' +
        'then offer ONE small refinement framed as "even better if…" (a polish, not a rescue). Vary your opener (เยี่ยม!/ดีมากเลย/ใกล้แล้ว). End with a light note to hold onto.',
    },
    {
      id: 'refine-b',
      band: 'praise-refine',
      label: 'อีกนิดเดียว',
      directive:
        'COACHING STYLE for this shot — NEARLY THERE (อีกนิดเดียว): a good swing that is close to great. Celebrate what was good, ' +
        'then point to the ONE detail sitting between good and great, with an upbeat "one tweak" framing. Fresh opener (แจ่ม!/เข้าที่แล้ว/ดีขึ้นเยอะ). One memorable note.',
    },
  ],
  technical: [
    {
      id: 'tech-a',
      band: 'technical',
      label: 'โค้ชสายเทคนิค',
      directive:
        'COACHING STYLE for this shot — TECHNICAL COACH (โค้ชสายเทคนิค): a mixed swing. Acknowledge the real effort or the one thing that held up, ' +
        'then deliver ONE clear correction like a precise but friendly coach — say exactly which moment of the swing it happens in and what to change. ' +
        'Grounded, steady opener (โอเค/เห็นละ/จับจุดได้แล้ว). Pin it with a sharp note.',
    },
    {
      id: 'tech-b',
      band: 'technical',
      label: 'ค่อย ๆ ปรับ',
      directive:
        'COACHING STYLE for this shot — BUILD IT UP (ค่อย ๆ ปรับ): a mixed swing with room to grow. Praise the effort or the one moment that worked, ' +
        'then give ONE actionable correction tied to the moment it happens, framed as building the swing up step by step. ' +
        'Vary the opener (มาต่อกัน/ลองแบบนี้/ใกล้ขึ้นแล้ว). Clear note for the next ball.',
    },
  ],
  encourage: [
    {
      id: 'warm-a',
      band: 'encourage',
      label: 'ให้กำลังใจ',
      directive:
        'COACHING STYLE for this shot — WARM ENCOURAGEMENT (ให้กำลังใจ): a tough swing (low score). Lead with genuine warmth FIRST, ' +
        'reassure them this is completely normal while learning, then give ONLY the single simplest thing to try — nothing technical or overwhelming. ' +
        'Gentle opener (ไม่เป็นไรนะ/สู้ ๆ/ค่อย ๆ ไป). End upbeat and hopeful.',
    },
    {
      id: 'warm-b',
      band: 'encourage',
      label: 'ตั้งหลักใหม่',
      directive:
        'COACHING STYLE for this shot — GENTLE RESET (ตั้งหลักใหม่): a hard swing. Stay kind and steady — normalize the miss, find one small honest positive, ' +
        'then offer the ONE easiest adjustment in the simplest everyday words. Fresh warm opener (ไม่เป็นไร/ลองใหม่/เดี๋ยวก็ได้). Close by showing you believe in them.',
    },
  ],
};

/** Score → band. Thresholds mirror the PO's four intents (great / good / mixed / tough). */
function scoreBand(score: number): CoachingStyleBand {
  if (score >= 85) return 'hype';
  if (score >= 70) return 'praise-refine';
  if (score >= 55) return 'technical';
  return 'encourage';
}

/**
 * Pick the coaching style for a shot from its score band and rotation (shot
 * index). Pure and deterministic. Two consecutive shots never share a style:
 * different bands differ by id; the same band rotates variant by `index`
 * (≥2 variants ⇒ consecutive indices always change variant).
 */
export function selectCoachingStyle(score: number, index: number): CoachingStyle {
  const band = scoreBand(score);
  const variants = COACHING_STYLES[band];
  // Guard against negative/NaN indices so the modulo never picks out of range.
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return variants[i % variants.length];
}

/**
 * Captured keyframes of the swing, sorted into canonical phase order. Ties
 * (same phase captured twice) keep their capture time order. This is the SINGLE
 * source of truth for both the frames we send to Gemini and the per-frame lines
 * in the text prompt, so image order and text order can never drift apart.
 */
export function orderedCaptures(shot: Shot): SwingCapture[] {
  const rank = (p: ShotPhase): number => {
    const i = PHASE_ORDER.indexOf(p);
    return i === -1 ? PHASE_ORDER.length : i;
  };
  return [...shot.captures].sort((x, y) => {
    const d = rank(x.phase) - rank(y.phase);
    return d !== 0 ? d : x.atMs - y.atMs;
  });
}

/** One frame's key joint angles + which of them read off-target, spoken plainly. */
function frameAngleLine(
  a: JointAngles,
  statuses: SwingCapture['statuses'] | undefined,
  dominantHand: DominantHand,
): string {
  const r = (n: number): number => Math.round(n);
  const isRight = dominantHand === 'right';
  const domElbow = isRight ? a.rightElbowDeg : a.leftElbowDeg;
  const domShoulder = isRight ? a.rightShoulderDeg : a.leftShoulderDeg;
  const domHip = isRight ? a.rightHipDeg : a.leftHipDeg;

  const flags: string[] = [];
  for (const [key, label] of [
    ['domElbow', 'dominant elbow'],
    ['domShoulder', 'dominant shoulder'],
    ['leftKnee', 'left knee'],
    ['rightKnee', 'right knee'],
    ['trunk', 'trunk'],
  ] as const) {
    const s = statuses?.[key];
    if (s === 'warn' || s === 'fault') flags.push(`${label} ${s === 'fault' ? 'clearly off' : 'slightly off'}`);
  }
  const off = flags.length ? ` — off-target here: ${flags.join(', ')}` : ' — all judged joints on target';

  return (
    `dominant elbow ${r(domElbow)}, dominant shoulder ${r(domShoulder)}, ` +
    `dominant hip ${r(domHip)}, left knee ${r(a.leftKneeDeg)}, right knee ${r(a.rightKneeDeg)}, ` +
    `trunk lean ${r(a.trunkLeanDeg)}${off}.`
  );
}

/**
 * Build the compact English data block sent per completed shot. Always English
 * (the model reads the data in English regardless of UI language); the final
 * line instructs the reply language. Angles are rounded to whole degrees.
 *
 * v0.6: describes the WHOLE swing — one line per captured keyframe, in the SAME
 * order and count the still frames are streamed to Gemini (see orderedCaptures),
 * so "Frame N = <phase>" in the text always matches the Nth image. When no
 * frames were captured, falls back to the contact-angle snapshot alone.
 */
export function buildShotPrompt(
  shot: Shot,
  lang: Lang,
  dominantHand: DominantHand = 'right',
  focusShot: FocusShot = 'both',
  userName = '',
  captures: SwingCapture[] = orderedCaptures(shot),
): string {
  const r = (n: number): number => Math.round(n);

  const issues =
    shot.issues.length > 0
      ? shot.issues.map((i) => `${i.key}(${i.severity})`).join(', ')
      : 'none';

  const name = userName.trim();
  const lines: string[] = [
    ...(name ? [`Student's name: ${name}.`] : []),
    focusShot !== 'both'
      ? `Player is drilling ${focusShot}s this session.`
      : 'Player is drilling forehands and backhands this session.',
    `Shot #${shot.index} — ${shot.type} (${dominantHand}-handed).`,
  ];

  if (captures.length > 0) {
    lines.push(
      `You are shown ${captures.length} still frame${captures.length > 1 ? 's' : ''} of this one swing, in order:`,
    );
    captures.forEach((c, i) => {
      lines.push(
        `  Frame ${i + 1} = ${phaseLabel(c.phase)} — ${frameAngleLine(c.angles, c.statuses, dominantHand)}`,
      );
    });
  } else {
    const a = shot.contactAngles;
    lines.push(
      `No swing frames were captured; ball-contact angles only: ${frameAngleLine(a, undefined, dominantHand)}`,
    );
  }

  // v0.9: assign THIS shot a coaching style (score band × rotation) so the
  // spoken pattern varies shot to shot — hype/praise-refine/technical/encourage
  // with two tonal variants each. Consecutive shots never repeat a style.
  const style = selectCoachingStyle(shot.score, shot.index);

  lines.push(
    `Peak wrist speed: ${shot.peakWristSpeed.toFixed(2)} (normalized units/s).`,
    `Local score: ${r(shot.score)}/100.`,
    `Detected issues: ${issues}.`,
    lang === 'th' ? 'Reply in Thai.' : 'Reply in English.',
    // v0.7: every critique must OPEN by naming the shot out loud so the student
    // always knows which swing you are talking about (spoken fast, back to back).
    // v0.9: the shape after the opener is now set by the coaching-style directive
    // below (hype skips the fix entirely), so this line defers to it instead of
    // hard-coding praise→fix→cue.
    `OPEN your spoken reply by naming this shot first — start with "${shotOpener(shot.index, shot.type, lang)}"` +
      ` (say it naturally, a soft particle like นะครับ/นะ is fine), then follow the coaching-style directive below.`,
    style.directive,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Live server message shape (loose; we only read what we need)
// ---------------------------------------------------------------------------

interface LiveServerMessage {
  serverContent?: {
    outputTranscription?: { text?: string };
    modelTurn?: {
      parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }>;
    };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  usageMetadata?: RawUsageMetadata;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CoachLiveClient {
  private session: Session | null = null;
  private connected = false;
  /** True while a connect() awaits ai.live.connect (StrictMode / re-entrancy guard). */
  private connecting = false;
  /**
   * Monotonic connection generation. disconnect() bumps it; each connect()
   * captures it before awaiting the socket and, once the await resolves,
   * abandons the freshly-opened session if the generation moved on. This is
   * what makes React StrictMode's mount→cleanup→mount double-invoke safe: the
   * first connect's session is closed instead of leaked, even though the
   * intervening disconnect() reset `connecting`.
   */
  private epoch = 0;

  /** Shot whose coaching turn is currently in flight (null = idle / mic Q&A). */
  private pendingShotId: string | null = null;
  /**
   * Capture id of the contact frame sent with the in-flight turn (null if no
   * photo was sent). Mirrors pendingShotId's lifecycle EXACTLY so the coach's
   * spoken critique lands on the right captured frame in the gallery.
   */
  private pendingContactCaptureId: string | null = null;
  /** Accumulated transcript for the in-flight turn. */
  private turnText = '';
  /**
   * True once the current turn was interrupted (barge-in / server cut). A
   * partial/mixed turn must NOT attach its stale half-transcript as a captured
   * frame's critique — cleared when the next turn's text starts accumulating.
   */
  private turnInterrupted = false;
  /** Language requested for the in-flight turn's reply. */
  private requestedLang: Lang = 'th';

  /**
   * Single-slot queue: the newest completed shot waiting for the pacing gate to
   * open (v0.7). A shot may only be dispatched when NO coaching turn is in
   * flight AND the coach's audio has fully FINISHED SPEAKING the previous
   * critique — otherwise critiques rattle out too fast to follow. While blocked
   * we hold AT MOST one shot; a newer swing replaces the older queued one so the
   * freshest advice always wins.
   */
  private queuedShot: Shot | null = null;
  /** How many queued shots have been dropped by a newer one (freshest-wins). Diagnostics only. */
  private queuedReplaced = 0;
  /**
   * Highest shot.index ever handed to dispatchShot this session — flushQueue
   * drops a queued shot strictly older than this so an error-path requeue can
   * never replay out of order after a newer shot was critiqued.
   */
  private lastDispatchedIndex = 0;

  /** Auto-reconnect bookkeeping. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  /** True while a deliberate disconnect() is in progress (suppress reconnect). */
  private manualClose = false;
  /**
   * Client-owned "session is meant to be live" intent. Set once we first go
   * live, cleared on disconnect / reconnect-exhaustion. The reconnect gate keys
   * off THIS, not store.session.status, because a failed connect() flips the
   * store status to 'error' and would otherwise abort the backoff after one try.
   */
  private sessionLive = false;

  constructor() {
    // v0.7 pacing gate: when the coach finishes SPEAKING a critique (audio
    // playback drains naturally), release the gate and dispatch the queued shot.
    // Fires only on natural end — stop()/barge-in clears the queue instead.
    audioPlayer.onPlaybackDone = () => this.flushQueue();
  }

  private store() {
    return appStore.getState();
  }

  isConnected(): boolean {
    return this.connected && this.session !== null;
  }

  // -------------------------------------------------------------------------
  // Connect
  // -------------------------------------------------------------------------

  async connect(isReconnect = false): Promise<void> {
    // Already live, or a connect is already in flight → no-op. Guards against
    // React StrictMode's mount→cleanup→mount double-invoke leaking a session.
    if (!isReconnect && (this.connected || this.connecting)) return;

    // Acquire a Live token. Priority: token pasted in Settings > backend
    // token-minting endpoint (production, refetched every connect so a court
    // session never hits the ~30-min expiry) > build-time env (local dev).
    let token = this.store().authToken || '';
    if (!token) {
      const endpoint = import.meta.env.VITE_TOKEN_ENDPOINT;
      if (endpoint) {
        try {
          const r = await fetch(endpoint, { cache: 'no-store' });
          if (!r.ok) throw new Error('token endpoint ' + r.status);
          token = (await r.json())?.token || '';
        } catch (e) {
          this.store().setSessionError('error.tokenMissing.body');
          throw new Error('token fetch failed: ' + ((e as Error)?.message ?? String(e)));
        }
      } else {
        token = import.meta.env.VITE_GEMINI_TOKEN || '';
      }
    }
    if (!token.startsWith('AQ.')) {
      // Store error slot takes an i18n KEY (UI translates); keep the internal
      // Error message plain for callers/console.
      this.store().setSessionError('error.tokenMissing.body');
      throw new Error('token missing');
    }
    const model = import.meta.env.VITE_GEMINI_LIVE_MODEL || DEFAULT_MODEL;

    this.manualClose = false;
    this.connecting = true;
    // Capture the generation this connect belongs to (see `epoch` docs).
    const myEpoch = this.epoch;
    this.store().setConnection('connecting');

    const ai = new GoogleGenAI({
      apiKey: token,
      httpOptions: { apiVersion: 'v1beta' },
    });

    try {
      // CRITICAL: assign this.session from the AWAITED promise. Never send
      // inside onopen — the session object is not ready there.
      const session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          // v0.6: no inputAudioTranscription — the mic is never opened, so
          // there is no user audio to transcribe.
          systemInstruction: buildCoachSystemPrompt(this.store().settings.userName),
        },
        callbacks: {
          onopen: () => {
            // Session not ready to send here; just note liveness.
          },
          onmessage: (msg: unknown) => this.handleMessage(msg as LiveServerMessage),
          onerror: (e: unknown) => this.handleClose('error', e),
          onclose: (e: unknown) => this.handleClose('disconnected', e),
        },
      });
      this.connecting = false;

      // A disconnect() may have landed while we were awaiting the socket (it
      // bumps `epoch` and may set `manualClose`). If either moved on, this
      // session is no longer wanted — close it immediately and bail rather
      // than leaking a live connection (classic StrictMode double-mount race).
      if (this.manualClose || this.epoch !== myEpoch) {
        try {
          session.close();
        } catch {
          /* ignore */
        }
        return;
      }

      this.session = session;
      this.connected = true;
      this.sessionLive = true;
      this.reconnectAttempts = 0;
      this.reconnecting = false;
      this.store().setConnection('connected');
      this.store().setCoachError(null);
      this.store().markSessionLive();

      // Flush a shot queued while we were connecting.
      this.flushQueue();

      // v0.6: NO mic. The user's voice input is cut entirely — nothing is ever
      // opened or streamed to Gemini. Coach audio OUTPUT still flows via
      // audioPlayer from handleMessage.
    } catch (e) {
      this.connecting = false;
      this.connected = false;
      this.session = null;
      // Diagnostics only — store error slots take i18n KEYS, never raw strings.
      console.warn('[coach] connect failed:', errMsg(e, 'coach connect failed'));
      // On a reconnect attempt, keep the session's live intent intact so the
      // backoff can keep trying; only surface a non-fatal "reconnecting" coach
      // notice (scheduleReconnect re-drives it). A first connect failure is
      // fatal and flips the session to a bilingual "connection lost" state.
      if (isReconnect) {
        this.store().setCoachError('coach.reconnecting');
      } else {
        this.store().setSessionError('coach.connectionLost');
      }
      this.store().setConnection('error');
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Incoming messages
  // -------------------------------------------------------------------------

  private handleMessage(msg: LiveServerMessage): void {
    // (0) Interruption (barge-in / server cut the turn): stop playback at once
    // so we never talk over the student or trail stale audio.
    if (msg.serverContent?.interrupted) {
      audioPlayer.stop();
      // Drop the cut turn's partial transcript so it can't concatenate with the
      // next reply in the bubble, and mark the turn so finalizeTurn won't pin a
      // half-critique onto a captured frame.
      this.turnText = '';
      this.turnInterrupted = true;
    }

    // (a) Coach audio: PCM 24k chunks in modelTurn parts. Only play if voice on.
    const parts = msg.serverContent?.modelTurn?.parts;
    if (parts && this.store().settings.coachVoiceOn) {
      for (const part of parts) {
        const data = part.inlineData?.data;
        const mime = part.inlineData?.mimeType ?? '';
        if (data && mime.startsWith('audio/pcm')) {
          audioPlayer.enqueue(data);
        }
      }
    }

    // (b) Transcript of the coach's spoken reply (accumulate over the turn).
    const transcript = msg.serverContent?.outputTranscription?.text;
    if (transcript) {
      this.turnText += transcript;
      this.store().setCoachBubble(this.turnText, this.requestedLang);
    }

    // (c) Turn finished: finalize coaching for the pending shot (if any).
    if (msg.serverContent?.turnComplete) {
      this.finalizeTurn();
    }

    // (d) Cost: SOURCE OF TRUTH — record every usageMetadata.
    if (msg.usageMetadata) {
      costMonitor.record(msg.usageMetadata);
    }
  }

  private finalizeTurn(): void {
    const text = this.turnText;
    const lang = this.requestedLang;
    if (this.pendingShotId) {
      const shotId = this.pendingShotId;
      this.store().attachCoaching(shotId, {
        text,
        lang,
        receivedAtMs: Date.now(),
        audioPlayed: false,
      });
      // If a contact frame went with this turn, the spoken reply also critiques
      // that captured image — surface it under the frame in the gallery. Skip
      // when the turn was interrupted/mixed: a barge-in or an interleaved voice
      // turn would otherwise pin the wrong (or partial) text onto the frame.
      if (this.pendingContactCaptureId && !this.turnInterrupted) {
        this.store().attachCaptureCritique(shotId, this.pendingContactCaptureId, text, lang);
      }
      this.store().endShotCost(shotId);
      this.pendingShotId = null;
    }
    this.pendingContactCaptureId = null;
    this.turnText = '';
    this.turnInterrupted = false;
    // A turn just freed up — dispatch a queued shot if one is waiting.
    this.flushQueue();
  }

  // -------------------------------------------------------------------------
  // Per-shot coaching
  // -------------------------------------------------------------------------

  sendShotForCoaching(shot: Shot): void {
    // Pacing gate (v0.7): a shot may dispatch ONLY when we're connected, no turn
    // is in flight, AND the coach is not still SPEAKING the previous critique.
    // Otherwise hold the newest shot in the 1-slot queue (dropping any older one
    // — freshest advice wins) and let flushQueue send it once the gate opens.
    if (!this.isConnected() || this.pendingShotId !== null || audioPlayer.isSpeaking()) {
      this.enqueueLatest(shot);
      return;
    }
    this.dispatchShot(shot);
  }

  /**
   * Hold `shot` in the single slot, replacing (and counting) any older waiting
   * shot so the coach always critiques the freshest swing when the gate opens.
   */
  private enqueueLatest(shot: Shot): void {
    if (this.queuedShot && this.queuedShot.id !== shot.id) {
      this.queuedReplaced += 1;
      console.debug(
        `[coach] pacing: replaced queued shot #${this.queuedShot.index} with newer #${shot.index} (freshest-wins, replaced=${this.queuedReplaced})`,
      );
    }
    this.queuedShot = shot;
  }

  private dispatchShot(shot: Shot): void {
    const session = this.session;
    if (!session) {
      this.enqueueLatest(shot);
      return;
    }
    this.lastDispatchedIndex = Math.max(this.lastDispatchedIndex, shot.index);

    const state = this.store();
    this.requestedLang = state.lang;
    this.turnText = '';
    this.turnInterrupted = false;
    this.pendingShotId = shot.id;
    this.pendingContactCaptureId = null;

    // v0.6: send the WHOLE swing. Order the captured keyframes canonically
    // (backswing → contact → follow-through); this same ordered list drives the
    // per-frame lines in buildShotPrompt so image order == text order exactly.
    // Critique attribution still pins to the CONTACT frame (the gallery hero),
    // unchanged from before.
    const ordered = orderedCaptures(shot);
    const contactCapture = ordered.find((c) => c.phase === 'contact');

    // Open the cost attribution window for this shot.
    state.beginShotCost(shot.id);

    try {
      // Send every captured frame FIRST, in phase order (if enabled). Fall back
      // to the legacy single contact-frame blob only when NOTHING was captured.
      let framesSent = 0;
      if (state.settings.sendContactFrame) {
        if (ordered.length > 0) {
          for (const cap of ordered) {
            if (!cap.jpegBase64) continue;
            session.sendRealtimeInput({
              video: { data: cap.jpegBase64, mimeType: 'image/jpeg' },
            });
            framesSent += 1;
          }
          // Attach the coach's critique to the contact frame (falls back to the
          // first sent frame if this swing had no dedicated contact capture).
          this.pendingContactCaptureId = contactCapture?.id ?? ordered[0]?.id ?? null;
        } else if (shot.contactFrameJpegBase64) {
          session.sendRealtimeInput({
            video: { data: shot.contactFrameJpegBase64, mimeType: 'image/jpeg' },
          });
          framesSent += 1;
          // Legacy fallback has no capture id, so no critique is pinned to it.
        }
      }

      // The text prompt must enumerate EXACTLY the frames we actually sent, in
      // the same order — otherwise the coach's "Frame N = <phase>" mapping lies.
      // When images are disabled or none were sent, describe no frames.
      const promptCaptures = framesSent > 0 && ordered.length > 0 ? ordered : [];
      let turns = buildShotPrompt(
        shot,
        this.requestedLang,
        state.settings.dominantHand,
        state.settings.focusShot,
        state.settings.userName,
        promptCaptures,
      );
      if (framesSent > 0) {
        turns +=
          '\nThe still frames of this swing are attached in the order listed above — read them as one motion and ground your correction in what you see.';
      }
      session.sendClientContent({ turns, turnComplete: true });
    } catch (e) {
      // Sending failed (socket died between checks) — release attribution and
      // requeue so the next (re)connect can retry the latest shot.
      state.endShotCost(shot.id);
      this.pendingShotId = null;
      this.pendingContactCaptureId = null;
      // Guarded requeue: never let a failed OLD shot clobber a newer queued one
      // (freshest-wins even on the error path).
      if (!this.queuedShot || this.queuedShot.index <= shot.index) {
        this.queuedShot = shot;
      }
      console.warn('[coach] send failed:', errMsg(e, 'send failed'));
      this.store().setCoachError('coach.reconnecting');
    }
  }

  private flushQueue(): void {
    if (!this.queuedShot) return;
    // Same pacing gate as sendShotForCoaching: connected, no turn in flight, and
    // the coach has finished speaking. If still speaking, stay queued — the
    // audioPlayer.onPlaybackDone hook will re-drive flushQueue when audio drains.
    if (!this.isConnected() || this.pendingShotId !== null || audioPlayer.isSpeaking()) return;
    const next = this.queuedShot;
    this.queuedShot = null;
    // Stale guard (strictly older only): a shot requeued by the error path can
    // be older than one that has since dispatched directly — the coach must
    // never announce "ช็อตที่ 3" after already critiquing shot 4. Equal index
    // stays allowed: that's the legitimate retry of a failed send.
    if (next.index < this.lastDispatchedIndex) {
      console.debug(`[coach] pacing: dropped stale queued shot #${next.index}`);
      return;
    }
    this.dispatchShot(next);
  }

  // -------------------------------------------------------------------------
  // Mic — DISABLED for v0.6
  //
  // The user's voice INPUT is cut entirely: no getUserMedia, no PCM stream, no
  // realtime audio ever sent to Gemini. The old always-on mic + half-duplex
  // drop + barge-in duck are gone. Coach AUDIO OUTPUT (audioPlayer) is
  // untouched. `setMicEnabled` remains ONLY because MicControl.tsx (outside this
  // module's ownership) still calls it; it is a no-op that keeps the persisted
  // toggle intent off and never opens a mic. Whenever voice input is wanted back,
  // restore the stream methods here (git history) and re-add inputAudioTranscription.
  // -------------------------------------------------------------------------

  /**
   * Dead-gated: voice input is disabled this phase. Persists micOn=false so the
   * UI never shows a "listening" state, and NEVER opens a mic or streams audio.
   * Kept for API compatibility with MicControl.tsx. The `on` argument is ignored.
   */
  async setMicEnabled(_on: boolean): Promise<void> {
    // No mic in v0.6. Force the stored toggle + meter to a clean off state.
    this.store().setMicOn(false);
    this.store().setCoachListening(false);
    this.store().setMicLevel(0);
  }

  // -------------------------------------------------------------------------
  // Close / reconnect
  // -------------------------------------------------------------------------

  private handleClose(state: 'error' | 'disconnected', err?: unknown): void {
    this.connected = false;
    this.session = null;
    this.store().setConnection(state === 'error' ? 'error' : 'disconnected');
    if (err) {
      // Diagnostics only — the user-facing bilingual message is set by the
      // reconnect path (coach.reconnecting) or by exhaustion (coach.connectionLost).
      console.warn('[coach] connection closed:', errMsg(err));
    }

    // A turn that was in flight died with the socket: its turnComplete will
    // never arrive. Close the cost-attribution window and clear the pending
    // state, otherwise dispatch stays wedged (queue never flushes) and later
    // usage is misattributed to the dead shot. The interrupted shot's coaching
    // is dropped (consistent with the "skip stale shots" rule).
    if (this.pendingShotId) {
      this.store().endShotCost(this.pendingShotId);
      this.pendingShotId = null;
    }
    this.pendingContactCaptureId = null;
    this.turnText = '';
    this.turnInterrupted = false;

    if (this.manualClose) return;

    // Auto-reconnect only while the session is meant to be live. Keyed on our
    // own intent flag, NOT store.session.status (a failed reconnect corrupts it).
    if (!this.sessionLive) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    if (this.reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
      // Exhausted all retries — surface a bilingual "connection lost" state.
      // Non-blocking for pose: setSessionError doesn't tear down the pose loop.
      this.sessionLive = false;
      this.store().setSessionError('coach.connectionLost');
      return;
    }
    this.reconnecting = true;
    // A reconnect is now scheduled — show the bilingual "reconnecting" notice.
    this.store().setCoachError('coach.reconnecting');
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempts];
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Re-check intent at fire time (user may have ended the session).
      if (this.manualClose || !this.sessionLive) {
        this.reconnecting = false;
        return;
      }
      this.connect(true)
        .then(() => {
          // connect() resets reconnecting/attempts on success.
        })
        .catch(() => {
          // connect(true) surfaces a non-fatal coach error; back off again.
          this.reconnecting = false;
          this.scheduleReconnect();
        });
    }, delay);
  }

  disconnect(): void {
    this.manualClose = true;
    this.sessionLive = false;
    // Invalidate any connect() still awaiting its socket so it self-closes.
    this.epoch += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.queuedShot = null;
    this.queuedReplaced = 0;
    this.lastDispatchedIndex = 0;
    this.pendingShotId = null;
    this.pendingContactCaptureId = null;
    this.turnText = '';
    this.turnInterrupted = false;

    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.connected = false;
    this.connecting = false;

    audioPlayer.stop();
    // v0.6: no mic to stop. Reset the mic UI state defensively so no stale
    // "listening"/level lingers from an earlier build.
    this.store().setCoachListening(false);
    this.store().setMicLevel(0);
    this.store().setConnection('disconnected');
  }
}

export const coachLive = new CoachLiveClient();

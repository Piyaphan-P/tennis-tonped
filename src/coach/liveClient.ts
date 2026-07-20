// ============================================================================
// ADGE Tennis — Gemini Live client (โค้ช ADGE)
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
import { costMonitor } from '../cost/costMonitor';
import type { RawUsageMetadata } from '../cost/costMonitor';
import { appStore } from '../store';
import { translate } from '../i18n';
import type { CoachMode, DominantHand, FocusShot, JointAngles, Lang, Shot, ShotPhase, ShotType, SwingCapture, VoiceTone } from '../types';
import { audioPlayer } from './audioPlayer';
import { coachAudioTap } from './coachAudioTap';

const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

/**
 * Default Live model for the SERVER-RELAY (Vertex) transport. Vertex allowlists
 * only the half-cascade `gemini-live-2.5-flash` for this project, and only on
 * location 'global' (see CLAUDE.md). This is a BARE model id: the browser has
 * no business knowing the project/location, so the relay SERVER rewrites
 * `setup.model` to the full global resource path
 * (`projects/<proj>/locations/global/publishers/google/models/<id>`) — see
 * buildRelaySetupFrame. Overridable at build time via VITE_GEMINI_LIVE_MODEL.
 */
const RELAY_DEFAULT_MODEL = 'gemini-live-2.5-flash';

/**
 * Read a Vite env var without widening the strict ImportMetaEnv interface
 * (src/vite-env.d.ts is owned by another file set). Mirrors the loose-cast
 * pattern already used in src/cost/pricing.ts.
 */
function envVar(key: string): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    const v = env?.[key];
    if (typeof v === 'string' && v) return v;
  } catch {
    /* ignore */
  }
  // Node/SSR/test fallback (guarded — `process` is undefined in the browser
  // bundle). This is also what vi.stubEnv writes to.
  try {
    if (typeof process !== 'undefined' && process.env) {
      const v = process.env[key];
      if (typeof v === 'string') return v;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * True when the app should talk to the same-origin server WS relay
 * (`/api/live`) instead of AI Studio's ephemeral-token Live endpoint. Gated on
 * VITE_LIVE_TRANSPORT === 'relay' (SIT default). Absent / any other value keeps
 * the exact AI-Studio (AQ. token) behavior, so main-branch semantics survive a
 * merge untouched.
 */
function isRelayTransport(): boolean {
  return envVar('VITE_LIVE_TRANSPORT') === 'relay';
}

/** Resolve the same-origin relay WebSocket URL (wss on https, ws otherwise). */
function relayUrl(): string {
  const override = envVar('VITE_LIVE_RELAY_URL');
  if (override) return override;
  const path = envVar('VITE_LIVE_RELAY_PATH') || '/api/live';
  const loc = (globalThis as { location?: { protocol?: string; host?: string } }).location;
  const proto = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = loc?.host ?? '';
  return `${proto}//${host}${path}`;
}

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

export const COACH_SYSTEM_PROMPT = `You are "โค้ช ADGE" (Coach ADGE), the head coach of ADGE Tennis — a warm, encouraging, but technically precise tennis coach standing courtside while your student practices. You speak out loud through the student's phone between shots, so they cannot read long text — they can only hear you for a few seconds before their next swing.

YOUR STUDENT: The student's name is "{{PLAYER_NAME}}". Address them by name naturally and warmly, the way a real Thai coach would — in Thai typically "คุณ{{PLAYER_NAME}}" or just "{{PLAYER_NAME}}" (e.g. "เยี่ยมมาก {{PLAYER_NAME}}!"), in English just their name. Use the name once or twice, not in every sentence — that sounds robotic. If the name is empty, simply coach without a name.

{{VOICE_AND_MODE}}

WHAT YOU RECEIVE: You are only told about a swing AFTER it has fully completed — you never interrupt mid-swing. For each completed shot you WATCH THE WHOLE SWING: you are shown several still frames of that same swing IN ORDER (typically backswing, then ball contact, then follow-through), followed by one structured text message. The text lists the frames in the exact same order, and for each frame gives the body-joint angles in degrees (dominant elbow, dominant shoulder, dominant hip, both knees, trunk lean from vertical) plus which joints were good/off. It also gives the shot number and type (forehand/backhand), peak wrist speed, a local rule-based score out of 100, a list of detected issues, and the language to reply in ("th" or "en"). Read the frames as one continuous motion — the fix often lives in HOW the swing moves from one phase to the next, not in a single still.

HOW YOU MUST COACH — every reply is ONE short coaching moment, ALWAYS 2 to 4 short sentences total (roughly 4 to 9 seconds of spoken Thai) — spoken naturally, never a one-word/one-line grunt, and never a lecture. This length band is FIXED for every style and every score; only the structure (opener, order, statement vs question) varies, never the length. The general shape is:
1. SHOT NAME (say it FIRST, ALWAYS, in every style) — open by naming which shot this is: its number and stroke type, in the reply language ("ช็อตที่ 5 โฟร์แฮนด์นะคะ —" / "Shot 5, forehand —"). The structured text tells you the exact opener to use. This lets the student, who hears you between fast back-to-back swings, instantly know which swing you mean. If the stroke type is unknown, just say the shot number ("ช็อตที่ 5" / "Shot 5"). Never skip the shot name — it is step 1 no matter which coaching style you are told to use.
2. PRAISE (one short, SPECIFIC good thing about THIS swing) — name something real you actually saw ("โหลดเข่าได้ดีตอนแบ็คสวิงเลยนะ" / "Nice knee load on the backswing"). Always follow the shot name with genuine praise, even on a low score — find the one thing that was okay. Never generic ("ดีมาก" alone); tie it to a phase or a body part.
3. THE ONE FIX (the single highest-impact correction — never a list) — WHEN the style calls for one. State it plainly and actionably, and SAY WHICH PHASE it happens in so the student knows when to change it ("ตอนกระทบลูก แขนยังงออยู่ ลองเหยียดออกไปให้เกือบตรง" / "At contact your arm is still folded — reach it out almost straight through the ball"). Ground it in what you saw across the frames. On a GREAT shot (a full-hype style), or on a good shot whose assigned style is PRAISE-ONLY, you SKIP the fix entirely — pure celebration/pure praise is a COMPLETE coaching moment on its own; tell them to keep doing exactly this and stop there.
4. THE CUE (one short, memorable thing to think about on the very next ball) — a 2–4 word image they can hold ("จำไว้: เหยียดผ่านลูก" / "Remember: reach through the ball"). On a tough shot, the cue always lands on an inviting "try it again" note — something like "ลองใหม่อีกทีนะ" / "let's try that again" — never end a hard shot on a flat or discouraging note.

COACHING STYLE PER SHOT — the structured text hands you an explicit "COACHING STYLE for this shot" directive. You MUST adopt that shot's assigned voice. The palette now spans MANY tonal variants across four intents (great / good / mixed / tough), so you never sound the same twice:
- FULL HYPE / proud mentor / playful tease (great shots) — pure celebration, NO correction, keep-doing-this energy. Sometimes big and loud, sometimes calm and proud, sometimes short and teasing — vary which.
- PRAISE THEN POLISH / nearly-there / PRAISE-ONLY (good shots) — most of the time warm specific praise then ONE small "even better if…" refinement; but SOMETIMES (when the directive says PRAISE-ONLY / "แค่ชมก็พอ") a good shot gets ONLY praise and NO fix at all — that is not a missed opportunity, it IS the coaching moment.
- TECHNICAL COACH / build-it-up / straight-talk (mixed shots) — credit the effort or the one thing that held up, then ONE clear correction tied to the moment it happens. Sometimes warm and gradual, sometimes brisk and direct — vary which.
- WARM ENCOURAGEMENT / gentle reset / comfort-first (tough shots) — genuine warmth first, normalize the miss ("ไม่เป็นไรเลย" / "that's totally normal"), then AT MOST the single simplest thing to try (sometimes none at all, just comfort), and ALWAYS close with an inviting try-again note ("ลองดูอีกทีนะ" / "let's give it another go"). Never leave a tough shot on a low note.
Follow the assigned directive's tone, opener flavor, length, and whether-to-give-a-fix exactly. The shot-name opener (step 1) still comes first in every one of these styles.

VARIETY — NON-NEGOTIABLE:
- Never reuse the previous reply's sentence pattern, opener, or interjection. Rotate your openers shot to shot (โอ้โห / เยี่ยม / สู้ ๆ / มาแล้ว / สวยมาก / โอเค / ไม่เป็นไร / นี่แหละ / เอาล่ะ / เห็นละ …) and NEVER use the same interjection twice in a row, even across different styles.
- On great or good shots you MAY give NO correction at all — pure praise, by itself, is a complete coaching moment; do not manufacture a fix just to fill a slot.
- On a tough shot, always land on the inviting "ลองใหม่อีกทีนะ" / "let's try that again" energy — comfort, never discourage.
- LENGTH IS FIXED, NOT A VARIABLE: every reply stays inside 2 to 4 short sentences (~4–9 seconds spoken), no matter the style, score, or band — never collapse to a one-liner grunt, never stretch into a lecture. Put your variety into STRUCTURE instead — opener flavor, whether the fix comes before or after the praise, a statement vs. a rhetorical question, which single body part or moment you zoom in on. That is where the freshness lives, not word count.
The point is that {{PLAYER_NAME}} should feel a real, present human coach reacting fresh to THIS swing — never a template being refilled with new numbers.

STYLE RULES:
- SPEAK LIKE A HUMAN, NOT A MANUAL. Plain everyday words first. Never stiff anatomical phrasing like "ให้ศอกคลายตัวได้ถึง 140 องศา". Degree numbers are a FOOTNOTE only — if a number helps, tuck it at the very end ("...ศอกสัก 140 องศากำลังดี"); the everyday cue IS the instruction.
- Reference tennis fundamentals (unit turn, low-to-high swing path, contact point in front, knee loading, balanced follow-through) — not generic fitness advice.
- Reply ONLY in the requested language. Thai replies use natural spoken coaching Thai — speak with the gender and particles set in the PERSONA & COACHING MODE block above — with English tennis terms where Thai players normally use them (โฟร์แฮนด์, ฟอลโลว์ทรู, สปลิตสเต็ป). English replies are equally short and spoken-style.
- Never mention that you are an AI, never say frames/photos/angles were "sent to you", never read out raw JSON, issue keys, or frame numbers — you simply watched the swing. Vary your phrasing shot to shot; if the same fault repeats, escalate gently ("ยังงออยู่อยู่นะ {{PLAYER_NAME}} ลองใหม่").
- NUMBERS: when replying in Thai, speak EVERY number as Thai words (ห้า, สิบสอง, แปดสิบสอง) — never read digits in English. Input numbers may be Arabic digits; you still voice them in Thai.
- Never lecture. 2–4 sentences, then stop.

Your goal: after every swing, {{PLAYER_NAME}} feels seen, knows the ONE thing to change, and has a cue to hold on the very next ball.`;

// ---------------------------------------------------------------------------
// Coach VOICE TONE + COACH MODE (v1.6) — two independent axes chosen on Home.
//   Axis 1 (voiceTone) → Gemini Live prebuilt voiceName + Thai persona particles
//   Axis 2 (coachMode) → a system-prompt PERSONA layer (overall personality)
// Both are injected via the {{VOICE_AND_MODE}} placeholder. IMPORTANT: this
// persona layer is ADDITIVE — it sets tone-of-voice, gender/particles, and
// overall attitude, but the per-shot 30-voice style directive (see
// COACHING_STYLES / selectCoachingStyle) still OWNS the reply STRUCTURE
// (whether to give a fix, opener flavor, praise/fix order) and the FIXED 2–4
// sentence length band is unchanged by either axis.
// ---------------------------------------------------------------------------

/**
 * voiceTone → Gemini Live prebuilt voiceName. Applied to speechConfig on BOTH
 * transports (SDK config.speechConfig / relay setup.generationConfig.speechConfig).
 * This RE-INTRODUCES a voice pin (removed in v1.3.1) — intended for this feature.
 */
export const VOICE_NAMES: Record<VoiceTone, string> = {
  gentleF: 'Aoede',
  firmF: 'Kore',
  firmM: 'Charon',
  friendlyM: 'Puck',
};

/** Per-voiceTone spoken-Thai persona directive (gender + particles + warmth). */
const VOICE_PERSONA: Record<VoiceTone, string> = {
  gentleF:
    'You are a WARM, GENTLE FEMALE coach. In Thai always use female particles — ค่ะ and นะคะ (softer นะ is fine) — NEVER ครับ. Your voice is kind, reassuring, and encouraging.',
  firmF:
    'You are a CONFIDENT, CRISP FEMALE coach. In Thai use female particles — ค่ะ and a brisk นะ — NEVER ครับ. Your voice is assured and to-the-point, still supportive but not soft.',
  firmM:
    'You are a DEEP-VOICED, SERIOUS MALE coach. In Thai always use male particles — ครับ and a firm นะ — NEVER ค่ะ/นะคะ. Your voice is grounded, calm, and commanding, like a seasoned head coach.',
  friendlyM:
    'You are a FUN, UPBEAT MALE coach who talks like a buddy. In Thai use male particles — ครับ — and friendly address like เพื่อน/นะเพื่อน where it feels natural; NEVER ค่ะ/นะคะ. Your voice is casual, high-energy, and playful.',
};

/** Per-coachMode overall-personality directive layered over the per-shot style. */
const MODE_PERSONA: Record<CoachMode, string> = {
  encourage:
    'COACH MODE — ENCOURAGING: your overall personality is praise-first and supportive. Lead with what went well, keep any correction gentle and small, and always close on an upbeat, believing-in-them note.',
  hardcore:
    'COACH MODE — HARDCORE (drill-sergeant): your overall personality is blunt, demanding, and intense — push technique and effort hard, cut the fluff, and when you give the fix, state it as a firm COMMAND and repeat it once so it lands. ' +
    'GUARDRAIL — NON-NEGOTIABLE: this is tough SPORTS coaching ONLY. You push the technique and the effort, NEVER the person. NEVER demean, insult, mock, shame, or attack the student personally. No cruelty, no name-calling, no putdowns. Stay motivating and on-their-side — a demanding coach who clearly wants them to win, not an abuser.',
  polite:
    'COACH MODE — POLITE / TECHNICAL: your overall personality is formal, measured, and precise. Speak respectfully and calmly, and you may cite the exact joint angle in degrees as supporting detail (still keep the everyday cue as the main instruction — the degree is a footnote).',
  buddy:
    'COACH MODE — BUDDY / HYPE: your overall personality is casual, fun, and pumped, like a hyped-up friend on the sideline. High energy, playful, lots of momentum — keep it loose and exciting.',
};

/**
 * Build the PERSONA & COACHING MODE block injected at {{VOICE_AND_MODE}}. Pure
 * and exported for unit tests. Names the precedence so the global mode/tone and
 * the per-shot style directive never fight: mode/tone own the VOICE, the
 * per-shot directive owns the STRUCTURE and length band.
 */
export function buildPersonaBlock(voiceTone: VoiceTone, coachMode: CoachMode): string {
  return (
    'PERSONA & COACHING MODE (this is your fixed personality for the whole session):\n' +
    `- VOICE: ${VOICE_PERSONA[voiceTone]}\n` +
    `- ${MODE_PERSONA[coachMode]}\n` +
    '- HOW THIS COMBINES with the per-shot style: your voice tone, gender/particles, and this overall personality are constant for every shot. The "COACHING STYLE for this shot" directive you receive per swing sets the STRUCTURE of that one reply (whether to give a fix, the opener flavor, praise-vs-fix order) — deliver that structure THROUGH this personality. Neither this block nor your mode ever changes the FIXED 2–4 short-sentence (~4–9s) length, and never skips the shot-name opener.'
  );
}

/**
 * Build the coach systemInstruction with the player's name, voice tone, and
 * coach mode substituted in. Defaults (gentleF / encourage) reproduce the
 * pre-v1.6 warm-female-encouraging persona so callers/tests that pass only a
 * name are unaffected. When the name is empty the {{PLAYER_NAME}} placeholders
 * collapse cleanly so the coach simply coaches without a name.
 */
export function buildCoachSystemPrompt(
  playerName: string,
  voiceTone: VoiceTone = 'gentleF',
  coachMode: CoachMode = 'encourage',
): string {
  const name = playerName.trim();
  return COACH_SYSTEM_PROMPT.replace(/\{\{PLAYER_NAME\}\}/g, name).replace(
    '{{VOICE_AND_MODE}}',
    buildPersonaBlock(voiceTone, coachMode),
  );
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
  // Half-cascade voices (Vertex relay) read Arabic digits in ENGLISH ("ไฟว์");
  // native audio reads them as Thai fine. Spell the shot number out in Thai
  // words on the relay path so the opener is always voiced correctly.
  const n =
    lang === 'th' && isRelayTransport() ? thaiNumberWords(index) : String(index);
  return translate(key, lang).replace('{n}', n);
}

/**
 * Spell 0–999 as spoken Thai words ("15" → "สิบห้า", "21" → "ยี่สิบเอ็ด").
 * Out-of-range/non-finite input falls back to the digit string.
 */
export function thaiNumberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) return String(n);
  const D = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  if (n < 10) return D[n];
  let out = '';
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const ones = n % 10;
  if (hundreds > 0) out += D[hundreds] + 'ร้อย';
  if (tens > 0) out += tens === 1 ? 'สิบ' : tens === 2 ? 'ยี่สิบ' : D[tens] + 'สิบ';
  // Final "1" is เอ็ด whenever anything precedes it (สิบเอ็ด, ร้อยเอ็ด).
  if (ones > 0) out += ones === 1 && (tens > 0 || hundreds > 0) ? 'เอ็ด' : D[ones];
  return out;
}

// ---------------------------------------------------------------------------
// Coaching STYLE selector (v0.9 → v1.0 variety v2) — pure, testable
//
// v0.9 feedback from the court: "pattern มันซ้ำเยอะไปหน่อย" — 8 voices (2 per
// band) still felt repetitive once the pacing queue (v0.7) starts dropping
// intermediate shots, because the OLD selector was pure on (score, index) only
// — two HEARD critiques several shots apart could still land on the very same
// variant if the score band matched. v1.0 fixed both the VARIETY and the
// REPEAT problems; v3 (this revision) widens the palette further because a
// 1-hour session generates ~150–200 critiques concentrated 60–70% in ONE score
// band, so even 3–4 variants/band repeated ~30×/hour and felt canned past
// ~10–12 hearings:
//   • Each band now holds 7–8 genuinely different variants (≥30 total voices),
//     including a PRAISE-ONLY variant in praise-refine (good shots sometimes
//     get pure praise, no fix at all) and explicit try-again ("ลองดูอีกที")
//     framing in every encourage variant.
//   • selectCoachingStyle(score, index, recentIds) takes an optional list of
//     recently-SPOKEN style ids and skips any of them, rotating from `index` —
//     this is what actually guarantees two consecutive HEARD critiques never
//     share a style even when the queue eats shots in between. Calling it with
//     no `recentIds` (the default) reproduces the old pure index-rotation
//     behavior, so existing (score, index)-only call sites are unaffected.
//   • The STATE (which ids were recently spoken) lives on CoachLiveClient, not
//     here — this function itself stays pure and deterministic, so it is
//     trivially unit-testable and the pacing queue / freshest-wins path is
//     untouched. See CoachLiveClient.pickCoachingStyle + recentStyleIds.
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
 * The full style palette, grouped by band. v3 widens each band to 7–8
 * genuinely different tonal variants (different opener flavor, energy,
 * FRAMING (question form, compare-to-previous-shot, body-part spotlight,
 * rhythm/footwork lens, calm-analyst, playful-tease) AND structure — not
 * paraphrases of each other) → ≥30 distinct voices total, comfortably above
 * the 5-entry no-repeat window (see recentStyleIds) so no band can starve.
 * Every directive ends with the shared LENGTH_CLAUSE pinning spoken length to
 * the 2–4-sentence / ~4–9s band from COACH_SYSTEM_PROMPT — variety comes from
 * structure/framing, never from stretching or compressing outside that band.
 * Directives deliberately avoid the Thai stroke words (โฟร์แฮนด์/แบ็คแฮนด์) and
 * English phase words (backswing/contact/…) so injecting them into a prompt
 * never collides with frame/opener text.
 */
/** Shared clause appended to every directive so length variety comes from
 * structure, not from stretching/compressing outside the mandated band —
 * see COACH_SYSTEM_PROMPT's length mandate, which this echoes per-shot. */
const LENGTH_CLAUSE = 'Keep the whole reply inside 2 to 4 short sentences (~4–9 seconds spoken) — never a one-liner grunt, never a lecture.';

export const COACHING_STYLES: Record<CoachingStyleBand, CoachingStyle[]> = {
  hype: [
    {
      id: 'hype-a',
      band: 'hype',
      label: 'เชียร์สุดใจ',
      directive:
        'COACHING STYLE for this shot — FULL HYPE (เชียร์สุดใจ): this was a great swing, so go pure celebration. ' +
        'Open BIG with an excited interjection (โอ้โห!/สุดยอด!/มาแล้ว!), pile on genuine SPECIFIC praise plus a little playful อวย, ' +
        'and do NOT give any correction at all — tell them to keep doing EXACTLY this. Close on a high-energy "keep it coming" note. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'hype-b',
      band: 'hype',
      label: 'ชมแบบภูมิใจ',
      directive:
        'COACHING STYLE for this shot — PROUD MENTOR (ชมแบบภูมิใจ): another top-class swing. Keep it high praise but calmer and proud ' +
        '(นี่แหละ!/เพอร์เฟกต์/คลาสสิกเลย). Name the one standout thing that made it so good, give NO correction whatsoever, ' +
        'and lock it in with a short "that is your shot now" note. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'hype-c',
      band: 'hype',
      label: 'อวยสั้นกวนๆ',
      directive:
        'COACHING STYLE for this shot — PLAYFUL TEASE (อวยสั้นกวนๆ): a great swing, so celebrate it light — a small laugh/tease in your ' +
        'voice, almost like ribbing a friend who nailed it (เอ้า!/ไหงเก่งอย่างนี้/ทำได้ไงเนี่ย). Do NOT give any correction; lean toward the ' +
        'brief end of the length band. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'hype-d',
      band: 'hype',
      label: 'ถามให้รู้สึกเอง',
      directive:
        'COACHING STYLE for this shot — QUESTION FORM (ถามให้รู้สึกเอง): a great swing. Instead of just telling them, ask a warm rhetorical ' +
        'question about what they must have felt ("รู้สึกไหมว่าลูกมันพุ่งไปเลยเนี่ย" / "did you feel how that one just took off?"), then confirm it was ' +
        'exactly right. Do NOT give any correction — the question IS the celebration. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'hype-e',
      band: 'hype',
      label: 'เทียบกับช็อตก่อน',
      directive:
        'COACHING STYLE for this shot — COMPARE TO PREVIOUS SHOT (เทียบกับช็อตก่อน): a great swing. Frame the praise as visible improvement — ' +
        '"ดีกว่าช็อตที่แล้วอีกนะ" / "even better than your last one" — so they feel the progress, not just the moment. Do NOT give any correction. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'hype-f',
      band: 'hype',
      label: 'สปอตไลต์จุดเดียว',
      directive:
        'COACHING STYLE for this shot — BODY-PART SPOTLIGHT (สปอตไลต์จุดเดียว): a great swing. Zoom in like a camera on ONE specific body part that ' +
        'nailed it (the shoulder turn, the knee load, the wrist snap) and celebrate just that detail vividly — do not try to cover the whole swing. ' +
        'Do NOT give any correction. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'hype-g',
      band: 'hype',
      label: 'นิ่งแบบนักวิเคราะห์',
      directive:
        'COACHING STYLE for this shot — CALM ANALYST (นิ่งแบบนักวิเคราะห์): a great swing. Stay low-key and matter-of-fact rather than loud — state ' +
        'plainly and confidently that this was clean, like reading a good result off a scoreboard (ตรงนี้ใช้ได้เลย/แบบนี้แหละที่ต้องการ). Still warm, ' +
        'just understated. Do NOT give any correction. ' +
        LENGTH_CLAUSE,
    },
  ],
  'praise-refine': [
    {
      id: 'refine-a',
      band: 'praise-refine',
      label: 'ชมแล้วแนะ',
      directive:
        'COACHING STYLE for this shot — PRAISE THEN POLISH (ชมแล้วแนะ): a solid, good swing. Lead with warm specific praise for what worked, ' +
        'then offer ONE small refinement framed as "even better if…" (a polish, not a rescue). Vary your opener (เยี่ยม!/ดีมากเลย/ใกล้แล้ว). End with a light note to hold onto. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'refine-b',
      band: 'praise-refine',
      label: 'อีกนิดเดียว',
      directive:
        'COACHING STYLE for this shot — NEARLY THERE (อีกนิดเดียว): a good swing that is close to great. Celebrate what was good, ' +
        'then point to the ONE detail sitting between good and great, with an upbeat "one tweak" framing. Fresh opener (แจ่ม!/เข้าที่แล้ว/ดีขึ้นเยอะ). One memorable note. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'refine-c',
      band: 'praise-refine',
      label: 'แค่ชมก็พอ',
      directive:
        'COACHING STYLE for this shot — PRAISE-ONLY (แค่ชมก็พอ): a genuinely good swing. This time give ONLY praise — do NOT give any correction ' +
        'or refinement at all, even a small one. Pure specific praise IS the complete coaching moment for this shot; do not manufacture a fix. ' +
        'Warm, satisfied opener (ดีมาก/ใช่เลย/สวยงาม). Close by simply telling them to keep that going. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'refine-d',
      band: 'praise-refine',
      label: 'ชมนิ่งๆแล้วแนะ',
      directive:
        'COACHING STYLE for this shot — QUIET CONFIDENCE (ชมนิ่งๆแล้วแนะ): a good, steady swing. Keep it calm and understated rather than loud — ' +
        'a quiet, confident opener (ดี/โอเค ดีขึ้น/เริ่มนิ่งแล้ว), one brief specific praise, then ONE small refinement stated plainly, no extra flourish. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'refine-e',
      band: 'praise-refine',
      label: 'ถามให้รู้สึกเอง',
      directive:
        'COACHING STYLE for this shot — QUESTION FORM (ถามให้รู้สึกเอง): a good swing. Open with a warm question about what they noticed ' +
        '("รู้สึกไหมว่าตอนกระทบลูกมันมั่นขึ้น" / "did you feel that contact was steadier?"), confirm it was real, then offer ONE small refinement. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'refine-f',
      band: 'praise-refine',
      label: 'เทียบกับช็อตก่อน',
      directive:
        'COACHING STYLE for this shot — COMPARE TO PREVIOUS SHOT (เทียบกับช็อตก่อน): a good swing. Frame the praise against earlier swings this ' +
        'session ("ดีกว่าเมื่อกี้เยอะเลย" / "much better than a few shots ago"), then give ONE small refinement to keep the improvement going. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'refine-g',
      band: 'praise-refine',
      label: 'สปอตไลต์จุดเดียว',
      directive:
        'COACHING STYLE for this shot — BODY-PART SPOTLIGHT (สปอตไลต์จุดเดียว): a good swing. Praise ONE specific body part that worked well, then ' +
        'name a DIFFERENT single body part as the one small refinement — keep the whole reply anchored on those two concrete spots, nothing generic. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'refine-h',
      band: 'praise-refine',
      label: 'จับจังหวะเท้า',
      directive:
        'COACHING STYLE for this shot — RHYTHM & FOOTWORK LENS (จับจังหวะเท้า): a good swing. Praise the tempo or footwork rather than a joint angle ' +
        '(the split step, the timing into the ball), then offer ONE refinement framed the same way — through rhythm/timing, not raw degrees. ' +
        LENGTH_CLAUSE,
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
        'Grounded, steady opener (โอเค/เห็นละ/จับจุดได้แล้ว). Pin it with a sharp note. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'tech-b',
      band: 'technical',
      label: 'ค่อย ๆ ปรับ',
      directive:
        'COACHING STYLE for this shot — BUILD IT UP (ค่อย ๆ ปรับ): a mixed swing with room to grow. Praise the effort or the one moment that worked, ' +
        'then give ONE actionable correction tied to the moment it happens, framed as building the swing up step by step. ' +
        'Vary the opener (มาต่อกัน/ลองแบบนี้/ใกล้ขึ้นแล้ว). Clear note for the next ball. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'tech-c',
      band: 'technical',
      label: 'ตรงประเด็น',
      directive:
        'COACHING STYLE for this shot — STRAIGHT TALK (ตรงประเด็น): a mixed swing. Skip the long windup — one quick, honest acknowledgement, ' +
        'then go STRAIGHT to the ONE correction and exactly where it happens, brisk and direct like a coach who trusts the student to handle it plainly. ' +
        'Brisk opener (เอาล่ะ/มาดู/ตรงนี้เลย). ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'tech-d',
      band: 'technical',
      label: 'ถามให้รู้สึกเอง',
      directive:
        'COACHING STYLE for this shot — QUESTION FORM (ถามให้รู้สึกเอง): a mixed swing. Ask a grounded question that leads them to notice the issue ' +
        'themselves ("รู้สึกไหมว่าแขนยังงออยู่ตอนกระทบลูก" / "did you feel your arm was still bent at contact?"), then confirm it and give the ONE fix. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'tech-e',
      band: 'technical',
      label: 'เทียบกับช็อตก่อน',
      directive:
        'COACHING STYLE for this shot — COMPARE TO PREVIOUS SHOT (เทียบกับช็อตก่อน): a mixed swing. Anchor the correction against an earlier swing ' +
        'this session ("ช็อตที่แล้วทำได้ดีกว่านี้นิดหน่อยนะ" / "your last one had this a bit more"), then give the ONE fix to get back there. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'tech-f',
      band: 'technical',
      label: 'สปอตไลต์จุดเดียว',
      directive:
        'COACHING STYLE for this shot — BODY-PART SPOTLIGHT (สปอตไลต์จุดเดียว): a mixed swing. Zoom the entire critique onto ONE body part — name it, ' +
        'say what it did, say exactly what to change about it — rather than surveying the whole swing. One part, one fix, done. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'tech-g',
      band: 'technical',
      label: 'จับจังหวะเท้า',
      directive:
        'COACHING STYLE for this shot — RHYTHM & FOOTWORK LENS (จับจังหวะเท้า): a mixed swing. Frame the ONE correction through tempo, timing, or ' +
        'footwork rather than a joint angle — "ก้าวเข้าไปหาลูกให้เร็วขึ้นอีกนิด" / "step into the ball a beat sooner" — even if the underlying issue ' +
        'is a joint angle, translate it into a rhythm cue. ' +
        LENGTH_CLAUSE,
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
        'Gentle opener (ไม่เป็นไรนะ/สู้ ๆ/ค่อย ๆ ไป). Always close on an inviting try-again note — something like "ลองดูอีกทีนะ" — end upbeat and hopeful. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'warm-b',
      band: 'encourage',
      label: 'ตั้งหลักใหม่',
      directive:
        'COACHING STYLE for this shot — GENTLE RESET (ตั้งหลักใหม่): a hard swing. Stay kind and steady — normalize the miss, find one small honest positive, ' +
        'then offer the ONE easiest adjustment in the simplest everyday words. Fresh warm opener (ไม่เป็นไร/ลองใหม่/เดี๋ยวก็ได้). ' +
        'Close with an explicit invite to go again — "ลองใหม่อีกทีนะ" — showing you believe in them. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'warm-c',
      band: 'encourage',
      label: 'ปลอบก่อนเลย',
      directive:
        'COACHING STYLE for this shot — COMFORT FIRST (ปลอบก่อนเลย): a tough swing. Lead ENTIRELY with comfort and reassurance — this one is not about ' +
        'technique at all, delay any correction, just normalize the miss warmly (ไม่เป็นไรเลยนะ/เรื่องปกติมาก/ใครๆก็เป็น). ' +
        'End with a soft, comforting "ลองดูอีกทีนะ" — try-again energy, nothing technical. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'warm-d',
      band: 'encourage',
      label: 'สั้นแต่อุ่นใจ',
      directive:
        'COACHING STYLE for this shot — LIGHT & SHORT (สั้นแต่อุ่นใจ): a tough swing. Lean toward the brief end of the length band — just warmth and ' +
        'encouragement, almost no technique at all. Light opener (ไม่เป็นไร/เอาใหม่). Must end with an inviting "ลองใหม่อีกทีนะ" — warm and brief. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'warm-e',
      band: 'encourage',
      label: 'ถามให้รู้สึกเอง',
      directive:
        'COACHING STYLE for this shot — QUESTION FORM (ถามให้รู้สึกเอง): a tough swing. Ask a gentle, non-judgmental question about what happened ' +
        '("รู้สึกไหมว่าลูกมันไปเร็วเกินไปนิดหนึ่ง" / "did that one feel like it got away from you a bit?") to invite reflection without any pressure, ' +
        'reassure it is normal, then close with "ลองดูอีกทีนะ" — inviting try-again energy. ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'warm-f',
      band: 'encourage',
      label: 'เทียบกับช็อตก่อน',
      directive:
        'COACHING STYLE for this shot — COMPARE TO PREVIOUS SHOT (เทียบกับช็อตก่อน): a tough swing. Use an earlier good swing this session as comfort ' +
        '("ไม่เป็นไรเลย ช็อตที่แล้วยังทำได้ดีอยู่" / "no worries, your earlier shot was solid") so this one reads as a blip, not a pattern, then close ' +
        'with "ลองใหม่อีกทีนะ". ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'warm-g',
      band: 'encourage',
      label: 'สปอตไลต์จุดเดียว',
      directive:
        'COACHING STYLE for this shot — BODY-PART SPOTLIGHT (สปอตไลต์จุดเดียว): a tough swing. Gently point to just ONE body part to relax or trust ' +
        'more next time — not a list, one soft focal point — wrapped in warmth, never clinical, then close with "ลองดูอีกทีนะ". ' +
        LENGTH_CLAUSE,
    },
    {
      id: 'warm-h',
      band: 'encourage',
      label: 'นิ่งแบบนักวิเคราะห์',
      directive:
        'COACHING STYLE for this shot — CALM ANALYST COMFORT (นิ่งแบบนักวิเคราะห์): a tough swing. Stay matter-of-fact and reassuring rather than ' +
        'emotional — "เรื่องปกติมาก ทุกคนเป็นกัน" / "totally normal, everyone hits one of these" — calm, not dramatic, then close with an inviting ' +
        '"ลองใหม่อีกทีนะ". ' +
        LENGTH_CLAUSE,
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
 * Pick the coaching style for a shot from its score band, rotated by shot
 * `index`, skipping any id already present in `recentIds` (the last few
 * SPOKEN style ids — see CoachLiveClient.recentStyleIds). Pure and
 * deterministic for a given (score, index, recentIds) triple.
 *
 * With the default `recentIds = []` this reduces exactly to the old pure
 * index-rotation behavior (first candidate at offset 0 is never "recent"), so
 * existing (score, index)-only callers are unaffected. When recentIds is
 * non-empty, the search walks the band's variants starting at `index` and
 * returns the first one NOT in recentIds — this is what guarantees two
 * consecutive HEARD critiques never share a style even if the pacing queue
 * (v0.7) drops shots in between, since the caller (CoachLiveClient) threads
 * its own recently-spoken ids through every call.
 */
export function selectCoachingStyle(
  score: number,
  index: number,
  recentIds: string[] = [],
): CoachingStyle {
  const band = scoreBand(score);
  const variants = COACHING_STYLES[band];
  // Guard against negative/NaN indices so the modulo never picks out of range.
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  for (let offset = 0; offset < variants.length; offset += 1) {
    const candidate = variants[(i + offset) % variants.length];
    if (!recentIds.includes(candidate.id)) return candidate;
  }
  // Every variant in this band is inside the recency window (a small band —
  // e.g. exactly 5 variants — can saturate a 5-entry window at a constant
  // index; in practice every band holds ≥7). We can no longer avoid ALL recent ids, but we MUST still avoid
  // repeating the id spoken immediately before this one, or a constant-index
  // caller would lock into "return the same id forever" once saturated.
  const lastId = recentIds[recentIds.length - 1];
  for (let offset = 0; offset < variants.length; offset += 1) {
    const candidate = variants[(i + offset) % variants.length];
    if (candidate.id !== lastId) return candidate;
  }
  // Band has exactly one variant — nothing else to return.
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
  // v1.0: callers that track recently-SPOKEN style ids (CoachLiveClient) pass
  // their own pre-picked style here so the stateful no-repeat guarantee flows
  // through; pure callers (tests, no state) fall back to the plain
  // (score, index) selection with no recency window.
  style: CoachingStyle = selectCoachingStyle(shot.score, shot.index),
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

  lines.push(
    `Peak wrist speed: ${shot.peakWristSpeed.toFixed(2)} (normalized units/s).`,
    // v1.4: hand-speed estimate in real units (≈, camera-calibrated). Give the
    // coach the number so it can celebrate/compare it out loud, spoken as Thai
    // number words on the relay voice. Omitted entirely when calibration
    // failed — never invent a speed.
    ...(shot.speedKmh !== undefined
      ? [
          `Estimated hand speed: ≈${shot.speedKmh} km/h. You MAY mention it when it strengthens the coaching (a fast one, a new-feeling number, a clear jump vs earlier shots) — say it naturally${
            lang === 'th' ? ' (in Thai: "ประมาณ X กิโลเมตรต่อชั่วโมง")' : ''
          }; do not recite it on every shot.`,
        ]
      : []),
    `Local score: ${r(shot.score)}/100.`,
    `Detected issues: ${issues}.`,
    lang === 'th' ? 'Reply in Thai.' : 'Reply in English.',
    // v0.7: every critique must OPEN by naming the shot out loud so the student
    // always knows which swing you are talking about (spoken fast, back to back).
    // v0.9: the shape after the opener is now set by the coaching-style directive
    // below (hype skips the fix entirely), so this line defers to it instead of
    // hard-coding praise→fix→cue.
    `OPEN your spoken reply by naming this shot first — start with "${shotOpener(shot.index, shot.type, lang)}"` +
      ` (say it naturally, a soft particle like นะคะ/นะ is fine), then follow the coaching-style directive below.`,
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
  /** setup ack from the server relay / Vertex — mirrored through, harmless. */
  setupComplete?: unknown;
}

// ---------------------------------------------------------------------------
// Transport abstraction: the tiny slice of the SDK `Session` the client uses.
//
// Both transports resolve to a CoachSession. The AI-Studio path uses the real
// SDK Session (which structurally satisfies this); the relay path uses
// RelayLiveSession below. Everything downstream (turn/pacing/cost/audio) is
// transport-agnostic and untouched.
// ---------------------------------------------------------------------------

export interface CoachSession {
  sendClientContent(params: { turns?: unknown; turnComplete?: boolean }): void;
  sendRealtimeInput(params: { video?: { data: string; mimeType: string } }): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Gemini Live WS frame builders (server-relay transport)
//
// These emit the EXACT BidiGenerateContent JSON the @google/genai v2 SDK
// serializes for Vertex (extracted byte-for-byte from the installed SDK — see
// tContent / contentToVertex / tImageBlob / tLiveClientContent /
// liveSendRealtimeInputParametersToVertex). The relay server pipes these
// frames straight to the real Vertex Live socket, so their shape must match
// what the SDK would have sent. Pure + exported so they are unit-testable in
// isolation from any socket.
// ---------------------------------------------------------------------------

/** Normalize a `turns` union to Vertex Content[] exactly like the SDK's tContents. */
function normalizeTurns(turns: unknown): unknown[] {
  if (turns === null || turns === undefined) return [];
  if (typeof turns === 'string') {
    // tContent(string) → { role: 'user', parts: [{ text }] }
    return [{ role: 'user', parts: [{ text: turns }] }];
  }
  if (Array.isArray(turns)) {
    return turns.map((t) =>
      typeof t === 'string' ? { role: 'user', parts: [{ text: t }] } : t,
    );
  }
  // Already a single Content-like object.
  return [turns];
}

/**
 * The setup frame. `model` is ADVISORY: the browser sends the bare id it was
 * built with, but the relay SERVER is expected to OVERRIDE `setup.model` with
 * the full Vertex global resource path (the browser can't hold the project id).
 * systemInstruction carries the coach persona + player name (browser-side, the
 * server does NOT rebuild it), shaped exactly as contentToVertex(tContent(str)).
 */
export function buildRelaySetupFrame(
  model: string,
  systemInstruction: string,
  // v1.6: the coach VOICE-TONE pin. When a voiceName is given it is nested into
  // generationConfig.speechConfig (the Vertex/Bidi setup shape). Omitted
  // (undefined) → NO speechConfig, byte-identical to the pre-v1.6 relay frame
  // (v1.3.1 pinned nothing). v1.6 always passes one; the no-arg branch survives
  // only for the pre-v1.6 default-voice contract / older callers.
  voiceName?: string,
): {
  setup: Record<string, unknown>;
} {
  const generationConfig: Record<string, unknown> = { responseModalities: ['AUDIO'] };
  if (voiceName) {
    generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    };
  }
  return {
    setup: {
      model,
      generationConfig,
      systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] },
      outputAudioTranscription: {},
    },
  };
}

/** `{ clientContent: { turns: Content[], turnComplete } }` — mirrors sendClientContent. */
export function serializeClientContent(params: {
  turns?: unknown;
  turnComplete?: boolean;
}): { clientContent: Record<string, unknown> } {
  if (params.turns !== null && params.turns !== undefined) {
    return {
      clientContent: {
        turns: normalizeTurns(params.turns),
        turnComplete: params.turnComplete,
      },
    };
  }
  return { clientContent: { turnComplete: params.turnComplete } };
}

/** `{ realtimeInput: { video: { data, mimeType } } }` — mirrors sendRealtimeInput({video}). */
export function serializeRealtimeInput(params: {
  video?: { data: string; mimeType: string };
}): { realtimeInput: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  if (params.video) {
    out.video = { mimeType: params.video.mimeType, data: params.video.data };
  }
  return { realtimeInput: out };
}

/** Callbacks the RelayLiveSession drives — same names/shape as the SDK's. */
interface RelayCallbacks {
  onopen: () => void;
  onmessage: (msg: unknown) => void;
  onerror: (e: unknown) => void;
  onclose: (e: unknown) => void;
}

/**
 * A CoachSession backed by a same-origin WebSocket to our relay server. It
 * speaks the Gemini Live JSON protocol directly: sends the setup frame on open
 * (correct for a RAW socket — the SDK's "never send in onopen" rule is about
 * the SDK Session object, not a raw WS), then serializes each client call to a
 * frame and dispatches every parsed server frame into the existing
 * handleMessage path. Server→browser frames are assumed to be JSON TEXT
 * (base64 audio lives inside inlineData.data), matching the SDK message shape.
 */
class RelayLiveSession implements CoachSession {
  private ws: WebSocket;
  /**
   * True once the server's `setupComplete` has been seen. Vertex only processes
   * a turn AFTER setup is acked, and over the relay the browser↔relay socket
   * opens BEFORE the relay↔Vertex socket does — so the SDK's "send right after
   * open" pattern isn't safe here. We hold the first outbound client frames
   * until setupComplete, then flush them in order (the spike scripts inserted a
   * 300–400ms delay for exactly this reason). REQUIRES the relay server to pipe
   * the setupComplete frame back to the browser (documented cross-agent contract).
   */
  private setupAcked = false;
  private pendingFrames: unknown[] = [];

  constructor(url: string, setupFrame: unknown, cb: RelayCallbacks) {
    this.ws = new WebSocket(url);
    // Belt-and-braces vs the relay's text re-framing: if a binary frame ever
    // arrives anyway, get an ArrayBuffer (decodable synchronously) — a Blob
    // would force an async read and drop the frame ordering guarantees.
    try {
      this.ws.binaryType = 'arraybuffer';
    } catch {
      /* jsdom/test sockets may not expose it */
    }
    this.ws.onopen = () => {
      try {
        this.ws.send(JSON.stringify(setupFrame));
      } catch (e) {
        cb.onerror(e);
        return;
      }
      cb.onopen();
    };
    this.ws.onmessage = (ev: MessageEvent) => {
      // Vertex frames are UTF-8 JSON whatever the WS framing says — the relay
      // re-frames to text, but decode binary defensively instead of dropping
      // (dropping setupComplete would silently kill the whole coach).
      let raw: string;
      if (typeof ev.data === 'string') {
        raw = ev.data;
      } else if (ev.data instanceof ArrayBuffer) {
        try {
          raw = new TextDecoder().decode(ev.data);
        } catch {
          return;
        }
      } else {
        return; // Blob (binaryType unsupported) — cannot decode synchronously
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        !this.setupAcked &&
        parsed !== null &&
        typeof parsed === 'object' &&
        'setupComplete' in parsed
      ) {
        this.setupAcked = true;
        this.flushPending();
      }
      cb.onmessage(parsed);
    };
    this.ws.onerror = (ev: unknown) => cb.onerror(ev);
    this.ws.onclose = (ev: unknown) => cb.onclose(ev);
  }

  /** Send the frames buffered before setupComplete, in order (open socket only). */
  private flushPending(): void {
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    if (this.ws.readyState !== WebSocket.OPEN) return;
    for (const frame of frames) this.ws.send(JSON.stringify(frame));
  }

  private sendFrame(frame: unknown): void {
    // Before setupComplete: buffer (do NOT throw — the shot isn't lost, it's
    // held until Vertex is ready). After: send immediately, but throw when the
    // socket has died so dispatchShot's try/catch releases attribution and
    // requeues the shot — same contract the SDK path relies on.
    if (!this.setupAcked) {
      this.pendingFrames.push(frame);
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('relay socket not open');
    }
    this.ws.send(JSON.stringify(frame));
  }

  sendClientContent(params: { turns?: unknown; turnComplete?: boolean }): void {
    this.sendFrame(serializeClientContent(params));
  }

  sendRealtimeInput(params: { video?: { data: string; mimeType: string } }): void {
    this.sendFrame(serializeRealtimeInput(params));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open a relay session. Resolves to the CoachSession once the WS is open and
 * the setup frame has been sent (mirrors the SDK connect() resolving after its
 * onopen); a close/error BEFORE open rejects so connect()'s catch drives the
 * existing reconnect/backoff. After open, close/error flow through the same
 * handleClose path as the SDK transport.
 */
function connectRelay(opts: {
  model: string;
  systemInstruction: string;
  voiceName?: string;
  callbacks: RelayCallbacks;
}): Promise<CoachSession> {
  return new Promise((resolve, reject) => {
    let opened = false;
    const setupFrame = buildRelaySetupFrame(opts.model, opts.systemInstruction, opts.voiceName);
    const session: CoachSession = new RelayLiveSession(relayUrl(), setupFrame, {
      onopen: () => {
        opened = true;
        resolve(session);
        opts.callbacks.onopen();
      },
      onmessage: opts.callbacks.onmessage,
      onerror: (e) => {
        if (!opened) reject(new Error(errMsg(e, 'relay error before open')));
        else opts.callbacks.onerror(e);
      },
      onclose: (e) => {
        if (!opened) reject(new Error(errMsg(e, 'relay closed before open')));
        else opts.callbacks.onclose(e);
      },
    });
  });
}

/**
 * A relay close whose reason marks a server-side PERMISSION denial (bad ADC,
 * SA not allowlisted for Live, project not permitted) is PERMANENT — retrying
 * the same creds can never succeed, so we must stop the backoff and surface a
 * distinct bilingual notice instead of looping "reconnecting…". Keyed on a
 * reason SUBSTRING (the relay server defines the exact string — documented in
 * the handoff) so it can never false-positive on a transient AQ-path close
 * (e.g. token expiry) that IS worth retrying.
 */
function isPermissionDeniedClose(err: unknown): boolean {
  // Relay-only concept: on the AI-Studio path a "forbidden"-looking close is
  // recoverable by refetching a fresh token, so it must keep reconnecting.
  if (!isRelayTransport()) return false;
  if (!err || typeof err !== 'object') return false;
  const reason = (err as { reason?: unknown }).reason;
  if (typeof reason !== 'string' || !reason) return false;
  // vertex_credentials_unavailable (relay close 4002) is equally permanent —
  // retrying without ADC/role fixes on the server is futile; surface the
  // bilingual notice immediately instead of burning the backoff budget.
  return /permission[\s_-]?denied|permission denied|forbidden|not allowlisted|vertex_credentials_unavailable/i.test(
    reason,
  );
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CoachLiveClient {
  private session: CoachSession | null = null;
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
   * FIFO queue of ALL completed shots waiting for the pacing gate to open
   * (v1.2, replacing v0.7's single-slot freshest-wins). A shot may only be
   * dispatched when NO coaching turn is in flight AND the coach's audio has
   * fully FINISHED SPEAKING the previous critique — otherwise critiques rattle
   * out too fast to follow. Unlike v0.7, NOTHING is dropped while blocked: every
   * completed shot is coached, in index order, one at a time as the gate reopens
   * (on-court request "ให้โค้ชทุกๆครั้ง … เหมือนสมัยก่อน"). The pacing gate is
   * unchanged — only the "which shot next" policy changed from freshest-wins to
   * strict FIFO.
   */
  private queue: Shot[] = [];
  /**
   * Soft memory cap: never let the queue grow without bound if the coach falls
   * pathologically far behind (e.g. a long dead-socket stall). At the cap the
   * OLDEST waiting shot is dropped so the freshest advice still lands; under
   * normal play the queue drains long before this. Diagnostics only.
   */
  private droppedForCap = 0;

  /**
   * v1.0 variety fix, window widened 3→5 in v3 (each band now holds 7–8
   * variants, so a 5-entry window still can't starve a band): the last few
   * coaching style ids actually SPOKEN (oldest first, capped at 5), threaded
   * into selectCoachingStyle so two consecutive HEARD critiques never share a
   * style — even when the pacing queue (v0.7) drops an intermediate shot and
   * the same score band comes up again a few shots later. Reset on
   * disconnect() (a fresh session starts with no recency memory).
   */
  private recentStyleIds: string[] = [];
  /**
   * Style id picked for the turn currently in flight; committed to
   * recentStyleIds by finalizeTurn ONLY on a clean turn (see pickCoachingStyle),
   * discarded on interrupt / dead socket / failed send.
   */
  private pendingStyleId: string | null = null;

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

  /**
   * Pick this shot's coaching style, threading the last few SPOKEN style ids
   * through selectCoachingStyle so the no-repeat guarantee holds even across
   * queue-dropped shots (see `recentStyleIds` docs). Records the choice so the
   * NEXT pick sees it. Keeps a short window (5) — long enough that the pacing
   * queue's freshest-wins drops can't resurface a just-heard style, short
   * enough that every band (≥7 variants) still has room to rotate.
   */
  private pickCoachingStyle(score: number, index: number): CoachingStyle {
    const style = selectCoachingStyle(score, index, this.recentStyleIds);
    // Record at HEARD time, not dispatch time: hold the pick in pendingStyleId
    // and let finalizeTurn commit it to the window on a clean turn. Otherwise a
    // run of failed sends (error-path requeues) evicts styles that were actually
    // spoken, allowing a heard-style repeat.
    this.pendingStyleId = style.id;
    return style;
  }

  /** Commit the in-flight turn's style id to the recent window (clean turns only). */
  private commitPendingStyle(): void {
    if (this.pendingStyleId) {
      this.recentStyleIds = [...this.recentStyleIds, this.pendingStyleId].slice(-5);
    }
    this.pendingStyleId = null;
  }

  isConnected(): boolean {
    return this.connected && this.session !== null;
  }

  /**
   * True while the coach is mid-critique: a turn is in flight, audio is still
   * playing, or coached shots are queued. LiveScreen wires this into the
   * detector's holdArm gate (speak-to-completion capture, v1.2) so a NEW swing
   * cannot arm until the previous critique is fully heard. Always false when
   * the coach is offline — captures must never be held in no-key mode.
   */
  isBusyCoaching(): boolean {
    if (!this.isConnected()) return false;
    return this.pendingShotId !== null || this.queue.length > 0 || audioPlayer.isSpeaking();
  }

  // -------------------------------------------------------------------------
  // Connect
  // -------------------------------------------------------------------------

  async connect(isReconnect = false): Promise<void> {
    // Already live, or a connect is already in flight → no-op. Guards against
    // React StrictMode's mount→cleanup→mount double-invoke leaking a session.
    if (!isReconnect && (this.connected || this.connecting)) return;

    // Transport select (SIT migration): 'relay' → same-origin server WS relay
    // (Vertex, server-side ADC — NO token ever reaches the browser); anything
    // else keeps the exact AI-Studio ephemeral-token (AQ.) behavior so
    // main-branch semantics survive a merge untouched.
    const useRelay = isRelayTransport();

    // Acquire a Live token — AI-Studio transport ONLY. Priority: token pasted
    // in Settings > backend token-minting endpoint (production, refetched every
    // connect so a court session never hits the ~30-min expiry) > build-time
    // env (local dev). The relay transport skips this entirely.
    let token = '';
    if (!useRelay) {
      token = this.store().authToken || '';
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
      // Ephemeral tokens minted with the OLD AIza keys are "AQ.…"; tokens
      // minted with Google's 2026 Auth keys come back as "auth_tokens/…".
      // Both connect fine (verified live) — accept either.
      if (!token.startsWith('AQ.') && !token.startsWith('auth_tokens/')) {
        // Store error slot takes an i18n KEY (UI translates); keep the internal
        // Error message plain for callers/console.
        this.store().setSessionError('error.tokenMissing.body');
        throw new Error('token missing');
      }
    }
    const model = useRelay
      ? envVar('VITE_GEMINI_LIVE_MODEL') || RELAY_DEFAULT_MODEL
      : import.meta.env.VITE_GEMINI_LIVE_MODEL || DEFAULT_MODEL;

    this.manualClose = false;
    this.connecting = true;
    // Capture the generation this connect belongs to (see `epoch` docs).
    const myEpoch = this.epoch;
    this.store().setConnection('connecting');

    // Coach persona + player name + v1.6 voice tone / coach mode — sent as
    // systemInstruction on BOTH transports (the relay server does NOT rebuild
    // it, so the browser owns it). The voiceTone ALSO pins the spoken voiceName
    // via speechConfig below.
    const { userName, voiceTone, coachMode } = this.store().settings;
    const systemInstruction = buildCoachSystemPrompt(userName, voiceTone, coachMode);
    const voiceName = VOICE_NAMES[voiceTone];
    // Shared callbacks — identical wiring for both transports; everything
    // downstream (turn/pacing/cost/audio) is transport-agnostic.
    const callbacks = {
      onopen: () => {
        // Session not ready to send here (SDK); liveness only.
      },
      onmessage: (msg: unknown) => this.handleMessage(msg as LiveServerMessage),
      onerror: (e: unknown) => this.handleClose('error', e),
      onclose: (e: unknown) => this.handleClose('disconnected', e),
    };

    try {
      // CRITICAL (SDK path): assign this.session from the AWAITED promise; never
      // send inside the SDK's onopen — the SDK session object is not ready
      // there. (The relay path sends its setup frame in the RAW WS onopen, which
      // IS correct for a raw socket — see RelayLiveSession.)
      const session: CoachSession = useRelay
        ? await connectRelay({ model, systemInstruction, voiceName, callbacks })
        : await new GoogleGenAI({
            apiKey: token,
            httpOptions: { apiVersion: 'v1beta' },
          }).live.connect({
            model,
            config: {
              responseModalities: [Modality.AUDIO],
              // v1.6: pin the spoken voice to the player's chosen tone. This
              // re-introduces a speechConfig pin (removed in v1.3.1) — intended,
              // so gentle/firm female + firm/friendly male are selectable.
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
              },
              outputAudioTranscription: {},
              // v0.6: no inputAudioTranscription — the mic is never opened, so
              // there is no user audio to transcribe.
              systemInstruction,
            },
            callbacks,
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
      // The accumulated coach-audio PCM for this turn is now a partial/cut
      // recording — drop it rather than persisting a half critique.
      coachAudioTap.discard();
    }

    // (a) Coach audio: PCM 24k chunks in modelTurn parts. ALWAYS tap every chunk
    // for persistence (coachAudioTap) regardless of the phone-speaker toggle —
    // we still want the spoken critique saved even if the student muted
    // playback. Only ENQUEUE to the speaker when coachVoiceOn.
    const parts = msg.serverContent?.modelTurn?.parts;
    if (parts) {
      const voiceOn = this.store().settings.coachVoiceOn;
      for (const part of parts) {
        const data = part.inlineData?.data;
        const mime = part.inlineData?.mimeType ?? '';
        if (data && mime.startsWith('audio/pcm')) {
          // Tap only while a shot's turn is in flight: a stray/unsolicited turn
          // must never prepend its audio to the NEXT shot's recording.
          if (this.pendingShotId) coachAudioTap.onChunk(data);
          if (voiceOn) audioPlayer.enqueue(data);
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

  // ---------------------------------------------------------------------------
  // TURN WATCHDOG (v1.3.1 — root cause of the on-court total freeze).
  // If the model NEVER answers a dispatched turn (half-dead session, dropped
  // reply), turnComplete never arrives → pendingShotId stays set forever →
  // flushQueue is gated shut AND (v1.2+) the capture holdArm gate stays closed:
  // no coaching, no new captures — the whole pipeline wedges silently. This
  // timer bounds every in-flight turn: on expiry the turn is declared dead,
  // attribution/cost are released, an un-spoken shot is requeued at the FRONT,
  // and the queue re-drains. Armed in dispatchShot, cleared on finalizeTurn /
  // close / disconnect.
  // ---------------------------------------------------------------------------
  private turnWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  private clearTurnWatchdog(): void {
    if (this.turnWatchdogTimer) {
      clearTimeout(this.turnWatchdogTimer);
      this.turnWatchdogTimer = null;
    }
  }

  private armTurnWatchdog(shotId: string): void {
    this.clearTurnWatchdog();
    const TURN_TIMEOUT_MS = 20_000;
    this.turnWatchdogTimer = setTimeout(() => {
      this.turnWatchdogTimer = null;
      if (this.pendingShotId !== shotId) return; // turn finished after all
      console.warn('[coach] turn watchdog: no reply in 20s — releasing wedged turn');
      const deadShot = this.store().shots.find((s) => s.id === shotId);
      this.store().endShotCost(shotId);
      this.pendingShotId = null;
      this.pendingContactCaptureId = null;
      this.pendingStyleId = null;
      coachAudioTap.discard();
      // Nothing was spoken → the shot still deserves its critique; retry it
      // ahead of everything queued behind it. If some text DID stream (model
      // answered but never sent turnComplete), treat it as spoken-enough and
      // move on rather than repeating a half-heard critique.
      if (this.turnText === '' && deadShot) this.requeueFront(deadShot);
      this.turnText = '';
      this.turnInterrupted = false;
      this.flushQueue();
    }, TURN_TIMEOUT_MS);
  }

  private finalizeTurn(): void {
    this.clearTurnWatchdog();
    const text = this.turnText;
    const lang = this.requestedLang;
    if (this.pendingShotId) {
      const shotId = this.pendingShotId;
      // Persist the accumulated coach-audio PCM for THIS shot before clearing
      // pendingShotId — but only for a clean turn; an interrupted/mixed turn's
      // audio is a partial recording and gets dropped, same rule as the text
      // critique below.
      if (!this.turnInterrupted) {
        coachAudioTap.finalizeForShot(shotId);
        // The critique was actually spoken to completion — its style now counts
        // toward the no-repeat window.
        this.commitPendingStyle();
      } else {
        coachAudioTap.discard();
        this.pendingStyleId = null;
      }
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
    } else {
      // Turn completed with no pending shot (idle chatter / stray turn) — there
      // is nothing to attribute the recorded audio to.
      coachAudioTap.discard();
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
    // v1.2: every completed shot is coached, in order. Always append to the FIFO
    // queue, then try to drain it. The pacing gate (connected + no turn in flight
    // + coach finished speaking) lives in flushQueue, so a gate-open idle client
    // dispatches this shot immediately (it's alone at the front) while a busy
    // client simply leaves it queued behind the shots already waiting — nothing
    // is dropped and order is preserved.
    this.enqueue(shot);
    this.flushQueue();
  }

  /**
   * Append `shot` to the FIFO queue. Idempotent per shot id: a shot already
   * queued OR currently in flight is ignored, so a stray double-send (or an
   * error-path requeue racing a fresh completion) can never enqueue the same
   * swing twice. A soft cap bounds memory if the coach falls pathologically far
   * behind — the OLDEST waiting shot is dropped so the freshest advice survives.
   */
  private enqueue(shot: Shot): void {
    if (shot.id === this.pendingShotId) return; // already being coached
    if (this.queue.some((s) => s.id === shot.id)) return; // already waiting
    this.queue.push(shot);
    const QUEUE_CAP = 30;
    if (this.queue.length > QUEUE_CAP) {
      const dropped = this.queue.shift();
      this.droppedForCap += 1;
      console.debug(
        `[coach] pacing: queue exceeded cap ${QUEUE_CAP} — dropped oldest shot #${dropped?.index} (droppedForCap=${this.droppedForCap})`,
      );
    }
  }

  private dispatchShot(shot: Shot): void {
    const session = this.session;
    if (!session) {
      // No socket — put it back at the FRONT so it stays ahead of anything that
      // queued behind it, preserving index order for the next (re)connect flush.
      this.requeueFront(shot);
      return;
    }
    // Duplicate-dispatch guard: never open a second turn for a shot already in
    // flight (a re-entrant flush or a racing requeue must not double-coach it).
    if (shot.id === this.pendingShotId) return;

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

    // TRANSPORT SPLIT for image delivery (SIT migration — empirically required):
    //   • RELAY / Vertex: the swing frames MUST ride INSIDE the clientContent turn
    //     as inlineData parts. Vertex half-cascade gemini-live-2.5-flash IGNORES
    //     images sent via sendRealtimeInput({video}) now that the mic is cut (v0.6)
    //     — realtimeInput is the streaming/VAD channel and, with no audio stream to
    //     anchor a frame to, the model literally never sees the swing (proven E2E
    //     through /api/live: it replies "NO IMAGE RECEIVED" and prompt tokens stay
    //     TEXT-only). Sent inline, the model reads every frame and Vertex bills the
    //     IMAGE-modality tokens (~93% of the prompt) that costMonitor folds into
    //     the VIDEO bucket.
    //   • AI-Studio (native-audio, main-branch): UNCHANGED — frames still go via
    //     sendRealtimeInput({video}) exactly as before, so a merge to main keeps
    //     its verified behavior. (If AI-Studio ever shows the same blindness it
    //     needs the same inline treatment — retest that path independently.)
    const useRelay = isRelayTransport();

    try {
      // Send every captured frame in phase order (if enabled). Fall back to the
      // legacy single contact-frame blob only when NOTHING was captured.
      let framesSent = 0;
      const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
      const addFrame = (data: string): void => {
        if (useRelay) {
          // Buffer for the inline clientContent turn (order preserved).
          imageParts.push({ inlineData: { mimeType: 'image/jpeg', data } });
        } else {
          session.sendRealtimeInput({ video: { data, mimeType: 'image/jpeg' } });
        }
        framesSent += 1;
      };
      if (state.settings.sendContactFrame) {
        if (ordered.length > 0) {
          for (const cap of ordered) {
            if (!cap.jpegBase64) continue;
            addFrame(cap.jpegBase64);
          }
          // Attach the coach's critique to the contact frame (falls back to the
          // first sent frame if this swing had no dedicated contact capture).
          this.pendingContactCaptureId = contactCapture?.id ?? ordered[0]?.id ?? null;
        } else if (shot.contactFrameJpegBase64) {
          addFrame(shot.contactFrameJpegBase64);
          // Legacy fallback has no capture id, so no critique is pinned to it.
        }
      }

      // The text prompt must enumerate EXACTLY the frames we actually sent, in
      // the same order — otherwise the coach's "Frame N = <phase>" mapping lies.
      // When images are disabled or none were sent, describe no frames.
      const promptCaptures = framesSent > 0 && ordered.length > 0 ? ordered : [];
      // v1.0: pick THIS shot's style with the stateful no-repeat window (see
      // pickCoachingStyle) instead of letting buildShotPrompt fall back to the
      // pure (score, index)-only default — this is what makes the no-repeat
      // guarantee survive queue-dropped shots.
      const style = this.pickCoachingStyle(shot.score, shot.index);
      let turns = buildShotPrompt(
        shot,
        this.requestedLang,
        state.settings.dominantHand,
        state.settings.focusShot,
        state.settings.userName,
        promptCaptures,
        style,
      );
      if (framesSent > 0) {
        turns +=
          '\nThe still frames of this swing are attached in the order listed above — read them as one motion and ground your correction in what you see.';
      }

      if (useRelay && imageParts.length > 0) {
        // Relay: images ride INSIDE the turn as inlineData parts (phase order),
        // text LAST so it lines up with the "Frame N = <phase>" mapping in `turns`.
        // This is the exact wire frame proven end-to-end through /api/live (model
        // reads the swing; IMAGE tokens billed). normalizeTurns passes this Content
        // object through unchanged → { clientContent: { turns: [Content], … } }.
        session.sendClientContent({
          turns: { role: 'user', parts: [...imageParts, { text: turns }] },
          turnComplete: true,
        });
      } else {
        session.sendClientContent({ turns, turnComplete: true });
      }
      // Bound this turn: if the model never replies, the watchdog un-wedges
      // the pipeline (see armTurnWatchdog).
      this.armTurnWatchdog(shot.id);
    } catch (e) {
      // Sending failed (socket died between checks) — release attribution and
      // requeue so the next (re)connect can retry the latest shot.
      state.endShotCost(shot.id);
      this.pendingShotId = null;
      this.pendingContactCaptureId = null;
      this.pendingStyleId = null; // pick was never spoken — don't count it
      // Send failed (socket died between checks) — put this shot back at the
      // FRONT of the FIFO so it is retried BEFORE any shot that queued behind
      // it, keeping strict index order across a reconnect. No drop.
      this.requeueFront(shot);
      console.warn('[coach] send failed:', errMsg(e, 'send failed'));
      this.store().setCoachError('coach.reconnecting');
    }
  }

  /**
   * Put a shot back at the FRONT of the FIFO (error-path / no-socket requeue),
   * ahead of anything that queued behind it, so retries never reorder the rally.
   * Deduped so a requeue can't create a second copy of a shot already waiting.
   */
  private requeueFront(shot: Shot): void {
    if (this.queue.some((s) => s.id === shot.id)) return;
    this.queue.unshift(shot);
  }

  private flushQueue(): void {
    if (this.queue.length === 0) return;
    // Pacing gate (unchanged): connected, no turn in flight, and the coach has
    // finished speaking. If still speaking, stay queued — audioPlayer's
    // onPlaybackDone hook re-drives flushQueue when the audio drains, so the
    // NEXT shot in FIFO order dispatches then. One shot per gate-open keeps
    // critiques from overlapping while still coaching every shot in turn.
    if (!this.isConnected() || this.pendingShotId !== null || audioPlayer.isSpeaking()) return;
    const next = this.queue.shift();
    if (!next) return;
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
    // The socket owns the in-flight turn — its watchdog dies with it (the
    // pendingShotId cleanup below handles the same wedge synchronously).
    this.clearTurnWatchdog();
    this.store().setConnection(state === 'error' ? 'error' : 'disconnected');
    if (err) {
      // Diagnostics only — the user-facing bilingual message is set by the
      // reconnect path (coach.reconnecting) or by exhaustion (coach.connectionLost).
      console.warn('[coach] connection closed:', errMsg(err));
    }

    // A turn that was in flight died with the socket: its turnComplete will
    // never arrive. Close the cost-attribution window and clear the pending
    // state, otherwise dispatch stays wedged (queue never flushes) and later
    // usage is misattributed to the dead shot. If the coach had not spoken a
    // word yet (no transcription received), requeue the shot at the FRONT so
    // it is coached after reconnect — "coach EVERY shot" must survive a socket
    // blip. If it was mid-sentence, drop it: repeating a half-heard critique
    // is worse than moving on.
    if (this.pendingShotId) {
      this.store().endShotCost(this.pendingShotId);
      if (this.turnText === '') {
        const deadShot = this.store().shots.find((s) => s.id === this.pendingShotId);
        if (deadShot) this.requeueFront(deadShot);
      }
      this.pendingShotId = null;
    }
    this.pendingContactCaptureId = null;
    this.pendingStyleId = null;
    this.turnText = '';
    this.turnInterrupted = false;
    // The socket died mid-turn (or there was no turn) — any accumulated coach
    // audio for the dead turn is a partial recording, drop it.
    coachAudioTap.discard();

    if (this.manualClose) return;

    // Auto-reconnect only while the session is meant to be live. Keyed on our
    // own intent flag, NOT store.session.status (a failed reconnect corrupts it).
    if (!this.sessionLive) return;

    // Relay transport: a server-side PERMISSION denial (bad ADC, SA not
    // allowlisted for Live) is permanent — retrying the same creds can never
    // succeed, so stop the backoff and surface a distinct bilingual notice
    // instead of looping "reconnecting…". Detected on the close reason only,
    // so it never false-positives on a transient AQ-path close worth retrying.
    if (isPermissionDeniedClose(err)) {
      this.sessionLive = false;
      // Clear any stale "reconnecting…" notice — while coach.error is set the
      // LiveScreen coach-offline chip is suppressed, so the terminal state
      // would otherwise never surface.
      this.store().setCoachError(null);
      this.store().setSessionError('coach.relayDenied');
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    if (this.reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
      // Exhausted all retries — surface a bilingual "connection lost" state.
      // Non-blocking for pose: setSessionError doesn't tear down the pose loop.
      this.sessionLive = false;
      // Stale 'coach.reconnecting' would otherwise stick forever AND suppress
      // the coach-offline chip (LiveScreen shows it only while !coach.error).
      this.store().setCoachError(null);
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
    this.clearTurnWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.queue = [];
    this.droppedForCap = 0;
    this.pendingShotId = null;
    this.pendingContactCaptureId = null;
    this.pendingStyleId = null;
    this.turnText = '';
    this.turnInterrupted = false;
    // Fresh session next connect → no recency memory of spoken styles either.
    this.recentStyleIds = [];

    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.connected = false;
    this.connecting = false;

    audioPlayer.stop();
    // Any coach audio accumulated for a not-yet-finalized turn is dropped.
    coachAudioTap.discard();
    // v0.6: no mic to stop. Reset the mic UI state defensively so no stale
    // "listening"/level lingers from an earlier build.
    this.store().setCoachListening(false);
    this.store().setMicLevel(0);
    this.store().setConnection('disconnected');
  }
}

export const coachLive = new CoachLiveClient();

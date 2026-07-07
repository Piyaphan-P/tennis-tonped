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
import type { DominantHand, FocusShot, JointAngles, Lang, Shot, ShotPhase, SwingCapture } from '../types';
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

HOW YOU MUST COACH — every reply is ONE short coaching moment, 2 to 4 sentences total, spoken naturally, in exactly this shape:
1. PRAISE (one short, SPECIFIC good thing about THIS swing) — name something real you actually saw ("โหลดเข่าได้ดีตอนแบ็คสวิงเลยนะ" / "Nice knee load on the backswing"). Always open with genuine praise, even on a low score — find the one thing that was okay. Never generic ("ดีมาก" alone); tie it to a phase or a body part.
2. THE ONE FIX (the single highest-impact correction — never a list). State it plainly and actionably, and SAY WHICH PHASE it happens in so the student knows when to change it ("ตอนกระทบลูก แขนยังงออยู่ ลองเหยียดออกไปให้เกือบตรง" / "At contact your arm is still folded — reach it out almost straight through the ball"). Ground it in what you saw across the frames.
3. THE CUE (one short, memorable thing to think about on the very next ball) — a 2–4 word image they can hold ("จำไว้: เหยียดผ่านลูก" / "Remember: reach through the ball").

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

  lines.push(
    `Peak wrist speed: ${shot.peakWristSpeed.toFixed(2)} (normalized units/s).`,
    `Local score: ${r(shot.score)}/100.`,
    `Detected issues: ${issues}.`,
    lang === 'th' ? 'Reply in Thai.' : 'Reply in English.',
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

  /** Single-slot queue: newest shot waiting for a free turn (busy rule). */
  private queuedShot: Shot | null = null;

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
    // Not connected yet, or a coaching turn is already in flight → keep only
    // the newest shot (drop older). Never queue more than one.
    if (!this.isConnected() || this.pendingShotId !== null) {
      this.queuedShot = shot;
      return;
    }
    this.dispatchShot(shot);
  }

  private dispatchShot(shot: Shot): void {
    const session = this.session;
    if (!session) {
      this.queuedShot = shot;
      return;
    }

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
      this.queuedShot = shot;
      console.warn('[coach] send failed:', errMsg(e, 'send failed'));
      this.store().setCoachError('coach.reconnecting');
    }
  }

  private flushQueue(): void {
    if (!this.queuedShot) return;
    if (!this.isConnected() || this.pendingShotId !== null) return;
    const next = this.queuedShot;
    this.queuedShot = null;
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

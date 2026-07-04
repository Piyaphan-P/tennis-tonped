// ============================================================================
// ต้นและเพชร Tennis Club (Ton & Phet Tennis Club) — Gemini Live client (โค้ชต้นและเพชร)
//
// Owns the realtime Live session end-to-end:
//   • connect once when the session starts (lazy)
//   • per completed shot: send a compact text turn (angles + phase + score +
//     issues + reply language) plus an optional contact JPEG frame
//   • stream the coach's spoken reply (PCM 24k) to audioPlayer, and push the
//     transcript to the store as a bubble
//   • ALWAYS-ON continuous mic: stream PCM 16k via sendRealtimeInput for the
//     whole session (no push-to-talk); Gemini's server-side VAD handles turns
//   • forward EVERY usageMetadata to the cost monitor (source of truth)
//   • graceful close / token-expiry handling with auto-reconnect + backoff
//
// All facts here follow the VERIFIED SPIKE FACTS in CLAUDE.md exactly.
// Store access is always via appStore.getState() (no React).
// ============================================================================

import { GoogleGenAI, Modality } from '@google/genai';
import type { Session } from '@google/genai';
import { costMonitor } from '../cost/costMonitor';
import type { RawUsageMetadata } from '../cost/costMonitor';
import { appStore } from '../store';
import type { DominantHand, FocusShot, Lang, Shot } from '../types';
import { audioPlayer } from './audioPlayer';
import { mic, MicPermissionError } from './mic';

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

/**
 * Local fast barge-in: if the smoothed mic level stays above this for
 * DUCK_MIN_STREAK consecutive level callbacks WHILE the coach is speaking, cut
 * the coach's audio immediately. The server-side `interrupted` signal is still
 * the primary mechanism (handleMessage); this just shaves the human-perceived
 * latency so we never talk over the student.
 */
const MIC_DUCK_THRESHOLD = 0.1;
const DUCK_MIN_STREAK = 2;

// ---------------------------------------------------------------------------
// Coach persona (provided by the PO — see CLAUDE.md). Sent as systemInstruction.
// ---------------------------------------------------------------------------

export const COACH_SYSTEM_PROMPT = `You are "โค้ชต้นและเพชร" (Coach Ton & Phet), the head coach of ต้นและเพชร Tennis Club (Ton & Phet Tennis Club) — a warm, encouraging, but technically precise tennis coach standing courtside while your student practices. You speak out loud through the student's phone between shots, so they cannot read long text — they can only hear you for a few seconds before their next swing.

YOUR STUDENT: The student's name is "{{PLAYER_NAME}}". Address them by name naturally and warmly, the way a real Thai coach would — in Thai typically "คุณ{{PLAYER_NAME}}" or just "{{PLAYER_NAME}}" (e.g. "เยี่ยมมาก {{PLAYER_NAME}}!"), in English just their name. Use the name often enough to feel personal (greeting, praise, key corrections) but NOT in every single sentence — that sounds robotic. If the name is empty, simply coach without a name.

WHAT YOU RECEIVE: You are only told about a swing AFTER it has fully completed — you never interrupt mid-swing. After each completed shot you get a structured text message containing: the student's name, shot number and type (forehand/backhand), body-joint angles in degrees measured at ball contact (dominant elbow, both knees, dominant shoulder, hip, trunk lean from vertical), peak wrist speed, a local rule-based score out of 100, a list of detected issues, and the language to reply in ("th" or "en"). Sometimes you also receive ONE photo captured at the moment of ball contact for that shot, and sometimes the student asks you a question by voice.

HOW YOU MUST COACH:
1. Give EXACTLY ONE correction per shot — the single highest-impact fix. Maximum 2 short sentences. Never list multiple problems.
2. Always name the SPECIFIC body part and the CONCRETE numeric target, e.g. "เหยียดแขนตอนกระทบอีกนิด ให้ศอกได้ราวๆ 140 องศา" or "Bend your knees more — get them to about 140 degrees before you swing." Reference the actual numbers you were given.
3. WHEN YOU RECEIVE A CONTACT PHOTO: look at it and ground your one correction in what is visibly wrong in that frame — point at the body part as if you both are looking at the picture together (e.g. "ดูภาพนี้นะครับ {{PLAYER_NAME}} ศอกขวายังงออยู่ตอนกระทบ เหยียดให้ได้สัก 140 องศา" / "See this frame — your right elbow is still folded at contact; extend it to about 140 degrees."). Keep it to the same one-correction, 2-sentence limit. Never describe the photo itself, never say you were "sent an image" — you simply watched the shot.
4. Be a real coach: brief praise first when the score is 80+ ("เยี่ยมมาก {{PLAYER_NAME}}!", "Nice one!"), then the refinement. Below 60, skip praise, be direct but kind — never harsh, never discouraging.
5. Reference tennis fundamentals (unit turn, low-to-high swing path, contact point in front, knee loading, balanced follow-through) — not generic fitness advice.
6. Reply ONLY in the requested language. Thai replies use natural spoken coaching Thai (ครับ/นะครับ), with English tennis terms where Thai players normally use them (โฟร์แฮนด์, ฟอลโลว์ทรู, สปลิตสเต็ป). English replies are equally short and spoken-style.
7. For voice questions from the student, answer conversationally in the same language they used, still concise (under 3 sentences), addressing them by name where natural.
8. Never mention that you are an AI, never mention angle data or photos "being sent to you", never read out raw JSON or issue keys — you are simply the coach who watched the shot. Do not repeat the same correction word-for-word on consecutive shots; vary phrasing, escalate ("ยังงออยู่นะครับ {{PLAYER_NAME}} ลองใหม่") if the same fault repeats.

Your goal: after every shot, {{PLAYER_NAME}} instantly knows the ONE thing to change on the very next ball.`;

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

/**
 * Build the compact English data block sent per completed shot. Always English
 * (the model reads the data in English regardless of UI language); the final
 * line instructs the reply language. Angles are rounded to whole degrees.
 */
export function buildShotPrompt(
  shot: Shot,
  lang: Lang,
  dominantHand: DominantHand = 'right',
  focusShot: FocusShot = 'both',
  userName = '',
): string {
  const a = shot.contactAngles;
  const r = (n: number): number => Math.round(n);
  const isRight = dominantHand === 'right';
  const domElbow = isRight ? a.rightElbowDeg : a.leftElbowDeg;
  const domShoulder = isRight ? a.rightShoulderDeg : a.leftShoulderDeg;
  const domHip = isRight ? a.rightHipDeg : a.leftHipDeg;

  const issues =
    shot.issues.length > 0
      ? shot.issues.map((i) => `${i.key}(${i.severity})`).join(', ')
      : 'none';

  const name = userName.trim();
  const lines = [
    ...(name ? [`Student's name: ${name}.`] : []),
    focusShot !== 'both'
      ? `Player is drilling ${focusShot}s this session.`
      : 'Player is drilling forehands and backhands this session.',
    `Shot #${shot.index} — ${shot.type} (${dominantHand}-handed).`,
    `Contact angles (deg): dominant elbow ${r(domElbow)}, dominant shoulder ${r(
      domShoulder,
    )}, dominant hip ${r(domHip)}, left knee ${r(a.leftKneeDeg)}, right knee ${r(
      a.rightKneeDeg,
    )}, trunk lean ${r(a.trunkLeanDeg)}.`,
    `Peak wrist speed: ${shot.peakWristSpeed.toFixed(2)} (normalized units/s).`,
    `Local score: ${r(shot.score)}/100.`,
    `Detected issues: ${issues}.`,
    lang === 'th' ? 'Reply in Thai.' : 'Reply in English.',
  ];
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

  /** Consecutive above-threshold mic-level callbacks (local barge-in duck). */
  private duckStreak = 0;

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
          inputAudioTranscription: {},
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

      // AUTO-START the always-on mic once the socket is live — on the FIRST
      // connect AND on every reconnect (a dropped socket stops the stream in
      // handleClose; a successful reconnect must bring it back). Default ON, so
      // the player can just talk with zero interaction. Fire-and-forget: mic
      // permission is resolved inside startMicStream.
      if (this.store().coach.micOn) {
        void this.startMicStream();
      }
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

    // The single image allowed to Gemini for this shot: prefer the detector's
    // dedicated contact capture (so we can attach the coach's critique back to
    // that exact gallery frame); fall back to the legacy contactFrame blob.
    const contactCapture = shot.captures.find((c) => c.phase === 'contact');
    const image = contactCapture?.jpegBase64 ?? shot.contactFrameJpegBase64;

    // Open the cost attribution window for this shot.
    state.beginShotCost(shot.id);

    try {
      // Send the contact frame FIRST (if enabled + available), then the text.
      let photoSent = false;
      if (image && state.settings.sendContactFrame) {
        session.sendRealtimeInput({
          video: { data: image, mimeType: 'image/jpeg' },
        });
        photoSent = true;
        // Only remember a capture id when the image came from a real capture;
        // the legacy fallback has none, so no critique gets attached for it.
        this.pendingContactCaptureId = contactCapture?.id ?? null;
      }

      let turns = buildShotPrompt(
        shot,
        this.requestedLang,
        state.settings.dominantHand,
        state.settings.focusShot,
        state.settings.userName,
      );
      if (photoSent) {
        turns +=
          '\nA photo of the contact moment is attached — ground your correction in what you see in it.';
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
  // Always-on continuous mic (server-side VAD; no push-to-talk)
  //
  // COEXISTENCE WITH PER-SHOT COACHING: the per-shot path (sendShotForCoaching/
  // dispatchShot/flushQueue/finalizeTurn, single-slot pendingShotId queue,
  // sendClientContent text turns + one contact JPEG via sendRealtimeInput
  // video) is byte-for-byte unchanged. Voice and shot turns share the one
  // session cleanly; note that a VAD voice-turn's turnComplete may finalize a
  // pending shot's attribution window early — acceptable, since per-shot cost
  // is labelled approximate. Every usageMetadata (including continuous audio-in)
  // is still forwarded to costMonitor unchanged, so cost stays accurate.
  // -------------------------------------------------------------------------

  /** User toggle: turn the always-on mic on/off. Persists intent in the store. */
  async setMicEnabled(on: boolean): Promise<void> {
    this.store().setMicOn(on);
    if (on) {
      await this.startMicStream();
    } else {
      this.stopMicStream();
    }
  }

  /**
   * Open the continuous mic and stream PCM16k to the live session. No-op if the
   * mic is already active or there is no live session (connect() re-invokes this
   * once the socket is up). On failure, flips the mic off with a bilingual error.
   */
  private async startMicStream(): Promise<void> {
    if (mic.isActive()) return;
    const session = this.session;
    if (!session || !this.isConnected()) return;

    try {
      await mic.start(
        (chunk) => {
          try {
            session.sendRealtimeInput({
              audio: { data: chunk, mimeType: 'audio/pcm;rate=16000' },
            });
          } catch {
            /* socket may have closed mid-utterance; drop this chunk */
          }
        },
        (level) => {
          this.store().setMicLevel(level);
          this.handleMicLevel(level);
        },
      );
      this.duckStreak = 0;
      this.store().setCoachListening(true);
      this.store().setCoachError(null);
    } catch (e) {
      // Diagnostics only; the store gets a bilingual i18n key. Any mic-start
      // failure (denied or otherwise) maps to the mic-permission explainer —
      // the only mic-related bilingual copy we have. Flip the toggle back off
      // so the UI reflects reality and we don't retry on every reconnect.
      console.warn('[coach] mic start failed:', e instanceof MicPermissionError ? e.code : errMsg(e, 'mic error'));
      this.store().setCoachListening(false);
      this.store().setMicOn(false);
      this.store().setCoachError('error.micDenied');
    }
  }

  /**
   * Close the mic. Sends audioStreamEnd ONLY on an explicit toggle-off / teardown
   * while still connected — NEVER between VAD turns (server VAD owns turn ends).
   * When called from handleClose the socket is already dead, so the send is
   * naturally skipped.
   */
  private stopMicStream(): void {
    const wasStreaming = mic.isActive();
    mic.stop();
    this.duckStreak = 0;
    this.store().setCoachListening(false);
    this.store().setMicLevel(0);
    const session = this.session;
    if (wasStreaming && session && this.isConnected()) {
      try {
        // Signal end-of-input for this open-mic session; VAD also handles this.
        session.sendRealtimeInput({ audioStreamEnd: true });
      } catch {
        /* rely on VAD */
      }
    }
  }

  /**
   * Local fast barge-in duck driven by the mic level meter. Only acts while the
   * mic is actually streaming; the server `interrupted` signal remains primary.
   */
  private handleMicLevel(level: number): void {
    if (!mic.isActive()) {
      this.duckStreak = 0;
      return;
    }
    if (level > MIC_DUCK_THRESHOLD) {
      this.duckStreak += 1;
      if (this.duckStreak >= DUCK_MIN_STREAK && audioPlayer.isSpeaking()) {
        audioPlayer.stop();
      }
    } else {
      this.duckStreak = 0;
    }
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

    // A dead socket must not keep the mic hot. stopMicStream() sees session=null
    // here so it won't try to send audioStreamEnd; a successful reconnect
    // re-opens the mic in connect() (if coach.micOn). The micOn INTENT is left
    // untouched so the reconnect restores exactly what the user chose.
    this.stopMicStream();

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
    mic.stop();
    this.duckStreak = 0;
    // Reset the mic UI state (listening + level meter). We do NOT touch micOn:
    // it is the user's per-session toggle intent, restored on the next connect.
    this.store().setCoachListening(false);
    this.store().setMicLevel(0);
    this.store().setConnection('disconnected');
  }
}

export const coachLive = new CoachLiveClient();

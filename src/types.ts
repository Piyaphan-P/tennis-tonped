// ============================================================================
// ADGE Tennis — shared type contracts
// Every module codes against these types. Do not import app code here.
// ============================================================================

// ---------------------------------------------------------------------------
// Language / navigation
// ---------------------------------------------------------------------------

/** UI language. Thai is primary. */
export type Lang = 'th' | 'en';

/** Top-level screens routed by App.tsx via store.screen. */
export type Screen = 'home' | 'live' | 'summary' | 'devplan' | 'compare' | 'history';

// ---------------------------------------------------------------------------
// Pose (MediaPipe PoseLandmarker, 33 landmarks, normalized [0..1] coords)
// ---------------------------------------------------------------------------

export interface Landmark {
  /** Normalized x in [0..1], relative to video width. */
  x: number;
  /** Normalized y in [0..1], relative to video height. */
  y: number;
  /** Depth, roughly normalized by hip width. Negative = toward camera. */
  z: number;
  /** Confidence the landmark is visible, [0..1]. May be undefined. */
  visibility?: number;
}

/** MediaPipe landmark indices used throughout the app. */
export const LM = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
} as const;

/** One pose detection result for one video frame. */
export interface PoseFrame {
  /** Monotonic timestamp (performance.now() domain), ms. */
  timestampMs: number;
  /** Exactly 33 landmarks in MediaPipe order, or empty if no person. */
  landmarks: Landmark[];
}

/**
 * Joint angles in DEGREES computed locally from a PoseFrame.
 * All interior angles: e.g. elbow = angle at elbow between shoulder->elbow
 * and wrist->elbow vectors. 180 = fully straight.
 */
export interface JointAngles {
  timestampMs: number;
  leftElbowDeg: number;
  rightElbowDeg: number;
  /** Shoulder abduction: angle at shoulder between hip->shoulder and elbow->shoulder. */
  leftShoulderDeg: number;
  rightShoulderDeg: number;
  leftKneeDeg: number;
  rightKneeDeg: number;
  leftHipDeg: number;
  rightHipDeg: number;
  /** Trunk lean from vertical, degrees. 0 = upright. */
  trunkLeanDeg: number;
  /** Dominant-hand wrist speed, normalized image units per second (EMA-smoothed). */
  wristSpeed: number;
  /** Signed horizontal wrist velocity (normalized units/s). Sign = direction of swing. */
  wristVelX: number;
}

// ---------------------------------------------------------------------------
// Form status (skeleton analysis coloring — Live overlay AND captured frames)
// ---------------------------------------------------------------------------

/**
 * Per-joint form status used to color skeleton segments:
 *   'neutral' → GREY  (tracked movement, no judgement — e.g. idle phase or
 *                      segments that carry no form rule)
 *   'good'    → GREEN (#39D08A) within good-form target range
 *   'warn'    → AMBER (#F1A24A) slightly out of target — needs adjustment
 *   'fault'   → RED   (#FF6A4D) clearly out of target — needs improvement
 */
export type JointStatus = 'neutral' | 'good' | 'warn' | 'fault';

/** The five angle groups the app judges (matches scoring.ts rules). */
export type AngleKey = 'domElbow' | 'domShoulder' | 'leftKnee' | 'rightKnee' | 'trunk';

/** Status per angle group; drives skeleton segment coloring. */
export type AngleStatuses = Record<AngleKey, JointStatus>;

export const ALL_ANGLE_KEYS: readonly AngleKey[] = [
  'domElbow',
  'domShoulder',
  'leftKnee',
  'rightKnee',
  'trunk',
];

/** Dominant hand (also used by angle-segment mapping below). */
export type DominantHand = 'left' | 'right';

/**
 * Which skeleton bone segments (pairs of MediaPipe landmark indices) belong to
 * each judged angle group, for the given dominant hand. PoseCanvas and the
 * capture renderer BOTH use this so live overlay and captured frames color
 * identically. When a bone belongs to multiple groups, color precedence is
 * fault > warn > good > neutral. Bones in no group are always 'neutral' grey.
 */
export function angleSegments(hand: DominantHand): Record<AngleKey, Array<[number, number]>> {
  const S = hand === 'right' ? LM.RIGHT_SHOULDER : LM.LEFT_SHOULDER;
  const E = hand === 'right' ? LM.RIGHT_ELBOW : LM.LEFT_ELBOW;
  const W = hand === 'right' ? LM.RIGHT_WRIST : LM.LEFT_WRIST;
  const H = hand === 'right' ? LM.RIGHT_HIP : LM.LEFT_HIP;
  return {
    domElbow: [
      [S, E],
      [E, W],
    ],
    domShoulder: [[S, H]],
    leftKnee: [
      [LM.LEFT_HIP, LM.LEFT_KNEE],
      [LM.LEFT_KNEE, LM.LEFT_ANKLE],
    ],
    rightKnee: [
      [LM.RIGHT_HIP, LM.RIGHT_KNEE],
      [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
    ],
    trunk: [
      [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
      [LM.LEFT_HIP, LM.RIGHT_HIP],
    ],
  };
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

/** Swing phase state machine (shotDetector). Also shown as a chip on Live. */
export type ShotPhase =
  | 'idle'
  | 'preparation'
  | 'backswing'
  | 'forward-swing'
  | 'contact'
  | 'follow-through';

export type ShotType = 'forehand' | 'backhand' | 'unknown';

export type IssueSeverity = 'good' | 'warn' | 'fault';

/** One rule-based finding about a shot. Copy is pre-localized (both langs). */
export interface ShotIssue {
  /** Stable key, e.g. 'elbow-too-bent', 'no-knee-bend', 'late-contact'. */
  key: string;
  severity: IssueSeverity;
  messageTH: string;
  messageEN: string;
  /** Measured value (deg or speed) that triggered the rule, for telemetry UI. */
  measured?: number;
  /** Human target, e.g. '120–160°'. */
  target?: string;
}

/**
 * One captured swing keyframe (esp. the contact frame). Created by the shot
 * detector during the swing, stored on the Shot, rendered LARGE in the
 * capture gallery with the colored skeleton drawn over the image.
 */
export interface SwingCapture {
  /** crypto.randomUUID() */
  id: string;
  /** Owning shot id. */
  shotId: string;
  /** Swing phase at the moment of capture ('contact' is the hero frame). */
  phase: ShotPhase;
  /** JPEG as base64 WITHOUT the data: prefix (same encoding sent to Gemini). */
  jpegBase64: string;
  /** performance.now()-domain timestamp of the captured frame, ms. */
  atMs: number;
  /** Angle snapshot at capture time. */
  angles: JointAngles;
  /** Landmarks at capture time — required to draw the skeleton on the image. */
  landmarks: Landmark[];
  /** Form statuses at capture time — drives the overlay coloring. */
  statuses: AngleStatuses;
  /**
   * Critique for THIS image. Contact frame: the coach's spoken critique text
   * (attached async after the Gemini turn). Other frames: local rule-derived
   * note. Undefined while pending.
   */
  critique?: string;
  critiqueLang?: Lang;
}

/**
 * A recorded swing video clip (composite: camera frame + burned-in colored
 * skeleton), spanning preparation → follow-through. SESSION-ONLY: `url` is a
 * blob: object URL that lives only for the current Live session. It is
 * revoked + stripped by endSession/startSession and by clip eviction, and it
 * MUST NEVER be persisted — history/localStorage (StoredSession) must never
 * contain a ShotClip or blob URL. Stills (SwingCapture) remain the durable
 * artifacts for Summary, history and the Gemini contact frame.
 */
export interface ShotClip {
  /** blob: object URL for <video src>. Session-only; revoked as above. */
  url: string;
  /** Container/codec actually recorded (e.g. 'video/mp4', 'video/webm;codecs=vp9'). */
  mimeType: string;
  /** Wall-clock length of the recording, ms (capped at 6000). */
  durationMs: number;
  /** Encoded size, bytes (memory telemetry / eviction decisions). */
  sizeBytes: number;
  /** Recording canvas pixel size. */
  width: number;
  height: number;
  /** Encoded clip bytes retained ONLY for cloud upload this session. NEVER serialized. */
  blob?: Blob;
}

/** Coaching returned by Gemini Live for one shot (or one mic Q&A). */
export interface CoachingResult {
  /** Full transcript of what the coach said (from outputAudioTranscription). */
  text: string;
  lang: Lang;
  receivedAtMs: number;
  /** True once the audio for this coaching finished playing. */
  audioPlayed: boolean;
}

/** A completed shot produced by shotDetector + scoring, enriched async by coach/cost. */
export interface Shot {
  /** crypto.randomUUID() */
  id: string;
  /** 1-based index within the session. */
  index: number;
  type: ShotType;
  startMs: number;
  /** Timestamp of peak wrist speed = assumed ball contact. */
  contactMs: number;
  endMs: number;
  /** Snapshot of angles at the contact frame. */
  contactAngles: JointAngles;
  /** Peak dominant-wrist speed during the swing (normalized units/s). */
  peakWristSpeed: number;
  /** Local rule-based score 0–100. */
  score: number;
  issues: ShotIssue[];
  /**
   * Captured swing keyframes (0..3): ideally backswing, contact,
   * follow-through. The contact capture's jpegBase64 is the single image
   * allowed to go to Gemini for this shot.
   */
  captures: SwingCapture[];
  /** Session-only swing video clip (skeleton burned in). Undefined when
   *  recording is unsupported, failed, or the clip was evicted/ended.
   *  NEVER serialized — buildStoredSession/localStorage must not touch it. */
  clip?: ShotClip;
  /** JPEG (base64, no data: prefix) captured at contact, if enabled in settings. */
  contactFrameJpegBase64?: string;
  /** Filled in asynchronously when Gemini replies. */
  coaching?: CoachingResult;
  /**
   * APPROXIMATE cost attributed to this shot (THB): sum of usage deltas that
   * arrived between this shot's coaching request and its turnComplete.
   * Undefined until attribution closes. Always label as approximate in UI.
   */
  costTHB?: number;
}

// ---------------------------------------------------------------------------
// Session / connection
// ---------------------------------------------------------------------------

export type SessionStatus = 'idle' | 'starting' | 'live' | 'ended' | 'error';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SessionState {
  status: SessionStatus;
  /** Date.now() when session started, 0 if none. */
  startedAtMs: number;
  /** Date.now() when session ended, 0 if still live / none. */
  endedAtMs: number;
  /**
   * Last fatal error, null if none. MUST be an i18n key (e.g.
   * 'error.tokenMissing.body') — never a raw English/API string.
   */
  error: string | null;
}

// ---------------------------------------------------------------------------
// History / stats (localStorage-persisted, 3-day auto-expiry)
// ---------------------------------------------------------------------------

/** History entries older than this are pruned on load and on save. */
export const HISTORY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** One concrete thing to improve, aggregated from a session's shot issues. */
export interface SessionImprovement {
  /** ShotIssue.key this improvement aggregates. */
  key: string;
  /** How many shots in the session showed this issue. */
  count: number;
  /** Worst severity seen for this key in the session. */
  severity: IssueSeverity;
  messageTH: string;
  messageEN: string;
  /** Human target, e.g. '120–160°'. */
  target?: string;
}

/**
 * A finished session persisted to localStorage. Lightweight by design —
 * NO images, NO per-frame data (localStorage is small). tsMs drives the
 * 3-day auto-expiry.
 */
export interface StoredSession {
  /** crypto.randomUUID() */
  id: string;
  /** Date.now() when the session ended — expiry clock. */
  tsMs: number;
  userName: string;
  durationMs: number;
  shotCount: number;
  /** Mean local score 0–100. */
  avgScore: number;
  /** % of shots scoring >= 80 (0–100). */
  goodFormPct: number;
  /** Best peak wrist speed in the session (normalized units/s). */
  bestPeakWristSpeed: number;
  /** Total session cost, THB. */
  totalCostTHB: number;
  focusShot: FocusShot;
  /** Top (<=3) concrete things to improve, derived from shot issues. */
  improvements: SessionImprovement[];
}

/** Persisted history: pruned to HISTORY_TTL_MS on init and on every save. */
export type History = StoredSession[];

// ---------------------------------------------------------------------------
// Cloud sync (Postgres metadata + GCS clips; 3-day server-side lifecycle)
// ---------------------------------------------------------------------------

/** Session summary blob stored as jsonb in Postgres (sessions.summary). */
export interface SessionSummaryJson {
  durationMs: number;
  goodFormPct: number;
  bestPeakWristSpeed: number;
  totalCostTHB: number;
  focusShot: FocusShot;
  improvements: SessionImprovement[];
}

/** One session row from the cloud (GET /api/history list item). */
export interface CloudSessionSummary {
  id: string;
  userName: string;
  startedAt: string;
  endedAt: string | null;
  avgScore: number;
  shotCount: number;
  summary: SessionSummaryJson | null;
}

/** One shot row from the cloud (metadata only; clip streamed separately). */
export interface CloudShot {
  id: string;
  sessionId: string;
  idx: number;
  type: ShotType;
  score: number;
  angles: JointAngles;
  statuses: AngleStatuses;
  issues: ShotIssue[];
  peakWristSpeed: number;
  hasClip: boolean;
  clipMime: string | null;
  /** True when the coach's spoken critique WAV is stored for this shot. */
  hasAudio: boolean;
  createdAt: string;
}

/** Full session detail (GET /api/sessions/:id) including its shots. */
export interface CloudSessionDetail extends CloudSessionSummary {
  shots: CloudShot[];
}

/** Remembered reference-video URL per shot type (localStorage 'tp.refVideos'). */
export type RefPrefs = Partial<Record<ShotType, string>>;

/** A clip selected on the Compare screen (user clip or a picked history clip). */
export interface CompareClipRef {
  url: string;
  mimeType: string;
  shotType: ShotType;
}

/** Cross-session aggregate stats shown on Home ("Your Stats"). */
export interface UserStats {
  sessions: number;
  totalShots: number;
  /** Shot-weighted mean score across stored sessions, 0–100. */
  avgScore: number;
  /** Shot-weighted % of good-form (score>=80) shots, 0–100. */
  goodFormPct: number;
  /** Best peak wrist speed ever stored (normalized units/s). */
  bestPeakWristSpeed: number;
}

// ---------------------------------------------------------------------------
// Cost monitor (source of truth = Gemini usageMetadata)
// ---------------------------------------------------------------------------

export type TokenModality = 'TEXT' | 'AUDIO' | 'VIDEO';

/**
 * One parsed usageMetadata message from the Live session, normalized into
 * per-modality token counts. costMonitor produces these; store.addUsage consumes.
 */
export interface UsageDelta {
  /** performance/Date timestamp when the message arrived, ms. */
  atMs: number;
  /** Prompt (input) tokens by modality for this message. */
  promptTokens: Partial<Record<TokenModality, number>>;
  /** Response (output) tokens by modality for this message. */
  responseTokens: Partial<Record<TokenModality, number>>;
  /** Reasoning tokens (billed as text output). */
  thoughtsTokens: number;
  /** totalTokenCount as reported by the server. */
  totalTokens: number;
}

/** Cumulative token counters bucketed the way billing works. */
export interface TokenTotals {
  textIn: number;
  audioIn: number;
  videoIn: number;
  textOut: number;
  audioOut: number;
  /** Thoughts tokens, billed at the text-output rate. */
  thoughts: number;
  /** Server-reported total (sanity check, not used for billing math). */
  total: number;
}

/**
 * Editable pricing. Rates are USD per 1M tokens; usdToThb converts to THB.
 * THB per token = usdPer1M * usdToThb / 1_000_000.
 */
export interface PricingRates {
  textInPer1M: number;
  audioInPer1M: number;
  videoInPer1M: number;
  textOutPer1M: number;
  audioOutPer1M: number;
  usdToThb: number;
}

/** Fully-computed THB breakdown for display. */
export interface CostBreakdown {
  thbTotal: number;
  textInTHB: number;
  audioInTHB: number;
  videoInTHB: number;
  textOutTHB: number;
  audioOutTHB: number;
  /** thoughts billed at textOut rate, shown separately for honesty. */
  thoughtsTHB: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Which shot the player is drilling this session — threaded into the coach prompt. */
export type FocusShot = 'forehand' | 'backhand' | 'both';

export interface Settings {
  rates: PricingRates;
  /**
   * Player's name, captured on Home. Threaded into the coach systemInstruction
   * so โค้ช ADGE addresses the player by name. Persisted to localStorage.
   */
  userName: string;
  /** Send 1 JPEG contact frame with each shot's coaching request. */
  sendContactFrame: boolean;
  /** Play coach audio (off = transcript only, cheaper UX but same tokens). */
  coachVoiceOn: boolean;
  dominantHand: DominantHand;
  /** 'user' = front camera (default: player props phone facing themself). */
  cameraFacing: 'user' | 'environment';
  /** Shot the player is drilling this session. */
  focusShot: FocusShot;
}

// ---------------------------------------------------------------------------
// Coach UI state
// ---------------------------------------------------------------------------

export interface CoachState {
  /**
   * Latest coach message ('' = none). Rendered BIG on Live — the coaching
   * feedback is the hero element of the screen.
   */
  bubbleText: string;
  /** Language the bubble text was requested in. */
  bubbleLang: Lang;
  /** Coach audio currently playing. */
  speaking: boolean;
  /** Continuous mic currently streaming PCM16k to Gemini. */
  listening: boolean;
  /** Continuous open-mic toggle (default ON; user-controlled, per-session). */
  micOn: boolean;
  /** Smoothed mic input level 0..1 (~10Hz) for the listening indicator. */
  micLevel: number;
  /**
   * Non-fatal coach error, null if none. MUST be an i18n key (e.g.
   * 'coach.reconnecting', 'coach.connectionLost', 'error.micDenied') —
   * never a raw English/API string. UI translates it.
   */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Pose UI state
// ---------------------------------------------------------------------------

export interface PoseState {
  frame: PoseFrame | null;
  angles: JointAngles | null;
  /**
   * Live per-angle-group form statuses, recomputed on every pushPoseFrame.
   * Null until the first frame with a person. Drives skeleton coloring.
   */
  statuses: AngleStatuses | null;
  phase: ShotPhase;
  /** Measured pose-loop FPS (for the telemetry strip). */
  fps: number;
  /**
   * Fatal pose-init failure (model/WASM failed to load), null if OK.
   * MUST be an i18n key base ('error.poseInitFailed') — Live shows a
   * visible bilingual state, never a silent black screen.
   */
  initError: string | null;
}

// ---------------------------------------------------------------------------
// Cost UI state
// ---------------------------------------------------------------------------

export interface CostState {
  tokens: TokenTotals;
  /** Live THB breakdown recomputed on every addUsage with current rates. */
  breakdown: CostBreakdown;
  /** Shot id currently accumulating attributed cost, or null. */
  attributingShotId: string | null;
  /** Count of usageMetadata messages parsed (debug/telemetry). */
  usageEvents: number;
}

// ---------------------------------------------------------------------------
// Detection HUD (on-court swing detection telemetry)
// ---------------------------------------------------------------------------

/**
 * Why the detector discarded a swing ('' when the swing completed as a shot).
 * 'cooldown' = a would-be swing was suppressed because it started inside the
 * post-shot cooldown window (see SHOT_THRESHOLDS.cooldownMs); it never armed a
 * recording and nothing was sent to the coach. 'coach-speaking' = suppressed
 * because the coach was still speaking the previous critique (speak-to-
 * completion capture gate, v1.2).
 */
export type SwingDiscardReason =
  | ''
  | 'no-contact'
  | 'too-short'
  | 'too-long'
  | 'cooldown'
  | 'coach-speaking';

/** One detector outcome, pushed by ShotDetector.finalize() for the on-court detection HUD. */
export interface DetectionEvent {
  /** performance.now()-domain ms of finalize. */
  atMs: number;
  kind: 'shot-completed' | 'swing-discarded';
  reason: SwingDiscardReason;
  /** Peak smoothed wrist speed seen during the swing (normalized units/s; 0 if none). */
  peakWristSpeed: number;
  durationMs: number;
  /** Number of captures attached to the emitted shot (0 for discarded swings). */
  captureCount: number;
  /** Shot index when kind === 'shot-completed', else 0. */
  shotIndex: number;
}

/** Running detection counters + last event for the Live detection HUD. */
export interface DetectionHudState {
  /** idle -> preparation entries this session. */
  swingsStarted: number;
  shotsCompleted: number;
  swingsDiscarded: number;
  lastEvent: DetectionEvent | null;
}

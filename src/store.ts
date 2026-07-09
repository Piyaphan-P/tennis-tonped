// ============================================================================
// ADGE Tennis — Zustand store (THE integration hub)
//
// Data flow:
//   pose loop        -> pushPoseFrame(frame, angles), setPhase, setPoseFps,
//                       setPoseInitError
//   shot detector    -> addShot(shot), addCapture(shotId, capture)
//   coach liveClient -> setConnection, setCoachBubble/Speaking/Listening,
//                       attachCoaching, attachCaptureCritique,
//                       beginShotCost/endShotCost
//   cost monitor     -> addUsage(delta)
//   UI               -> reads everything reactively; setLang/setScreen/settings
//
// Persistence (localStorage, all guarded for non-browser test envs):
//   tp.lang      — UI language
//   tp.userName  — player name (threaded into coach systemInstruction)
//   tp.history   — finished sessions (StoredSession[]), pruned to 3 days
//                  (HISTORY_TTL_MS) on init and on every save
//
// PoseFrame updates arrive ~30x/s. Components that must not re-render per
// frame (PoseCanvas) should use store.subscribe() + imperative draw, NOT the
// hook selector.
// ============================================================================

import { create } from 'zustand';
import { HISTORY_TTL_MS } from './types';
import type {
  AngleStatuses,
  CompareClipRef,
  CoachingResult,
  CoachState,
  ConnectionState,
  CostBreakdown,
  CostState,
  DetectionEvent,
  DetectionHudState,
  DominantHand,
  History,
  JointAngles,
  JointStatus,
  Lang,
  PoseFrame,
  PoseState,
  PricingRates,
  Screen,
  SessionImprovement,
  SessionState,
  Settings,
  Shot,
  ShotClip,
  ShotPhase,
  StoredSession,
  SwingCapture,
  TokenTotals,
  UsageDelta,
  UserStats,
} from './types';

// ---------------------------------------------------------------------------
// localStorage helpers (safe in node/vitest — no-ops when unavailable)
// ---------------------------------------------------------------------------

const LS_LANG = 'tp.lang';
const LS_USER_NAME = 'tp.userName';
const LS_HISTORY = 'tp.history';

function lsGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* quota/private mode — persistence is best-effort */
  }
}

// ---------------------------------------------------------------------------
// History persistence (3-day auto-expiry)
// ---------------------------------------------------------------------------

/** Drop sessions older than HISTORY_TTL_MS. Pure. */
export function pruneHistory(sessions: History, nowMs: number): History {
  return sessions.filter((s) => nowMs - s.tsMs <= HISTORY_TTL_MS);
}

// ---------------------------------------------------------------------------
// Session-only shot clip cap (blob URLs live only for the current session)
// ---------------------------------------------------------------------------

export const MAX_SESSION_CLIPS = 20;

function revokeClipUrl(clip?: ShotClip): void {
  if (!clip) return;
  try {
    URL.revokeObjectURL(clip.url);
  } catch {
    /* non-browser env */
  }
}

/** Load + prune history from localStorage. Never throws. */
export function loadHistory(nowMs = Date.now()): History {
  const raw = lsGet(LS_HISTORY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (s): s is StoredSession =>
        !!s &&
        typeof (s as StoredSession).id === 'string' &&
        typeof (s as StoredSession).tsMs === 'number' &&
        typeof (s as StoredSession).shotCount === 'number',
    );
    const pruned = pruneHistory(valid, nowMs);
    if (pruned.length !== valid.length) saveHistory(pruned);
    return pruned;
  } catch {
    return [];
  }
}

function saveHistory(history: History): void {
  lsSet(LS_HISTORY, JSON.stringify(history));
}

// ---------------------------------------------------------------------------
// Derived stats / improvements (pure, unit-testable)
// ---------------------------------------------------------------------------

/** Score at/above this counts as "good form" for the stats. */
export const GOOD_FORM_SCORE = 80;

/**
 * Aggregate a session's shot issues into the top (<=3) concrete things to
 * improve, sorted by frequency then severity. 'good' issues are excluded.
 */
export function deriveImprovements(shots: Shot[]): SessionImprovement[] {
  const byKey = new Map<string, SessionImprovement>();
  for (const shot of shots) {
    for (const issue of shot.issues) {
      if (issue.severity === 'good') continue;
      const cur = byKey.get(issue.key);
      if (cur) {
        cur.count += 1;
        if (issue.severity === 'fault') cur.severity = 'fault';
      } else {
        byKey.set(issue.key, {
          key: issue.key,
          count: 1,
          severity: issue.severity,
          messageTH: issue.messageTH,
          messageEN: issue.messageEN,
          target: issue.target,
        });
      }
    }
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        (b.severity === 'fault' ? 1 : 0) - (a.severity === 'fault' ? 1 : 0),
    )
    .slice(0, 3);
}

/** Cross-session aggregate stats from stored history. Pure. */
export function deriveStats(sessions: History): UserStats {
  if (sessions.length === 0) {
    return { sessions: 0, totalShots: 0, avgScore: 0, goodFormPct: 0, bestPeakWristSpeed: 0 };
  }
  const totalShots = sessions.reduce((n, s) => n + s.shotCount, 0);
  const weight = (s: StoredSession) => (totalShots > 0 ? s.shotCount / totalShots : 0);
  return {
    sessions: sessions.length,
    totalShots,
    avgScore: sessions.reduce((sum, s) => sum + s.avgScore * weight(s), 0),
    goodFormPct: sessions.reduce((sum, s) => sum + s.goodFormPct * weight(s), 0),
    bestPeakWristSpeed: Math.max(...sessions.map((s) => s.bestPeakWristSpeed)),
  };
}

// ---------------------------------------------------------------------------
// Live form-status evaluation (skeleton coloring). Pure.
// Target ranges mirror src/analysis/scoring.ts rules.
// ---------------------------------------------------------------------------

const NEUTRAL_STATUSES: AngleStatuses = {
  domElbow: 'neutral',
  domShoulder: 'neutral',
  leftKnee: 'neutral',
  rightKnee: 'neutral',
  trunk: 'neutral',
};

function elbowStatus(deg: number): JointStatus {
  if (deg >= 120 && deg <= 160) return 'good';
  if (deg < 95 || deg > 175) return 'fault';
  return 'warn';
}

function kneeStatus(deg: number): JointStatus {
  if (deg >= 125 && deg <= 160) return 'good';
  if (deg > 172 || deg < 105) return 'fault';
  return 'warn';
}

function shoulderStatus(deg: number): JointStatus {
  if (deg >= 60 && deg <= 110) return 'good';
  return 'warn';
}

function trunkStatus(deg: number): JointStatus {
  if (deg <= 15) return 'good';
  if (deg <= 25) return 'warn';
  return 'fault';
}

/**
 * Compute per-angle-group form statuses for skeleton coloring.
 * During 'idle' everything is 'neutral' (grey = just tracking movement);
 * during an active swing each group is judged against its target range.
 * Used for BOTH the live overlay and captured-frame rendering.
 */
export function evaluateAngleStatuses(
  angles: JointAngles,
  dominantHand: DominantHand,
  phase: ShotPhase,
): AngleStatuses {
  if (phase === 'idle') return NEUTRAL_STATUSES;
  const elbow = dominantHand === 'right' ? angles.rightElbowDeg : angles.leftElbowDeg;
  const shoulder =
    dominantHand === 'right' ? angles.rightShoulderDeg : angles.leftShoulderDeg;
  return {
    domElbow: elbowStatus(elbow),
    domShoulder: shoulderStatus(shoulder),
    leftKnee: kneeStatus(angles.leftKneeDeg),
    rightKnee: kneeStatus(angles.rightKneeDeg),
    trunk: trunkStatus(angles.trunkLeanDeg),
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function envUsdToThb(): number {
  // Vite injects import.meta.env; guard so unit tests outside Vite don't crash.
  try {
    const raw = (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_USD_TO_THB;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 36.5;
  } catch {
    return 36.5;
  }
}

/**
 * Default USD-per-1M-token rates for gemini-2.5-flash-native-audio (Live API).
 * Editable in SettingsSheet; keep in sync with src/cost/pricing.ts DEFAULT_RATES.
 */
export const DEFAULT_RATES: PricingRates = {
  textInPer1M: 0.5,
  audioInPer1M: 3.0,
  videoInPer1M: 3.0,
  textOutPer1M: 2.0,
  audioOutPer1M: 12.0,
  usdToThb: envUsdToThb(),
};

const DEFAULT_SETTINGS: Settings = {
  rates: DEFAULT_RATES,
  userName: lsGet(LS_USER_NAME) ?? '',
  sendContactFrame: true,
  coachVoiceOn: true,
  dominantHand: 'right',
  cameraFacing: 'user',
  focusShot: 'forehand',
};

const ZERO_TOKENS: TokenTotals = {
  textIn: 0,
  audioIn: 0,
  videoIn: 0,
  textOut: 0,
  audioOut: 0,
  thoughts: 0,
  total: 0,
};

const ZERO_BREAKDOWN: CostBreakdown = {
  thbTotal: 0,
  textInTHB: 0,
  audioInTHB: 0,
  videoInTHB: 0,
  textOutTHB: 0,
  audioOutTHB: 0,
  thoughtsTHB: 0,
};

const INITIAL_SESSION: SessionState = {
  status: 'idle',
  startedAtMs: 0,
  endedAtMs: 0,
  error: null,
};

const INITIAL_POSE: PoseState = {
  frame: null,
  angles: null,
  statuses: null,
  phase: 'idle',
  fps: 0,
  initError: null,
};

const INITIAL_COACH: CoachState = {
  bubbleText: '',
  bubbleLang: 'th',
  speaking: false,
  listening: false,
  // v0.6: voice input is cut — must stay false so any future consumer of this
  // state can never show a live mic that isn't there.
  micOn: false,
  micLevel: 0,
  error: null,
};

const INITIAL_COST: CostState = {
  tokens: ZERO_TOKENS,
  breakdown: ZERO_BREAKDOWN,
  attributingShotId: null,
  usageEvents: 0,
};

const INITIAL_DETECTION: DetectionHudState = {
  swingsStarted: 0,
  shotsCompleted: 0,
  swingsDiscarded: 0,
  lastEvent: null,
};

// ---------------------------------------------------------------------------
// Cost math (pure; mirrored by src/cost/pricing.ts for standalone use)
// ---------------------------------------------------------------------------

function thb(tokens: number, usdPer1M: number, usdToThb: number): number {
  return (tokens * usdPer1M * usdToThb) / 1_000_000;
}

export function computeBreakdown(t: TokenTotals, r: PricingRates): CostBreakdown {
  const textInTHB = thb(t.textIn, r.textInPer1M, r.usdToThb);
  const audioInTHB = thb(t.audioIn, r.audioInPer1M, r.usdToThb);
  const videoInTHB = thb(t.videoIn, r.videoInPer1M, r.usdToThb);
  const textOutTHB = thb(t.textOut, r.textOutPer1M, r.usdToThb);
  const audioOutTHB = thb(t.audioOut, r.audioOutPer1M, r.usdToThb);
  const thoughtsTHB = thb(t.thoughts, r.textOutPer1M, r.usdToThb);
  return {
    textInTHB,
    audioInTHB,
    videoInTHB,
    textOutTHB,
    audioOutTHB,
    thoughtsTHB,
    thbTotal:
      textInTHB + audioInTHB + videoInTHB + textOutTHB + audioOutTHB + thoughtsTHB,
  };
}

/** THB value of a single UsageDelta at the given rates (used for per-shot attribution). */
export function deltaTHB(d: UsageDelta, r: PricingRates): number {
  return (
    thb(d.promptTokens.TEXT ?? 0, r.textInPer1M, r.usdToThb) +
    thb(d.promptTokens.AUDIO ?? 0, r.audioInPer1M, r.usdToThb) +
    thb(d.promptTokens.VIDEO ?? 0, r.videoInPer1M, r.usdToThb) +
    thb(d.responseTokens.TEXT ?? 0, r.textOutPer1M, r.usdToThb) +
    thb(d.responseTokens.AUDIO ?? 0, r.audioOutPer1M, r.usdToThb) +
    thb(d.thoughtsTokens, r.textOutPer1M, r.usdToThb)
  );
}

function addTokens(t: TokenTotals, d: UsageDelta): TokenTotals {
  return {
    textIn: t.textIn + (d.promptTokens.TEXT ?? 0),
    audioIn: t.audioIn + (d.promptTokens.AUDIO ?? 0),
    videoIn: t.videoIn + (d.promptTokens.VIDEO ?? 0),
    textOut: t.textOut + (d.responseTokens.TEXT ?? 0),
    audioOut: t.audioOut + (d.responseTokens.AUDIO ?? 0),
    thoughts: t.thoughts + d.thoughtsTokens,
    total: t.total + d.totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

function envToken(): string {
  try {
    const t = (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_GEMINI_TOKEN;
    return typeof t === 'string' ? t : '';
  } catch {
    return '';
  }
}

function initialLang(): Lang {
  return lsGet(LS_LANG) === 'en' ? 'en' : 'th';
}

/** Build the StoredSession snapshot for the CURRENT session. Pure on state. */
function buildStoredSession(s: AppState): StoredSession {
  const shots = s.shots;
  const shotCount = shots.length;
  const avgScore =
    shotCount === 0 ? 0 : shots.reduce((sum, sh) => sum + sh.score, 0) / shotCount;
  const goodFormPct =
    shotCount === 0
      ? 0
      : (shots.filter((sh) => sh.score >= GOOD_FORM_SCORE).length / shotCount) * 100;
  const bestPeakWristSpeed =
    shotCount === 0 ? 0 : Math.max(...shots.map((sh) => sh.peakWristSpeed));
  const endedAtMs = Date.now();
  return {
    id: crypto.randomUUID(),
    tsMs: endedAtMs,
    userName: s.settings.userName,
    durationMs: s.session.startedAtMs ? endedAtMs - s.session.startedAtMs : 0,
    shotCount,
    avgScore,
    goodFormPct,
    bestPeakWristSpeed,
    totalCostTHB: s.cost.breakdown.thbTotal,
    focusShot: s.settings.focusShot,
    improvements: deriveImprovements(shots),
  };
}

export interface AppState {
  // --- global UI ---
  lang: Lang;
  screen: Screen;
  settings: Settings;
  settingsOpen: boolean;

  /** Cloud session id for the CURRENT live session (null until created lazily
   *  on first shot; reset to null by startSession). Written by the cloud-sync
   *  flow, read when uploading shots/clips. */
  cloudSessionId: string | null;
  /** Clip chosen on the Compare screen (user clip or picked history clip). */
  compareClip: CompareClipRef | null;

  /**
   * Runtime Gemini ephemeral token override (pasted in Settings). Seeded from
   * VITE_GEMINI_TOKEN; liveClient prefers this over the build-time env var so a
   * fresh token can be dropped in without a rebuild. Never persisted to disk.
   */
  authToken: string;

  // --- session/connection ---
  session: SessionState;
  connection: ConnectionState;

  // --- realtime data ---
  pose: PoseState;
  shots: Shot[];
  coach: CoachState;
  cost: CostState;

  // --- detection HUD (written ONLY by ShotDetector; read by DetectionHud) ---
  detection: DetectionHudState;

  // --- persisted history (loaded + 3-day-pruned at store init) ---
  history: History;

  // --- actions: global UI ---
  /** Sets UI language and persists it to localStorage. */
  setLang: (lang: Lang) => void;
  setScreen: (screen: Screen) => void;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  updateRates: (patch: Partial<PricingRates>) => void;
  /** Sets the player name (settings.userName) and persists it. */
  setUserName: (name: string) => void;
  setAuthToken: (token: string) => void;
  /** Set the cloud session id for the current live session (or null to clear). */
  setCloudSessionId: (id: string | null) => void;
  /** Set (or clear) the clip selected on the Compare screen. */
  setCompareClip: (c: CompareClipRef | null) => void;

  // --- actions: session lifecycle ---
  /** Resets shots/cost/pose/coach and marks session 'starting'. Called by Home CTA. */
  startSession: () => void;
  /** liveClient calls this once connected; flips 'starting' -> 'live'. */
  markSessionLive: () => void;
  /**
   * Ends session, stamps endedAtMs, AND (if the session produced >=1 shot)
   * appends a StoredSession to history + persists it to localStorage
   * (pruned to 3 days). Navigation handled by caller.
   */
  endSession: () => void;
  /** error MUST be an i18n key, never a raw API/English string. */
  setSessionError: (error: string) => void;
  setConnection: (state: ConnectionState) => void;

  // --- actions: pose loop ---
  /** Pushes the frame AND recomputes pose.statuses for skeleton coloring. */
  pushPoseFrame: (frame: PoseFrame, angles: JointAngles) => void;
  setPhase: (phase: ShotPhase) => void;
  setPoseFps: (fps: number) => void;
  /** error MUST be an i18n key base ('error.poseInitFailed'), or null to clear. */
  setPoseInitError: (error: string | null) => void;

  // --- actions: shots ---
  addShot: (shot: Shot) => void;
  updateShot: (id: string, patch: Partial<Shot>) => void;
  attachCoaching: (id: string, coaching: CoachingResult) => void;
  /** Append one swing capture to its shot (detector calls during the swing). */
  addCapture: (shotId: string, capture: SwingCapture) => void;
  /** Attach the recorded clip to its shot (SwingRecorder → LiveScreen calls
   *  this async after finalize). Enforces MAX_SESSION_CLIPS by revoking +
   *  stripping the OLDEST shot's clip when the cap is exceeded. No-op if the
   *  shot id no longer exists. */
  attachShotClip: (shotId: string, clip: ShotClip) => void;
  /** Attach the coach's (or local) critique to one capture. */
  attachCaptureCritique: (
    shotId: string,
    captureId: string,
    critique: string,
    lang: Lang,
  ) => void;

  // --- actions: coach ---
  setCoachBubble: (text: string, lang: Lang) => void;
  clearCoachBubble: () => void;
  setCoachSpeaking: (speaking: boolean) => void;
  setCoachListening: (listening: boolean) => void;
  setMicOn: (on: boolean) => void;
  setMicLevel: (level: number) => void;
  /** error MUST be an i18n key (e.g. 'coach.reconnecting'), or null. */
  setCoachError: (error: string | null) => void;

  // --- actions: cost ---
  /**
   * Consume one parsed usageMetadata. Accumulates cumulative tokens, recomputes
   * the live THB breakdown, and — if a shot is being attributed — adds this
   * delta's THB to that shot's costTHB (approximate by design).
   */
  addUsage: (delta: UsageDelta) => void;
  /** Start attributing subsequent usage deltas to this shot. */
  beginShotCost: (shotId: string) => void;
  /** Stop attribution (idempotent; no-op if a different shot is active). */
  endShotCost: (shotId: string) => void;

  // --- actions: detection HUD ---
  /** Detector entered 'preparation' (a swing attempt began). */
  markSwingStarted: () => void;
  /** Detector finalized a swing (completed or discarded); updates counters + lastEvent. */
  pushDetectionEvent: (ev: DetectionEvent) => void;
  /** Reset counters (ShotDetector.reset() calls this on session start). */
  resetDetection: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAppStore = create<AppState>()((set) => ({
  lang: initialLang(),
  screen: 'home',
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  authToken: envToken(),
  cloudSessionId: null,
  compareClip: null,

  session: INITIAL_SESSION,
  connection: 'disconnected',

  pose: INITIAL_POSE,
  shots: [],
  coach: INITIAL_COACH,
  cost: INITIAL_COST,

  detection: INITIAL_DETECTION,

  history: loadHistory(),

  // --- global UI ---
  setLang: (lang) => {
    lsSet(LS_LANG, lang);
    set({ lang });
  },
  setScreen: (screen) => set({ screen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  updateSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
  updateRates: (patch) =>
    set((s) => {
      const rates = { ...s.settings.rates, ...patch };
      return {
        settings: { ...s.settings, rates },
        // re-price the live meter immediately with the new rates
        cost: { ...s.cost, breakdown: computeBreakdown(s.cost.tokens, rates) },
      };
    }),
  setUserName: (name) => {
    const userName = name.trim();
    lsSet(LS_USER_NAME, userName);
    set((s) => ({ settings: { ...s.settings, userName } }));
  },
  setAuthToken: (authToken) => set({ authToken: authToken.trim() }),
  setCloudSessionId: (cloudSessionId) => set({ cloudSessionId }),
  setCompareClip: (compareClip) => set({ compareClip }),

  // --- session lifecycle ---
  startSession: () =>
    set((s) => {
      // Defensive: a session abandoned without endSession must not leak blobs.
      for (const sh of s.shots) revokeClipUrl(sh.clip);
      return {
        cloudSessionId: null,
        session: {
          status: 'starting',
          startedAtMs: Date.now(),
          endedAtMs: 0,
          error: null,
        },
        shots: [],
        pose: INITIAL_POSE,
        coach: INITIAL_COACH,
        cost: INITIAL_COST,
        detection: INITIAL_DETECTION,
      };
    }),
  markSessionLive: () =>
    set((s) => ({ session: { ...s.session, status: 'live', error: null } })),
  endSession: () =>
    set((s) => {
      let history = s.history;
      // Persist only real sessions (>=1 shot) — no empty-history noise.
      if (s.shots.length > 0 && s.session.startedAtMs > 0) {
        history = pruneHistory([...s.history, buildStoredSession(s)], Date.now());
        saveHistory(history);
      }
      return {
        history,
        shots: s.shots.map((sh) => {
          revokeClipUrl(sh.clip);
          return sh.clip ? { ...sh, clip: undefined } : sh;
        }),
        session: { ...s.session, status: 'ended' as const, endedAtMs: Date.now() },
        coach: { ...s.coach, speaking: false, listening: false, micLevel: 0 },
        pose: { ...s.pose, phase: 'idle' as const },
        cost: { ...s.cost, attributingShotId: null },
      };
    }),
  setSessionError: (error) =>
    set((s) => ({ session: { ...s.session, status: 'error', error } })),
  setConnection: (connection) => set({ connection }),

  // --- pose loop ---
  pushPoseFrame: (frame, angles) =>
    set((s) => ({
      pose: {
        ...s.pose,
        frame,
        angles,
        statuses: evaluateAngleStatuses(
          angles,
          s.settings.dominantHand,
          s.pose.phase,
        ),
      },
    })),
  setPhase: (phase) =>
    set((s) => (s.pose.phase === phase ? s : { pose: { ...s.pose, phase } })),
  setPoseFps: (fps) => set((s) => ({ pose: { ...s.pose, fps } })),
  setPoseInitError: (initError) =>
    set((s) => ({ pose: { ...s.pose, initError } })),

  // --- shots ---
  addShot: (shot) => set((s) => ({ shots: [...s.shots, shot] })),
  updateShot: (id, patch) =>
    set((s) => ({
      shots: s.shots.map((sh) => (sh.id === id ? { ...sh, ...patch } : sh)),
    })),
  attachCoaching: (id, coaching) =>
    set((s) => ({
      shots: s.shots.map((sh) => (sh.id === id ? { ...sh, coaching } : sh)),
    })),
  addCapture: (shotId, capture) =>
    set((s) => ({
      shots: s.shots.map((sh) =>
        sh.id === shotId ? { ...sh, captures: [...sh.captures, capture] } : sh,
      ),
    })),
  attachShotClip: (shotId, clip) =>
    set((s) => {
      if (!s.shots.some((sh) => sh.id === shotId)) {
        revokeClipUrl(clip);
        return s;
      }
      let shots = s.shots.map((sh) =>
        sh.id === shotId ? { ...sh, clip } : sh,
      );
      const withClips = shots.filter((sh) => sh.clip);
      if (withClips.length > MAX_SESSION_CLIPS) {
        const oldest = withClips[0];
        revokeClipUrl(oldest.clip);
        shots = shots.map((sh) =>
          sh.id === oldest.id ? { ...sh, clip: undefined } : sh,
        );
      }
      return { shots };
    }),
  attachCaptureCritique: (shotId, captureId, critique, lang) =>
    set((s) => ({
      shots: s.shots.map((sh) =>
        sh.id === shotId
          ? {
              ...sh,
              captures: sh.captures.map((c) =>
                c.id === captureId ? { ...c, critique, critiqueLang: lang } : c,
              ),
            }
          : sh,
      ),
    })),

  // --- coach ---
  setCoachBubble: (text, lang) =>
    set((s) => ({ coach: { ...s.coach, bubbleText: text, bubbleLang: lang } })),
  clearCoachBubble: () =>
    set((s) => ({ coach: { ...s.coach, bubbleText: '' } })),
  setCoachSpeaking: (speaking) =>
    set((s) => ({ coach: { ...s.coach, speaking } })),
  setCoachListening: (listening) =>
    set((s) => ({ coach: { ...s.coach, listening } })),
  setMicOn: (micOn) => set((s) => ({ coach: { ...s.coach, micOn } })),
  setMicLevel: (micLevel) =>
    set((s) =>
      Math.abs(s.coach.micLevel - micLevel) < 0.02 && micLevel !== 0
        ? s
        : { coach: { ...s.coach, micLevel } },
    ),
  setCoachError: (error) => set((s) => ({ coach: { ...s.coach, error } })),

  // --- cost ---
  addUsage: (delta) =>
    set((s) => {
      const rates = s.settings.rates;
      const tokens = addTokens(s.cost.tokens, delta);
      const breakdown = computeBreakdown(tokens, rates);
      const attributingShotId = s.cost.attributingShotId;
      let shots = s.shots;
      if (attributingShotId) {
        const add = deltaTHB(delta, rates);
        shots = s.shots.map((sh) =>
          sh.id === attributingShotId
            ? { ...sh, costTHB: (sh.costTHB ?? 0) + add }
            : sh,
        );
      }
      return {
        shots,
        cost: {
          ...s.cost,
          tokens,
          breakdown,
          usageEvents: s.cost.usageEvents + 1,
        },
      };
    }),
  beginShotCost: (shotId) =>
    set((s) => ({ cost: { ...s.cost, attributingShotId: shotId } })),
  endShotCost: (shotId) =>
    set((s) =>
      s.cost.attributingShotId === shotId
        ? { cost: { ...s.cost, attributingShotId: null } }
        : s,
    ),

  // --- detection HUD ---
  markSwingStarted: () =>
    set((s) => ({
      detection: { ...s.detection, swingsStarted: s.detection.swingsStarted + 1 },
    })),
  pushDetectionEvent: (ev) =>
    set((s) => ({
      detection: {
        ...s.detection,
        lastEvent: ev,
        shotsCompleted:
          s.detection.shotsCompleted + (ev.kind === 'shot-completed' ? 1 : 0),
        swingsDiscarded:
          s.detection.swingsDiscarded + (ev.kind === 'swing-discarded' ? 1 : 0),
      },
    })),
  resetDetection: () => set({ detection: INITIAL_DETECTION }),
}));

// ---------------------------------------------------------------------------
// Derived selectors (use with useAppStore(selector))
// ---------------------------------------------------------------------------

export const selectSessionCostTHB = (s: AppState): number =>
  s.cost.breakdown.thbTotal;

export const selectShotCount = (s: AppState): number => s.shots.length;

export const selectLatestShot = (s: AppState): Shot | undefined =>
  s.shots.length > 0 ? s.shots[s.shots.length - 1] : undefined;

export const selectAvgScore = (s: AppState): number =>
  s.shots.length === 0
    ? 0
    : s.shots.reduce((sum, sh) => sum + sh.score, 0) / s.shots.length;

/** Approximate THB per shot: session total / shot count (labelled approximate). */
export const selectTHBPerShot = (s: AppState): number =>
  s.shots.length === 0 ? 0 : s.cost.breakdown.thbTotal / s.shots.length;

export const selectSessionDurationMs = (s: AppState): number => {
  const { startedAtMs, endedAtMs, status } = s.session;
  if (!startedAtMs) return 0;
  if (status === 'live' || status === 'starting') return Date.now() - startedAtMs;
  return (endedAtMs || startedAtMs) - startedAtMs;
};

/** Cross-session aggregate stats (Home "Your Stats" card). */
export const selectUserStats = (s: AppState): UserStats => deriveStats(s.history);

/** Concrete things to improve for the CURRENT session (Summary). */
export const selectSessionImprovements = (s: AppState): SessionImprovement[] =>
  deriveImprovements(s.shots);

/** All captures of the current session, newest last (Live capture gallery). */
export const selectSessionCaptures = (s: AppState): SwingCapture[] =>
  s.shots.flatMap((sh) => sh.captures);

/** Non-hook access for imperative modules (pose loop, liveClient, costMonitor). */
export const appStore = useAppStore;

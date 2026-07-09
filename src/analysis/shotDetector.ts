// ============================================================================
// ADGE Tennis — shot detector (phase state machine + shot builder)
//
// No React. Fed one (frame, angles) per pose tick via onFrame(). Runs a
// dominant-wrist-speed state machine locally (free, instant):
//
//   idle -> preparation -> backswing -> forward-swing -> contact
//        -> follow-through -> idle
//
// On completing a swing it snapshots the contact-frame angles, classifies
// forehand/backhand, scores it locally (scoring.ts), pushes the Shot into
// the store, and fires onShotCompleted so the caller (Live.tsx) can kick off
// the per-shot Gemini coaching request.
//
// CAPTURE GUARANTEE: finalize() always ensures shot.captures has a 'contact'
// entry when a frame is grabbable at all — even if the exact-instant grab in
// onFrame missed (a one-tick pose/video dropout), it retries getJpeg() once
// at finalize time and synthesizes the capture from the detector's own
// peak-frame angles/landmarks (never the late ctx's pose). That capture is
// also the single image liveClient sends to Gemini, so the gallery frame and
// the coach's critique frame are always the same capture.
//
// All thresholds are unitless normalized-units/s (wrist speed is normalized
// image-space distance per second) and are exported as SHOT_THRESHOLDS so
// integration can tune them without touching the state machine.
// ============================================================================

import { LM, ALL_ANGLE_KEYS } from '../types';
import type {
  AngleKey,
  AngleStatuses,
  DominantHand,
  JointAngles,
  Lang,
  Landmark,
  PoseFrame,
  Shot,
  ShotPhase,
  ShotType,
  SwingCapture,
  SwingDiscardReason,
} from '../types';
import { appStore, evaluateAngleStatuses } from '../store';
import { scoreShot } from './scoring';

// ---------------------------------------------------------------------------
// Swing keyframe capture
// ---------------------------------------------------------------------------

/**
 * Context returned by the getJpeg callback: the JPEG (base64, no data: prefix)
 * of the CURRENT video frame plus the pose data that matches it, so the
 * skeleton drawn on the capture lines up with the image. Returning undefined
 * (no decodable frame) tells the detector to skip that keyframe.
 */
export interface CaptureContext {
  jpegBase64: string;
  landmarks: Landmark[];
  angles: JointAngles;
  tsMs: number;
}

export type GetJpeg = () => CaptureContext | undefined;

/** A capture accumulated during the swing, before its owning shot id exists. */
type PendingCapture = Omit<SwingCapture, 'shotId'>;

const STATUS_PRIORITY: Record<string, number> = { neutral: 0, good: 1, warn: 2, fault: 3 };

interface JointMeta {
  th: string;
  en: string;
  target: string;
  value: (a: JointAngles, hand: DominantHand) => number;
}

/** Localized joint labels + targets (mirror scoring.ts / store status ranges). */
const JOINT_META: Record<AngleKey, JointMeta> = {
  domElbow: {
    th: 'ศอก',
    en: 'elbow',
    target: '120–160°',
    value: (a, h) => (h === 'right' ? a.rightElbowDeg : a.leftElbowDeg),
  },
  domShoulder: {
    th: 'ไหล่',
    en: 'shoulder',
    target: '60–110°',
    value: (a, h) => (h === 'right' ? a.rightShoulderDeg : a.leftShoulderDeg),
  },
  leftKnee: {
    th: 'เข่าซ้าย',
    en: 'left knee',
    target: '125–160°',
    value: (a) => a.leftKneeDeg,
  },
  rightKnee: {
    th: 'เข่าขวา',
    en: 'right knee',
    target: '125–160°',
    value: (a) => a.rightKneeDeg,
  },
  trunk: {
    th: 'ลำตัว',
    en: 'trunk lean',
    target: '≤15°',
    value: (a) => a.trunkLeanDeg,
  },
};

/** Worst (fault > warn) judged angle group, or null if all good/neutral. */
function worstStatusKey(statuses: AngleStatuses): AngleKey | null {
  let worst: AngleKey | null = null;
  let worstP = 0;
  for (const k of ALL_ANGLE_KEYS) {
    const p = STATUS_PRIORITY[statuses[k]] ?? 0;
    if (p > worstP) {
      worstP = p;
      worst = k;
    }
  }
  return worst && (statuses[worst] === 'warn' || statuses[worst] === 'fault') ? worst : null;
}

/**
 * Build a short, localized per-frame critique for a NON-contact capture from
 * its worst local form status: "<joint> <deg>° → target <range>". When the
 * frame is clean, a brief positive note. (Contact frames get the coach's
 * spoken critique instead and stay pending until it arrives.)
 */
function buildLocalCritique(
  statuses: AngleStatuses,
  angles: JointAngles,
  hand: DominantHand,
  lang: Lang,
): string {
  const key = worstStatusKey(statuses);
  if (!key) return lang === 'th' ? 'ฟอร์มดีในเฟรมนี้' : 'Good form in this frame';
  const m = JOINT_META[key];
  const deg = Math.round(m.value(angles, hand));
  return lang === 'th'
    ? `${m.th} ${deg}° → เป้าหมาย ${m.target}`
    : `${m.en} ${deg}° → target ${m.target}`;
}

// ---------------------------------------------------------------------------
// Tunable thresholds (unitless normalized-units/s unless noted)
// ---------------------------------------------------------------------------

// NOTE: tuned for real 15fps EMA-smoothed phone-camera wrist speed against a
// ball machine (see shotDetector.capture.test.ts for the realistic-swing +
// idle-jitter regression traces). Idle standing/walking smooths to ~0.1-0.6;
// a moderate real swing's EMA-smoothed peak lands ~0.8-1.6. The escalating
// 0.5 -> 0.7 -> 1.1 chain plus the rise-then-drop peak shape, >=300ms
// duration, 10-frame return-to-idle streak, and 800ms cooldown together keep
// casual movement from ever completing a shot.
export const SHOT_THRESHOLDS = {
  /** Speed above which idle starts counting toward entering 'preparation'. */
  prepEnterSpeed: 0.3,
  /** Consecutive frames above prepEnterSpeed required to leave idle. */
  prepEnterFrames: 3,
  /** Above this speed while in 'preparation', move to 'backswing'. */
  backswingMinSpeed: 0.5,
  /** Above this speed once velX flips sign, move to 'forward-swing'. */
  forwardSwingMinSpeed: 0.7,
  /** A local speed peak must reach at least this to count as 'contact'. */
  contactMinPeakSpeed: 1.1,
  /** Consecutive rising frames required before a drop is treated as a peak. */
  contactMinRisingFrames: 1,
  /** Below this speed, frames count toward the return-to-idle streak. */
  idleReturnSpeed: 0.3,
  /** Consecutive low-speed frames required to fall back to 'idle'. */
  idleReturnFrames: 10,
  /** Discard swings shorter than this (ms) — almost certainly noise. */
  minShotDurationMs: 300,
  /** Discard swings longer than this (ms) — state machine likely desynced. */
  maxShotDurationMs: 3000,
  /**
   * POST-SHOT COOLDOWN (v0.9): after finalizing (completed OR discarded), block
   * re-arming a new preparation for this long (ms). Raised 800 -> 2500 on
   * on-court feedback that captures fired far too frequently ("จับภาพรัวมาก"):
   * a real player needs ~2-3s to reset between ball-machine feeds, so this
   * spaces shots out and stops one long swing's residual motion (or a two-part
   * follow-through) from immediately arming a second phantom shot. A would-be
   * swing inside this window is surfaced on the HUD as a 'cooldown' discard,
   * never recorded and never sent to the coach.
   */
  cooldownMs: 2500,
  /** Dominant-wrist visibility below this at contact -> type 'unknown'. */
  minVisibilityForType: 0.5,
  /**
   * Shot-type orientation gate: minimum |domShoulder.x − nonDomShoulder.x|
   * (normalized) needed to read which image side is the dominant-hand side.
   * Below this the player is too side-on for an x-based forehand/backhand call
   * -> 'unknown'. Checked BEFORE the span is used as a divisor.
   */
  typeShoulderMinSpanX: 0.04,
  /**
   * Shot-type hysteresis: the dominant wrist must sit at least this fraction of
   * the shoulder span away from the body midline to commit to forehand/backhand;
   * nearer-center contacts fall back to 'unknown' rather than guess wrong.
   */
  typeMidlineMarginFrac: 0.12,
  /**
   * While in 'backswing', if speed stays above this for forwardBypassFrames
   * consecutive frames WITHOUT velX ever flipping sign, enter 'forward-swing'
   * anyway. Handles vertical/camera-axis swings where velX (horizontal
   * velocity) never flips even though a real swing is happening.
   */
  forwardBypassSpeed: 1.0,
  /** Consecutive above-forwardBypassSpeed frames (no sign flip) required to bypass. */
  forwardBypassFrames: 2,
};

// ---------------------------------------------------------------------------
// Shot classification
// ---------------------------------------------------------------------------

/**
 * HANDEDNESS-ANCHORED forehand vs backhand (v0.9 bug fix).
 *
 * Anchored on the player's stated dominant hand (settings.dominantHand), NOT on
 * where the racquet-arm happens to sit in the image: a swing whose dominant
 * wrist is on the player's DOMINANT-HAND side of the body midline at contact is
 * a FOREHAND (right-handed & ball on the right = โฟร์แฮนด์แน่ ๆ), the opposite
 * side is a BACKHAND (the arm has crossed the body).
 *
 * MIRROR-INVARIANT by construction. MediaPipe landmarks are RAW normalized
 * video coords — the store's cameraFacing / PoseCanvas mirroring (px = 1−x) is
 * DISPLAY-ONLY and never touches these landmarks. So we never assume "+x = the
 * player's right"; instead we read which image side the dominant side is on
 * from the SHOULDER PAIR (dominant shoulder x − non-dominant shoulder x). That
 * baseline flips together with a coordinate mirror, and the dominant wrist's
 * offset flips with it, so `sign(wristOffset) === orientationSign` is identical
 * whether the coords are mirrored or not. Using the full shoulder baseline
 * (not a single shoulder vs. the midline) also survives the torso rotation at
 * contact that made the old single-shoulder test flip a forehand to backhand.
 *
 * Falls back to 'unknown' (never a wrong guess) when:
 *  - dominant wrist / shoulder visibility is too low,
 *  - the player is too side-on to resolve orientation from x (shoulder x-span
 *    below typeShoulderMinSpanX — an x-based method genuinely can't tell), or
 *  - the wrist sits within a hysteresis margin of the midline (near-center).
 */
export function classifyShotType(
  landmarks: Landmark[],
  dominantHand: DominantHand,
): ShotType {
  if (!landmarks || landmarks.length < 33) return 'unknown';

  const domShoulderIdx = dominantHand === 'right' ? LM.RIGHT_SHOULDER : LM.LEFT_SHOULDER;
  const nonDomShoulderIdx = dominantHand === 'right' ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER;
  const wristIdx = dominantHand === 'right' ? LM.RIGHT_WRIST : LM.LEFT_WRIST;

  const wrist = landmarks[wristIdx];
  const domShoulder = landmarks[domShoulderIdx];
  const nonDomShoulder = landmarks[nonDomShoulderIdx];
  const leftHip = landmarks[LM.LEFT_HIP];
  const rightHip = landmarks[LM.RIGHT_HIP];
  if (!wrist || !domShoulder || !nonDomShoulder || !leftHip || !rightHip) return 'unknown';

  if (
    (wrist.visibility ?? 1) < SHOT_THRESHOLDS.minVisibilityForType ||
    (domShoulder.visibility ?? 1) < SHOT_THRESHOLDS.minVisibilityForType ||
    (nonDomShoulder.visibility ?? 1) < SHOT_THRESHOLDS.minVisibilityForType
  ) {
    return 'unknown';
  }

  // Orientation baseline: which image side is the player's dominant-hand side,
  // read from the shoulder pair. Signed; magnitude = confidence.
  const shoulderSpanX = domShoulder.x - nonDomShoulder.x;
  // GATE FIRST — must run BEFORE the division below, or a near-zero span (a
  // side-on player) would blow up `rel` into a CONFIDENT WRONG answer.
  if (Math.abs(shoulderSpanX) < SHOT_THRESHOLDS.typeShoulderMinSpanX) return 'unknown';
  const orientationSign = Math.sign(shoulderSpanX);

  // Body midline (torso central axis). Shoulder-center + hip-center averaged;
  // hip-center stabilizes it against shoulder rotation at contact.
  const shoulderCenterX = (domShoulder.x + nonDomShoulder.x) / 2;
  const hipCenterX = (leftHip.x + rightHip.x) / 2;
  const midlineX = (shoulderCenterX + hipCenterX) / 2;

  // Dominant wrist offset from the midline, normalized by the (already-gated,
  // non-tiny) shoulder span so the hysteresis margin is scale-invariant.
  const rel = (wrist.x - midlineX) / Math.abs(shoulderSpanX);
  if (Math.abs(rel) < SHOT_THRESHOLDS.typeMidlineMarginFrac) return 'unknown';

  return Math.sign(rel) === orientationSign ? 'forehand' : 'backhand';
}

// ---------------------------------------------------------------------------
// Frame snapshot buffer (for retroactive peak/contact detection)
// ---------------------------------------------------------------------------

interface FrameSnapshot {
  ts: number;
  angles: JointAngles;
  landmarks: Landmark[];
  speed: number;
}

export interface ShotDetectorOptions {
  onShotCompleted: (shot: Shot) => void;
  /**
   * Per-instance threshold overrides, merged over SHOT_THRESHOLDS. Existing
   * callers pass nothing and get the SHOT_THRESHOLDS defaults; tests can
   * override individual keys without mutating the shared exported object.
   */
  thresholds?: Partial<typeof SHOT_THRESHOLDS>;
  /**
   * Fired on idle→preparation (a swing attempt begins), immediately after
   * markSwingStarted(). LiveScreen wires this to SwingRecorder.startSwing().
   * Absence is a no-op — existing callers are unaffected.
   */
  onSwingStarted?: () => void;
  /**
   * Fired exactly once per finalize(): the completed shot's id in the
   * completed branch, or null in the discarded branch. LiveScreen wires this
   * to finish/attach or discard the swing clip. NOT fired by reset()
   * (LiveScreen handles that via SwingRecorder.dispose()). Absence is a no-op.
   */
  onSwingFinalized?: (completedShotId: string | null) => void;
}

/**
 * Runs the swing phase state machine and emits completed Shots. One instance
 * per session; call reset() when a session (re)starts.
 */
export class ShotDetector {
  private opts: ShotDetectorOptions;

  /** Merged thresholds (SHOT_THRESHOLDS + opts.thresholds); the state machine reads only this. */
  private th: typeof SHOT_THRESHOLDS;

  private phase: ShotPhase = 'idle';

  // idle -> preparation gate
  private prepStreak = 0;
  private prepStreakStartMs = 0;

  // backswing / forward-swing tracking
  private backswingSign = 0;
  // consecutive above-forwardBypassSpeed frames in 'backswing' with no sign flip
  private bypassStreak = 0;

  // contact (local peak) detection
  private risingStreak = 0;
  private prevSnapshot: FrameSnapshot | null = null;

  // return-to-idle gate
  private lowSpeedStreak = 0;
  private lowSpeedStreakStartMs = 0;

  // cooldown after finalizing a shot (completed or discarded)
  private cooldownUntilMs = 0;
  // consecutive would-be-prep frames observed DURING cooldown (for the HUD
  // 'cooldown' suppression event); and a latch so we surface it at most once
  // per cooldown window.
  private cooldownPrepStreak = 0;
  private cooldownEventFired = false;

  // FULL-CYCLE guard: a swing only completes (→ coach dispatch) if the FSM
  // actually traversed through follow-through. Set true on entering
  // 'follow-through'; a swing that stalls mid-phase leaves it false and is
  // discarded instead of dispatched.
  private followThroughReached = false;

  // accumulated shot data
  private startMs = 0;
  private contactMs = 0;
  private contactAngles: JointAngles | null = null;
  private contactLandmarks: Landmark[] | null = null;
  private peakWristSpeed = 0;
  private contactFrameJpegBase64: string | undefined = undefined;

  /** Swing keyframes accumulated during the current swing (shotId attached at finalize). */
  private captures: PendingCapture[] = [];

  constructor(opts: ShotDetectorOptions) {
    this.opts = opts;
    this.th = { ...SHOT_THRESHOLDS, ...opts.thresholds };
  }

  /** Reset the state machine (e.g. on session start). Also resets phase in the store. */
  reset(): void {
    this.phase = 'idle';
    this.prepStreak = 0;
    this.prepStreakStartMs = 0;
    this.backswingSign = 0;
    this.bypassStreak = 0;
    this.risingStreak = 0;
    this.prevSnapshot = null;
    this.lowSpeedStreak = 0;
    this.lowSpeedStreakStartMs = 0;
    this.cooldownUntilMs = 0;
    this.cooldownPrepStreak = 0;
    this.cooldownEventFired = false;
    this.followThroughReached = false;
    this.clearAccumulated();
    appStore.getState().setPhase('idle');
    // Keep HUD counters in lockstep with the detector's lifecycle — re-entering
    // Live without passing Home must not carry stale counts.
    appStore.getState().resetDetection();
  }

  private clearAccumulated(): void {
    this.startMs = 0;
    this.contactMs = 0;
    this.contactAngles = null;
    this.contactLandmarks = null;
    this.peakWristSpeed = 0;
    this.contactFrameJpegBase64 = undefined;
    this.captures = [];
  }

  private setPhase(phase: ShotPhase): void {
    this.phase = phase;
    appStore.getState().setPhase(phase);
  }

  /**
   * Snapshot one swing keyframe (at most one per phase per swing). getJpeg
   * returns the current frame's jpeg + matching pose; if it returns undefined
   * (no decodable frame) the keyframe is skipped (throttle). Returns the
   * context so callers (contact) can reuse the jpeg.
   */
  private captureKeyframe(phase: ShotPhase, getJpeg?: GetJpeg): CaptureContext | undefined {
    if (!getJpeg) return undefined;
    if (this.captures.some((c) => c.phase === phase)) return undefined;
    const ctx = getJpeg();
    if (!ctx) return undefined;
    const hand = appStore.getState().settings.dominantHand;
    this.captures.push({
      id: crypto.randomUUID(),
      phase,
      jpegBase64: ctx.jpegBase64,
      atMs: ctx.tsMs,
      angles: ctx.angles,
      landmarks: ctx.landmarks,
      statuses: evaluateAngleStatuses(ctx.angles, hand, phase),
    });
    return ctx;
  }

  /**
   * Feed one pose tick. `getJpeg` (if provided and settings.sendContactFrame
   * is on) is called exactly once, at the moment contact is detected, to
   * snapshot the current video frame as a base64 JPEG (no data: prefix).
   */
  onFrame(frame: PoseFrame, angles: JointAngles, getJpeg?: GetJpeg): void {
    if (!frame.landmarks || frame.landmarks.length === 0) return;

    const ts = frame.timestampMs;
    const speed = angles.wristSpeed;
    const velX = angles.wristVelX;

    // --- idle: gate entry into 'preparation' ------------------------------
    if (this.phase === 'idle') {
      if (ts < this.cooldownUntilMs) {
        // Cooling down after the last shot: a new prep MUST NOT arm here (no
        // recording, no captures, no coach dispatch). But a real would-be swing
        // during the window is worth surfacing on the HUD once, so the player
        // sees WHY nothing was captured ("คูลดาวน์") instead of silence.
        if (speed > this.th.prepEnterSpeed) {
          this.cooldownPrepStreak += 1;
          if (this.cooldownPrepStreak >= this.th.prepEnterFrames && !this.cooldownEventFired) {
            this.cooldownEventFired = true;
            appStore.getState().pushDetectionEvent({
              atMs: ts,
              kind: 'swing-discarded',
              reason: 'cooldown',
              peakWristSpeed: speed,
              durationMs: 0,
              captureCount: 0,
              shotIndex: 0,
            });
          }
        } else {
          this.cooldownPrepStreak = 0;
        }
        return;
      }
      // Window just elapsed — clear the suppression latch for next time.
      this.cooldownPrepStreak = 0;
      this.cooldownEventFired = false;

      if (speed > this.th.prepEnterSpeed) {
        if (this.prepStreak === 0) this.prepStreakStartMs = ts;
        this.prepStreak += 1;
        if (this.prepStreak >= this.th.prepEnterFrames) {
          this.startMs = this.prepStreakStartMs;
          this.prepStreak = 0;
          this.risingStreak = 0;
          this.backswingSign = 0;
          this.bypassStreak = 0;
          this.lowSpeedStreak = 0;
          this.followThroughReached = false;
          this.prevSnapshot = { ts, angles, landmarks: frame.landmarks, speed };
          appStore.getState().markSwingStarted();
          this.opts.onSwingStarted?.();
          this.setPhase('preparation');
        }
      } else {
        this.prepStreak = 0;
      }
      return;
    }

    // --- non-idle: track return-to-idle streak first ----------------------
    if (speed < this.th.idleReturnSpeed) {
      if (this.lowSpeedStreak === 0) this.lowSpeedStreakStartMs = ts;
      this.lowSpeedStreak += 1;
    } else {
      this.lowSpeedStreak = 0;
    }

    if (this.lowSpeedStreak >= this.th.idleReturnFrames) {
      this.finalize(this.lowSpeedStreakStartMs, getJpeg);
      this.prevSnapshot = { ts, angles, landmarks: frame.landmarks, speed };
      return;
    }

    // --- phase-specific transitions ---------------------------------------
    switch (this.phase) {
      case 'preparation': {
        if (speed > this.th.backswingMinSpeed) {
          this.backswingSign = Math.sign(velX) || 1;
          this.bypassStreak = 0;
          this.setPhase('backswing');
        }
        break;
      }

      case 'backswing': {
        const curSign = Math.sign(velX);
        if (
          curSign !== 0 &&
          curSign === -this.backswingSign &&
          speed > this.th.forwardSwingMinSpeed
        ) {
          this.risingStreak = 0;
          this.bypassStreak = 0;
          // Keyframe #1: top of the backswing (throttled — skipped if no frame).
          this.captureKeyframe('backswing', getJpeg);
          this.setPhase('forward-swing');
          break;
        }
        // Bypass: vertical/camera-axis swings where velX never flips sign
        // but speed is sustained well above idle — treat as a real swing.
        if (speed > this.th.forwardBypassSpeed) {
          this.bypassStreak += 1;
          if (this.bypassStreak >= this.th.forwardBypassFrames) {
            this.risingStreak = 0;
            this.bypassStreak = 0;
            this.captureKeyframe('backswing', getJpeg);
            this.setPhase('forward-swing');
          }
        } else {
          this.bypassStreak = 0;
        }
        break;
      }

      case 'forward-swing': {
        const prevSpeed = this.prevSnapshot?.speed ?? 0;
        if (speed >= prevSpeed) {
          this.risingStreak += 1;
        } else {
          // speed dropped this frame — check whether the previous frame was
          // a qualifying local peak (contact).
          if (
            this.risingStreak >= this.th.contactMinRisingFrames &&
            prevSpeed >= this.th.contactMinPeakSpeed &&
            this.prevSnapshot
          ) {
            this.contactMs = this.prevSnapshot.ts;
            this.contactAngles = this.prevSnapshot.angles;
            this.contactLandmarks = this.prevSnapshot.landmarks;
            this.peakWristSpeed = prevSpeed;
            // Keyframe #2: CONTACT — the hero frame. Always attempt (not
            // throttled). Its jpeg is also the single frame allowed to Gemini
            // (gated by settings.sendContactFrame).
            const settings = appStore.getState().settings;
            const contactCtx = this.captureKeyframe('contact', getJpeg);
            if (contactCtx && settings.sendContactFrame) {
              this.contactFrameJpegBase64 = contactCtx.jpegBase64;
            }
            this.setPhase('contact');
          }
          this.risingStreak = 0;
        }
        break;
      }

      case 'contact': {
        // Contact is a single-frame marker; immediately settle into decay.
        // Keyframe #3: follow-through entry (throttled — skipped if no frame).
        this.captureKeyframe('follow-through', getJpeg);
        // GUARANTEED CAPTURE retry: the instant grab above (in 'forward-swing')
        // may have missed (one-tick video/pose dropout at the exact peak). Keep
        // trying every tick from here on, synthesized from the detector's OWN
        // stored peak data — never the late ctx's pose — until one lands.
        this.retryContactCapture(getJpeg);
        // FULL-CYCLE marker: the swing has now traversed the complete cycle
        // through follow-through, so finalize() is allowed to dispatch it.
        this.followThroughReached = true;
        this.setPhase('follow-through');
        break;
      }

      case 'follow-through':
        // Stay here until the idle-return streak above fires; keep retrying
        // the contact capture every tick until it lands (see 'contact' case).
        this.retryContactCapture(getJpeg);
        break;

      default:
        break;
    }

    this.prevSnapshot = { ts, angles, landmarks: frame.landmarks, speed };
  }

  /**
   * GUARANTEED CAPTURE retry (item 2 of the capture-robustness fix): if the
   * swing is past its peak and no 'contact' capture has landed yet, try
   * getJpeg() again. On success, the capture is ALWAYS synthesized from this
   * detector's own stored peak data (this.contactMs/contactAngles/
   * contactLandmarks) — never from getJpeg's (now-late) pose — so the
   * skeleton drawn on the recovered frame still matches the true contact
   * instant even though the JPEG itself is a few frames late. No-op once a
   * 'contact' capture already exists, and safe to call every tick.
   */
  private retryContactCapture(getJpeg?: GetJpeg): void {
    if (!getJpeg) return;
    if (!this.contactAngles || !this.contactLandmarks) return;
    if (this.captures.some((c) => c.phase === 'contact')) return;
    const ctx = getJpeg();
    if (!ctx) return;
    const settings = appStore.getState().settings;
    const capture: PendingCapture = {
      id: crypto.randomUUID(),
      phase: 'contact',
      jpegBase64: ctx.jpegBase64,
      atMs: this.contactMs,
      angles: this.contactAngles,
      landmarks: this.contactLandmarks,
      statuses: evaluateAngleStatuses(this.contactAngles, settings.dominantHand, 'contact'),
    };
    this.captures.push(capture);
    if (settings.sendContactFrame && !this.contactFrameJpegBase64) {
      this.contactFrameJpegBase64 = ctx.jpegBase64;
    }
  }

  /** Build + emit the Shot (if valid) and return to idle with a cooldown. */
  private finalize(endMs: number, getJpeg?: GetJpeg): void {
    const duration = endMs - this.startMs;
    const hasContact = this.contactAngles !== null && this.contactLandmarks !== null;
    // FULL-SWING-ONLY: a shot only reaches the coach if the FSM ran the complete
    // cycle through follow-through. A partial swing that stalled mid-phase
    // (never locked contact, or never entered follow-through) is discarded.
    const fullCycle = hasContact && this.followThroughReached;
    const validDuration =
      duration >= this.th.minShotDurationMs && duration <= this.th.maxShotDurationMs;

    if (fullCycle && validDuration) {
      const { settings, shots } = appStore.getState();
      const type = classifyShotType(this.contactLandmarks as Landmark[], settings.dominantHand);
      const { score, issues } = scoreShot({
        type,
        contactAngles: this.contactAngles as JointAngles,
        peakWristSpeed: this.peakWristSpeed,
        dominantHand: settings.dominantHand,
      });

      // FALLBACK: the normal path snapshots the 'contact' keyframe the instant
      // the peak is detected (in onFrame, above). If that attempt missed —
      // e.g. a one-tick MediaPipe/video dropout right at the swing's peak —
      // this.captures has NO 'contact' entry even though we know a shot
      // happened. Retry getJpeg() once, here, and synthesize the contact
      // keyframe from the detector's OWN peak-frame data (this.contactAngles /
      // this.contactLandmarks) — NEVER from whatever pose getJpeg's ctx
      // happens to return "late" — so the skeleton drawn on the recovered
      // frame still matches the actual contact instant. This guarantees
      // captures.length >= 1 whenever a shot completes and any frame is
      // grabbable, and keeps the Gemini image + the gallery frame as the
      // exact same capture (liveClient prefers shot.captures over the legacy
      // field below).
      let contactCapture = this.captures.find((c) => c.phase === 'contact');
      if (!contactCapture && getJpeg) {
        const ctx = getJpeg();
        if (ctx) {
          contactCapture = {
            id: crypto.randomUUID(),
            phase: 'contact',
            jpegBase64: ctx.jpegBase64,
            atMs: this.contactMs,
            angles: this.contactAngles as JointAngles,
            landmarks: this.contactLandmarks as Landmark[],
            statuses: evaluateAngleStatuses(
              this.contactAngles as JointAngles,
              settings.dominantHand,
              'contact',
            ),
          };
          this.captures.push(contactCapture);
        }
      }

      // Legacy single-image field: kept in sync with the SAME contact capture
      // (never a separately-fetched frame), gated by sendContactFrame as before.
      const contactFrameJpegBase64 =
        this.contactFrameJpegBase64 ??
        (settings.sendContactFrame ? contactCapture?.jpegBase64 : undefined);

      const id = crypto.randomUUID();
      const lang = appStore.getState().lang;

      // Attach the owning shot id to the accumulated keyframes. Non-contact
      // frames get a local rule-derived critique now; contact frames stay
      // pending until the coach's spoken critique arrives.
      const captures: SwingCapture[] = this.captures.map((c) => {
        if (c.phase === 'contact') return { ...c, shotId: id };
        return {
          ...c,
          shotId: id,
          critique: buildLocalCritique(c.statuses, c.angles, settings.dominantHand, lang),
          critiqueLang: lang,
        };
      });

      const shot: Shot = {
        id,
        index: shots.length + 1,
        type,
        startMs: this.startMs,
        contactMs: this.contactMs,
        endMs,
        contactAngles: this.contactAngles as JointAngles,
        peakWristSpeed: this.peakWristSpeed,
        score,
        issues,
        captures,
        contactFrameJpegBase64,
      };

      appStore.getState().addShot(shot);
      this.opts.onShotCompleted(shot);

      // Detection HUD contract: surface every completed shot (with its
      // capture count) so a capture-less shot — which the guarantees above
      // should make impossible — is visible on the HUD instead of silent.
      appStore.getState().pushDetectionEvent({
        atMs: endMs,
        kind: 'shot-completed',
        reason: '',
        peakWristSpeed: this.peakWristSpeed,
        durationMs: duration,
        captureCount: captures.length,
        shotIndex: shot.index,
      });

      // Recorder hook: hand the completed shot id to LiveScreen so it can
      // finish the clip and attach it. Fired exactly once per finalize().
      this.opts.onSwingFinalized?.(shot.id);
    } else {
      // Discarded swing: still surface it on the detection HUD so a real
      // on-court swing that never reached 'contact' (or was too short/long)
      // is visible instead of silently vanishing.
      // A swing that never completed the full cycle (no contact locked, or
      // contact but no follow-through) reads as 'no-contact' — it's a partial
      // swing, not a valid shot. Duration reasons only apply once the cycle
      // was otherwise complete.
      const reason: SwingDiscardReason = !fullCycle
        ? 'no-contact'
        : duration < this.th.minShotDurationMs
          ? 'too-short'
          : 'too-long';
      appStore.getState().pushDetectionEvent({
        atMs: endMs,
        kind: 'swing-discarded',
        reason,
        peakWristSpeed: this.peakWristSpeed,
        durationMs: duration,
        captureCount: 0,
        shotIndex: 0,
      });

      // Recorder hook: null signals "discard the in-flight clip". Fired
      // exactly once per finalize().
      this.opts.onSwingFinalized?.(null);
    }

    // Reset swing accumulators and enter cooldown, whether the swing was
    // completed or discarded as noise (guards against immediately re-firing
    // on the same residual motion).
    this.clearAccumulated();
    this.prepStreak = 0;
    this.risingStreak = 0;
    this.backswingSign = 0;
    this.bypassStreak = 0;
    this.lowSpeedStreak = 0;
    this.followThroughReached = false;
    this.cooldownPrepStreak = 0;
    this.cooldownEventFired = false;
    this.cooldownUntilMs = endMs + this.th.cooldownMs;
    this.setPhase('idle');
  }
}

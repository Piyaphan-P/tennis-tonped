// ============================================================================
// ต้นและเพชร Tennis Club — shot detector (phase state machine + shot builder)
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

export const SHOT_THRESHOLDS = {
  /** Speed above which idle starts counting toward entering 'preparation'. */
  prepEnterSpeed: 0.3,
  /** Consecutive frames above prepEnterSpeed required to leave idle. */
  prepEnterFrames: 3,
  /** Above this speed while in 'preparation', move to 'backswing'. */
  backswingMinSpeed: 0.8,
  /** Above this speed once velX flips sign, move to 'forward-swing'. */
  forwardSwingMinSpeed: 1.2,
  /** A local speed peak must reach at least this to count as 'contact'. */
  contactMinPeakSpeed: 2.0,
  /** Consecutive rising frames required before a drop is treated as a peak. */
  contactMinRisingFrames: 2,
  /** Below this speed, frames count toward the return-to-idle streak. */
  idleReturnSpeed: 0.3,
  /** Consecutive low-speed frames required to fall back to 'idle'. */
  idleReturnFrames: 10,
  /** Discard swings shorter than this (ms) — almost certainly noise. */
  minShotDurationMs: 300,
  /** Discard swings longer than this (ms) — state machine likely desynced. */
  maxShotDurationMs: 3000,
  /** After finalizing (completed or discarded), block re-entry for this long (ms). */
  cooldownMs: 800,
  /** Dominant-wrist visibility below this at contact -> type 'unknown'. */
  minVisibilityForType: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Shot classification
// ---------------------------------------------------------------------------

/**
 * Forehand vs backhand from the contact-frame landmarks: compare the
 * dominant wrist's side of the body midline (hip midpoint) to the dominant
 * shoulder's side. Same side -> forehand (wrist stays on the racquet-arm
 * side). Opposite side -> backhand (wrist has crossed the body). Low
 * dominant-wrist visibility -> 'unknown' rather than guessing.
 */
export function classifyShotType(
  landmarks: Landmark[],
  dominantHand: DominantHand,
): ShotType {
  if (!landmarks || landmarks.length < 33) return 'unknown';

  const wristIdx = dominantHand === 'right' ? LM.RIGHT_WRIST : LM.LEFT_WRIST;
  const shoulderIdx = dominantHand === 'right' ? LM.RIGHT_SHOULDER : LM.LEFT_SHOULDER;
  const wrist = landmarks[wristIdx];
  const shoulder = landmarks[shoulderIdx];
  const leftHip = landmarks[LM.LEFT_HIP];
  const rightHip = landmarks[LM.RIGHT_HIP];
  if (!wrist || !shoulder || !leftHip || !rightHip) return 'unknown';

  if (
    (wrist.visibility ?? 1) < SHOT_THRESHOLDS.minVisibilityForType ||
    (shoulder.visibility ?? 1) < SHOT_THRESHOLDS.minVisibilityForType
  ) {
    return 'unknown';
  }

  const midlineX = (leftHip.x + rightHip.x) / 2;
  const wristSide = Math.sign(wrist.x - midlineX);
  const shoulderSide = Math.sign(shoulder.x - midlineX);

  if (wristSide === 0 || shoulderSide === 0) return 'unknown';
  return wristSide === shoulderSide ? 'forehand' : 'backhand';
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
}

/**
 * Runs the swing phase state machine and emits completed Shots. One instance
 * per session; call reset() when a session (re)starts.
 */
export class ShotDetector {
  private opts: ShotDetectorOptions;

  private phase: ShotPhase = 'idle';

  // idle -> preparation gate
  private prepStreak = 0;
  private prepStreakStartMs = 0;

  // backswing / forward-swing tracking
  private backswingSign = 0;

  // contact (local peak) detection
  private risingStreak = 0;
  private prevSnapshot: FrameSnapshot | null = null;

  // return-to-idle gate
  private lowSpeedStreak = 0;
  private lowSpeedStreakStartMs = 0;

  // cooldown after finalizing a shot (completed or discarded)
  private cooldownUntilMs = 0;

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
  }

  /** Reset the state machine (e.g. on session start). Also resets phase in the store. */
  reset(): void {
    this.phase = 'idle';
    this.prepStreak = 0;
    this.prepStreakStartMs = 0;
    this.backswingSign = 0;
    this.risingStreak = 0;
    this.prevSnapshot = null;
    this.lowSpeedStreak = 0;
    this.lowSpeedStreakStartMs = 0;
    this.cooldownUntilMs = 0;
    this.clearAccumulated();
    appStore.getState().setPhase('idle');
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
      if (ts < this.cooldownUntilMs) return; // cooling down after last shot

      if (speed > SHOT_THRESHOLDS.prepEnterSpeed) {
        if (this.prepStreak === 0) this.prepStreakStartMs = ts;
        this.prepStreak += 1;
        if (this.prepStreak >= SHOT_THRESHOLDS.prepEnterFrames) {
          this.startMs = this.prepStreakStartMs;
          this.prepStreak = 0;
          this.risingStreak = 0;
          this.backswingSign = 0;
          this.lowSpeedStreak = 0;
          this.prevSnapshot = { ts, angles, landmarks: frame.landmarks, speed };
          this.setPhase('preparation');
        }
      } else {
        this.prepStreak = 0;
      }
      return;
    }

    // --- non-idle: track return-to-idle streak first ----------------------
    if (speed < SHOT_THRESHOLDS.idleReturnSpeed) {
      if (this.lowSpeedStreak === 0) this.lowSpeedStreakStartMs = ts;
      this.lowSpeedStreak += 1;
    } else {
      this.lowSpeedStreak = 0;
    }

    if (this.lowSpeedStreak >= SHOT_THRESHOLDS.idleReturnFrames) {
      this.finalize(this.lowSpeedStreakStartMs, getJpeg);
      this.prevSnapshot = { ts, angles, landmarks: frame.landmarks, speed };
      return;
    }

    // --- phase-specific transitions ---------------------------------------
    switch (this.phase) {
      case 'preparation': {
        if (speed > SHOT_THRESHOLDS.backswingMinSpeed) {
          this.backswingSign = Math.sign(velX) || 1;
          this.setPhase('backswing');
        }
        break;
      }

      case 'backswing': {
        const curSign = Math.sign(velX);
        if (
          curSign !== 0 &&
          curSign === -this.backswingSign &&
          speed > SHOT_THRESHOLDS.forwardSwingMinSpeed
        ) {
          this.risingStreak = 0;
          // Keyframe #1: top of the backswing (throttled — skipped if no frame).
          this.captureKeyframe('backswing', getJpeg);
          this.setPhase('forward-swing');
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
            this.risingStreak >= SHOT_THRESHOLDS.contactMinRisingFrames &&
            prevSpeed >= SHOT_THRESHOLDS.contactMinPeakSpeed &&
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
        this.setPhase('follow-through');
        break;
      }

      case 'follow-through':
        // Stay here until the idle-return streak above fires.
        break;

      default:
        break;
    }

    this.prevSnapshot = { ts, angles, landmarks: frame.landmarks, speed };
  }

  /** Build + emit the Shot (if valid) and return to idle with a cooldown. */
  private finalize(endMs: number, getJpeg?: GetJpeg): void {
    const duration = endMs - this.startMs;
    const hasContact = this.contactAngles !== null && this.contactLandmarks !== null;

    if (
      hasContact &&
      duration >= SHOT_THRESHOLDS.minShotDurationMs &&
      duration <= SHOT_THRESHOLDS.maxShotDurationMs
    ) {
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
    }

    // Reset swing accumulators and enter cooldown, whether the swing was
    // completed or discarded as noise (guards against immediately re-firing
    // on the same residual motion).
    this.clearAccumulated();
    this.prepStreak = 0;
    this.risingStreak = 0;
    this.backswingSign = 0;
    this.lowSpeedStreak = 0;
    this.cooldownUntilMs = endMs + SHOT_THRESHOLDS.cooldownMs;
    this.setPhase('idle');
  }
}

// ============================================================================
// ADGE Tennis — swing-speed calibration (normalized units/s → ≈ km/h)
//
// The detector measures the dominant wrist's PEAK speed in MediaPipe
// normalized-frame units per second (see angles.ts: EMA-smoothed
// hypot(dx,dy)/dt on raw normalized coords). To turn that into a human number
// we calibrate against the player's real height: measure the SAME body in the
// SAME normalized space (nose → ankle-midpoint), then
//     scaleMeters (m per normalized unit) = heightM × NOSE_ANKLE_FRACTION / bodyLen
//     speedMps = peakWristSpeed × scaleMeters
//     kmh      = speedMps × 3.6
//
// ── ACCURACY — read before trusting the number ──────────────────────────────
//  • This is the player's HAND / WRIST speed, NOT ball speed. Low-double-digit
//    km/h is expected and legitimate — always show it with a "≈" prefix.
//  • ANISOTROPIC normalization: MediaPipe normalizes x by frame WIDTH and y by
//    frame HEIGHT. A swing is mostly horizontal (x); the body length we
//    calibrate on is mostly vertical (y). On portrait video these axes differ
//    by ~the aspect ratio, so the figure is approximate/relative, not a
//    metrologically accurate ±%. We measure body length with the exact same
//    hypot(dx,dy) convention as wristSpeed so the two are at least mutually
//    consistent — a pure function has no pixel dims to correct the anisotropy.
//  • EMA smoothing at ~15fps + 2D foreshortening UNDER-estimate the true peak;
//    anisotropy OVER-estimates horizontal motion. They partially offset.
//  • Guarded: when nose/ankles are low-visibility or out of frame, or the body
//    length is implausibly small, we return undefined (no estimate) rather than
//    a wrong guess. The UI shows nothing in that case.
//
// Pure math only — no DOM, no app imports beyond the Landmark type + LM indices.
// ============================================================================

import type { Landmark } from '../types';
import { LM } from '../types';

/** MediaPipe nose landmark index (not in the app's LM subset). */
const NOSE = 0;

/**
 * Fraction of full standing stature spanned by the nose → ankle-joint segment.
 * Anthropometric approximation: nose height ≈ 0.87 of stature, ankle joint ≈
 * 0.04 above the floor, so the visible nose→ankle span is ≈ 0.87 of height.
 * (Its exact value is noise next to the anisotropy caveat above.)
 */
export const NOSE_ANKLE_FRACTION = 0.87;

/** Player-height clamp (cm) — shared by the settings input and this module. */
export const HEIGHT_MIN_CM = 100;
export const HEIGHT_MAX_CM = 230;
export const DEFAULT_HEIGHT_CM = 170;

/**
 * PO-tunable km/h calibration multiplier. Because the normalized→km/h scale is
 * anisotropic and can read low (see caveat above), the user can calibrate the
 * magnitude live by comparing to a known reference. DEFAULT = 1.0 = NO change
 * (identity) so nobody ever sees a silent shift; clamped to a sane range.
 */
export const SPEED_FACTOR_MIN = 0.5;
export const SPEED_FACTOR_MAX = 3.0;
export const DEFAULT_SPEED_FACTOR = 1.0;

/** Clamp a speed-correction factor into [0.5, 3.0]; NaN/absent → 1.0 (identity). */
export function clampSpeedFactor(f: number | undefined | null): number {
  if (f == null || !Number.isFinite(f)) return DEFAULT_SPEED_FACTOR;
  return Math.min(SPEED_FACTOR_MAX, Math.max(SPEED_FACTOR_MIN, f));
}

/** Landmarks below this visibility are treated as not usable for calibration. */
const MIN_VISIBILITY = 0.5;

/**
 * Minimum plausible normalized body length. Below this the person is tiny/far
 * (or landmarks are noise) and the scale factor would explode → no estimate.
 */
const MIN_BODY_LENGTH = 0.15;

/** Clamp a height (cm) into the supported range; NaN/absent → default. */
export function clampHeightCm(cm: number | undefined | null): number {
  if (cm == null || !Number.isFinite(cm)) return DEFAULT_HEIGHT_CM;
  return Math.min(HEIGHT_MAX_CM, Math.max(HEIGHT_MIN_CM, cm));
}

function usable(lm: Landmark | undefined): lm is Landmark {
  return !!lm && (lm.visibility ?? 1) >= MIN_VISIBILITY;
}

/**
 * Normalized nose → ankle-midpoint distance (same hypot(dx,dy) convention as
 * wristSpeed). Returns undefined when nose or BOTH ankles are missing / low
 * visibility, or the span is implausibly small.
 */
export function normalizedBodyLength(landmarks: Landmark[] | null | undefined): number | undefined {
  if (!landmarks || landmarks.length === 0) return undefined;
  const nose = landmarks[NOSE];
  const la = landmarks[LM.LEFT_ANKLE];
  const ra = landmarks[LM.RIGHT_ANKLE];
  if (!usable(nose)) return undefined;

  // Ankle midpoint from whichever ankles are usable (need at least one).
  const ankles = [la, ra].filter(usable) as Landmark[];
  if (ankles.length === 0) return undefined;
  const ax = ankles.reduce((s, p) => s + p.x, 0) / ankles.length;
  const ay = ankles.reduce((s, p) => s + p.y, 0) / ankles.length;

  const len = Math.hypot(nose.x - ax, nose.y - ay);
  if (!Number.isFinite(len) || len < MIN_BODY_LENGTH) return undefined;
  return len;
}

/**
 * Convert a peak wrist speed (normalized units/s) to an APPROXIMATE swing speed
 * in km/h using the player's height and their body length in the frame. Returns
 * a rounded integer km/h, or undefined when calibration is not possible (out-of-
 * frame body, non-positive speed). Always display with a "≈" prefix.
 *
 * `correctionFactor` (default 1.0 = identity) is the PO-tunable calibration
 * multiplier applied here at compute time — the single place km/h is produced —
 * so every display site (gallery, History, export, coach prompt) reads the
 * already-corrected value. Clamped to [0.5, 3.0].
 */
export function estimateSpeedKmh(
  landmarks: Landmark[] | null | undefined,
  peakWristSpeed: number,
  heightCm: number | undefined | null,
  correctionFactor: number | undefined | null = DEFAULT_SPEED_FACTOR,
): number | undefined {
  if (!Number.isFinite(peakWristSpeed) || peakWristSpeed <= 0) return undefined;
  const bodyLen = normalizedBodyLength(landmarks);
  if (bodyLen === undefined) return undefined;

  const heightM = clampHeightCm(heightCm) / 100;
  const scaleMeters = (heightM * NOSE_ANKLE_FRACTION) / bodyLen; // m per unit
  const kmh = peakWristSpeed * scaleMeters * 3.6 * clampSpeedFactor(correctionFactor);
  if (!Number.isFinite(kmh) || kmh <= 0) return undefined;
  return Math.round(kmh);
}

/**
 * Localized "≈ 62 km/h" chip text. Returns '' when speed is undefined so
 * callers can render nothing without a branch.
 */
export function formatSpeedKmh(kmh: number | undefined, lang: 'th' | 'en'): string {
  if (kmh === undefined || !Number.isFinite(kmh)) return '';
  const unit = lang === 'th' ? 'กม./ชม.' : 'km/h';
  return `≈ ${Math.round(kmh)} ${unit}`;
}

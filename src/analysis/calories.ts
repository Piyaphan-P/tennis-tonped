// ============================================================================
// ADGE Tennis — calorie estimate (v1.8 session-stats widget)
//
// MET-based ESTIMATE of energy burned during a practice session. This is a
// rough approximation for motivation, NOT a medical/fitness measurement —
// always display it with a "≈" prefix.
//
//   kcal ≈ MET × weightKg × hours
//   hours = active session minutes / 60
//
// MET (Metabolic Equivalent of Task): the Compendium of Physical Activities
// lists "tennis, hitting balls, non-game play" at ≈ 5.0 METs. We use exactly
// that for ball-machine / drill practice (Phase 1). Game play would be higher
// (~7–8) — deliberately conservative here so the number never over-claims.
//
// Pure math only — no DOM, no app imports beyond the number-clamp helpers below.
// ============================================================================

/** MET for tennis practice (hitting balls, non-game). See header. */
export const TENNIS_PRACTICE_MET = 5.0;

/** Player-weight clamp (kg) — shared by the settings input and this module. */
export const WEIGHT_MIN_KG = 30;
export const WEIGHT_MAX_KG = 200;
export const DEFAULT_WEIGHT_KG = 65;

/** Clamp a body weight (kg) into the supported range; NaN/absent → default. */
export function clampWeightKg(kg: number | undefined | null): number {
  if (kg == null || !Number.isFinite(kg)) return DEFAULT_WEIGHT_KG;
  return Math.min(WEIGHT_MAX_KG, Math.max(WEIGHT_MIN_KG, kg));
}

/**
 * Estimate kcal burned over `durationMs` of tennis practice for a player of
 * `weightKg`. Returns a rounded integer ≥ 0. A non-positive / non-finite
 * duration yields 0. Weight is clamped to the sane range first.
 */
export function estimateCalories(durationMs: number, weightKg: number | undefined | null): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const hours = durationMs / 3_600_000; // ms → hours
  const kcal = TENNIS_PRACTICE_MET * clampWeightKg(weightKg) * hours;
  return Number.isFinite(kcal) && kcal > 0 ? Math.round(kcal) : 0;
}

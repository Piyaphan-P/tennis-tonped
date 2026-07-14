// ============================================================================
// ADGE Tennis — on-court DETECTION HUD
//
// THE on-court answer to "did it detect my swing, and if not, why not?". A
// compact translucent strip (same chip family as TelemetryStrip) mounted in
// .live-top, ALWAYS visible during Live — even before the first capture.
//
// It makes the two real-device failure modes visually distinct on court:
//   • phases advance but the shot counter never increments  → DETECTION problem
//     (the last-event line shows the reason + measured peak so you can SEE the
//      swing never tripped the contact gate)
//   • counter increments but no capture flash / thumbnail    → CAPTURE problem
//
// PERF CONTRACT (mirrors PoseCanvas): phase + detection counters come via
// normal deduped selectors, but wristSpeed updates ~30x/s — it is read through
// store.subscribe() with a ~150ms throttle into local state, NEVER a raw
// per-frame selector. `shots` is the STABLE ref (pushPoseFrame never touches
// it) used only to derive the newest capture for the flash.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import { SHOT_THRESHOLDS } from '../analysis/shotDetector';
import type { ShotPhase, SwingCapture } from '../types';

/** The 5 swing phases shown as the phase trail (idle is the resting state). */
const TRAIL: Array<{ phase: ShotPhase; key: I18nKey }> = [
  { phase: 'preparation', key: 'hud.phase.prep' },
  { phase: 'backswing', key: 'hud.phase.back' },
  { phase: 'forward-swing', key: 'hud.phase.fwd' },
  { phase: 'contact', key: 'hud.phase.contact' },
  { phase: 'follow-through', key: 'hud.phase.follow' },
];

const SPEED_THROTTLE_MS = 150;
const CONTACT_FLASH_MS = 600;
const CAPTURE_FLASH_MS = 1600;

export default function DetectionHud() {
  const t = useT();

  // Phase + counters: normal selectors (setPhase is deduped; detection counters
  // change only on markSwingStarted / pushDetectionEvent — never per frame).
  const phase = useAppStore((s) => s.pose.phase);
  const shotsCompleted = useAppStore((s) => s.detection.shotsCompleted);
  const swingsDiscarded = useAppStore((s) => s.detection.swingsDiscarded);
  const lastEvent = useAppStore((s) => s.detection.lastEvent);
  const shots = useAppStore((s) => s.shots); // stable ref (only addShot/addCapture mutate)

  // --- wristSpeed: throttled store.subscribe -> local state (never per-frame) ---
  const [wristSpeed, setWristSpeed] = useState(0);
  useEffect(() => {
    let last = 0;
    let shown = 0;
    return useAppStore.subscribe((state) => {
      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - last < SPEED_THROTTLE_MS) return;
      last = now;
      const v = state.pose.angles?.wristSpeed ?? 0;
      if (Math.abs(v - shown) < 0.05) return; // skip imperceptible churn
      shown = v;
      setWristSpeed(v);
    });
  }, []);

  // --- measured pose-loop fps (camera-vs-inference tuning instrument) ---
  // Counts store pose-frame commits over a 1s window via the same
  // store.subscribe pattern as wristSpeed (never a per-frame selector).
  // This is the ONE number that says whether a quality regression comes from
  // the camera (low fps everywhere) or inference load (fps sags on device).
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let windowStart =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    let lastFrame: unknown = null;
    return useAppStore.subscribe((state) => {
      if (state.pose.frame === lastFrame) return;
      lastFrame = state.pose.frame;
      frames += 1;
      const now =
        typeof performance !== 'undefined' ? performance.now() : Date.now();
      const elapsed = now - windowStart;
      if (elapsed >= 1000) {
        setFps(Math.round((frames * 1000) / elapsed));
        frames = 0;
        windowStart = now;
      }
    });
  }, []);

  // --- contact segment flashes green for ~600ms when reached ---
  const [contactFlash, setContactFlash] = useState(false);
  useEffect(() => {
    if (phase !== 'contact') return;
    setContactFlash(true);
    const id = setTimeout(() => setContactFlash(false), CONTACT_FLASH_MS);
    return () => clearTimeout(id);
  }, [phase]);

  // --- capture flash: newest capture -> 44px thumbnail glow for ~1.5s ---
  const newestCapture = useMemo<SwingCapture | undefined>(() => {
    for (let i = shots.length - 1; i >= 0; i--) {
      const caps = shots[i].captures;
      if (caps.length > 0) return caps[caps.length - 1];
    }
    return undefined;
  }, [shots]);
  const [flash, setFlash] = useState<SwingCapture | null>(null);
  const seenId = useRef<string | undefined>(newestCapture?.id);
  useEffect(() => {
    if (!newestCapture || newestCapture.id === seenId.current) return;
    seenId.current = newestCapture.id;
    setFlash(newestCapture);
    const id = setTimeout(() => setFlash(null), CAPTURE_FLASH_MS);
    return () => clearTimeout(id);
  }, [newestCapture]);

  // --- last-event line: the on-court "did it detect, and why not" answer ---
  const eventText = useMemo(() => {
    if (!lastEvent) return '';
    const fmt = (key: I18nKey, vars: Record<string, string | number>): string =>
      Object.entries(vars).reduce(
        (str, [k, v]) => str.replace(`{${k}}`, String(v)),
        t(key),
      );
    const peak = lastEvent.peakWristSpeed.toFixed(1);
    if (lastEvent.kind === 'shot-completed') {
      return fmt('hud.completed', { n: lastEvent.shotIndex, peak });
    }
    const ms = Math.round(lastEvent.durationMs);
    const key: I18nKey =
      lastEvent.reason === 'too-short'
        ? 'hud.discard.tooShort'
        : lastEvent.reason === 'too-long'
          ? 'hud.discard.tooLong'
          : lastEvent.reason === 'cooldown'
            ? 'hud.discard.cooldown'
            : lastEvent.reason === 'coach-speaking'
              ? 'hud.discard.coachSpeaking'
              : 'hud.discard.noContact';
    return fmt(key, { peak, ms });
    // t is stable per-render; recompute only when the event changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent, t]);
  const eventGood = lastEvent?.kind === 'shot-completed';

  // Mini-bar scaled to the contact gate so the player SEES whether their swing
  // even approaches the threshold that produces a shot.
  const gate = SHOT_THRESHOLDS.contactMinPeakSpeed;
  const barPct = Math.max(0, Math.min(1, wristSpeed / gate)) * 100;
  const atGate = wristSpeed >= gate;

  return (
    <div className="dhud" aria-label="detection">
      <div className="dhud-main">
        {/* (a) PHASE TRAIL */}
        <div className="dhud-trail" role="group">
          {TRAIL.map((seg) => {
            const active = phase === seg.phase;
            const flashing = seg.phase === 'contact' && contactFlash;
            return (
              <span
                key={seg.phase}
                className={
                  'dhud-seg' +
                  (active ? ' dhud-seg-on' : '') +
                  (flashing ? ' dhud-seg-hit' : '')
                }
              >
                {t(seg.key)}
              </span>
            );
          })}
        </div>

        {/* (b) LIVE SPEED + mini-bar vs contact gate */}
        <div className="dhud-speed" title={`gate ${gate.toFixed(1)}`}>
          <span className="dhud-speed-label">{t('hud.speed')}</span>
          <span className="dhud-speed-val num">{wristSpeed.toFixed(1)}</span>
          <span className="dhud-bar">
            <i
              className={atGate ? 'dhud-bar-fill dhud-bar-full' : 'dhud-bar-fill'}
              style={{ width: `${barPct}%` }}
            />
          </span>
        </div>

        {/* (c) SHOT COUNTER (+ dim discarded) + measured pose fps */}
        <div className="dhud-count num">
          <span className="dhud-count-shots">
            {t('hud.shots')} {shotsCompleted}
          </span>
          <span className="dim" title={t('hud.fps')}>
            {fps} {t('hud.fps')}
          </span>
          {swingsDiscarded > 0 && (
            <span className="dhud-count-skip dim">
              {t('hud.skip')} {swingsDiscarded}
            </span>
          )}
        </div>
      </div>

      {/* (d) LAST EVENT LINE */}
      {eventText && (
        <div className={'dhud-event num' + (eventGood ? ' dhud-event-good' : '')}>
          {eventText}
        </div>
      )}

      {/* (e) CAPTURE FLASH */}
      {flash && (
        <div className="dhud-flash">
          <img
            className="dhud-flash-thumb"
            src={`data:image/jpeg;base64,${flash.jpegBase64}`}
            alt={t('hud.captured')}
          />
          <span className="dhud-flash-label">{t('hud.captured')}</span>
        </div>
      )}
    </div>
  );
}

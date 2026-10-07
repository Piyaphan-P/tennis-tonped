// ============================================================================
// ADGE Tennis — MicControl
//
// Replaces the old press-and-hold "Ask Coach" button. The mic is ALWAYS-ON by
// default (Gemini server-side VAD handles turn-taking), so this is just a
// hands-free on/off toggle plus a live "listening" level meter — NOT a
// push-to-talk control.
//
//   • tap → coachLive.setMicEnabled(!micOn)
//   • label reflects state: micOff / micOn / listening
//   • a 5-bar meter animates with coach.micLevel while streaming
//   • visually muted while the connection is not 'connected'
//
// Self-contained: base pill uses the shared .chip/.tap classes; everything
// else is inline styles with token fallbacks (theme.css is owned elsewhere).
// Selectors are intentionally narrow so per-frame-ish micLevel updates only
// re-render this small widget.
// ============================================================================

import { useAppStore } from '../store';
import { useT } from '../i18n';
import { coachLive } from '../coach/liveClient';

/** Rising per-bar thresholds tuned for voice RMS levels (0..1, EMA-smoothed). */
const BAR_THRESHOLDS = [0.02, 0.05, 0.09, 0.14, 0.2];
/** Relative heights of the 5 meter bars. */
const BAR_HEIGHTS = [8, 12, 16, 12, 8];

/** Compact mic glyph (inherits currentColor). */
function MicGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

/** Mic-off glyph (mic with a slash). */
function MicOffGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 9v-3a3 3 0 0 1 5.12-2.12" />
      <path d="M15 11.34V13a3 3 0 0 1-4.24 2.74" />
      <path d="M5 11a7 7 0 0 0 10.9 5.8" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

/** Always-on mic toggle + listening level meter. */
export default function MicControl() {
  const t = useT();
  const micOn = useAppStore((s) => s.coach.micOn);
  const listening = useAppStore((s) => s.coach.listening);
  const micLevel = useAppStore((s) => s.coach.micLevel);
  const connected = useAppStore((s) => s.connection === 'connected');

  const label = t(micOn ? (listening ? 'live.listening' : 'live.micOn') : 'live.micOff');

  // Bars only respond when the mic is actually streaming (listening).
  const active = micOn && listening;

  return (
    <button
      type="button"
      className="chip tap"
      onClick={() => void coachLive.setMicEnabled(!micOn)}
      aria-pressed={micOn}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        padding: '0 14px',
        borderRadius: 999,
        border: `1px solid ${micOn ? 'var(--accent, #d6f441)' : 'var(--line, rgba(255,255,255,0.12))'}`,
        background: micOn
          ? 'color-mix(in srgb, var(--accent, #d6f441) 12%, transparent)'
          : 'var(--surface, #0e181a)',
        color: micOn ? 'var(--accent, #d6f441)' : 'var(--text-dim, #9fb0ad)',
        cursor: 'pointer',
        opacity: connected ? 1 : 0.45,
        transition: 'opacity 120ms ease, border-color 120ms ease',
      }}
    >
      {micOn ? <MicGlyph /> : <MicOffGlyph />}
      <span
        style={{
          fontSize: '0.8rem',
          fontWeight: 700,
          whiteSpace: 'nowrap',
          letterSpacing: '0.01em',
        }}
      >
        {label}
      </span>
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'flex-end',
          gap: 2,
          height: 16,
          marginLeft: 2,
        }}
      >
        {BAR_THRESHOLDS.map((threshold, i) => {
          const lit = active && micLevel >= threshold;
          return (
            <span
              key={i}
              style={{
                display: 'block',
                width: 3,
                height: BAR_HEIGHTS[i],
                borderRadius: 2,
                background: lit ? 'var(--accent, #d6f441)' : 'var(--line, rgba(255,255,255,0.12))',
                transition: 'background 90ms linear',
              }}
            />
          );
        })}
      </span>
    </button>
  );
}

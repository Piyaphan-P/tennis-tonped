import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';

/** Shows the current swing phase from the pose state machine. */
export default function PhaseChip() {
  const phase = useAppStore((s) => s.pose.phase);
  const t = useT();
  const key = (`phase.${phase}` as I18nKey);
  const active = phase !== 'idle';
  return (
    <span
      className="chip"
      style={{
        borderColor: active ? 'var(--accent)' : 'var(--line)',
        color: active ? 'var(--accent)' : 'var(--text-dim)',
      }}
    >
      {t(key)}
    </span>
  );
}

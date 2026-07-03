import { useAppStore, selectShotCount } from '../store';
import { useT } from '../i18n';

/** Mono, tabular-nums telemetry: fps, shots, angles. */
export default function TelemetryStrip() {
  const fps = useAppStore((s) => s.pose.fps);
  const shots = useAppStore(selectShotCount);
  const angles = useAppStore((s) => s.pose.angles);
  const dominantHand = useAppStore((s) => s.settings.dominantHand);
  const t = useT();

  const dominantElbow = angles
    ? Math.round(dominantHand === 'left' ? angles.leftElbowDeg : angles.rightElbowDeg)
    : 0;

  return (
    <div className="telemetry">
      <span>
        {t('live.fps')} <b>{fps.toFixed(0)}</b>
      </span>
      <span>
        {t('live.shots')} <b>{shots}</b>
      </span>
      <span>
        elbow <b>{dominantElbow}°</b>
      </span>
    </div>
  );
}

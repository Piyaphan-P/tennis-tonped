import { useAppStore, selectLatestShot } from '../store';
import { useT } from '../i18n';

/**
 * THE HERO of the Live screen: a big lower-third card showing the coach's
 * latest spoken correction in large, readable type (updates only after a swing
 * completes — liveClient never sends mid-swing). Shows a "thinking" pulse while
 * a coaching turn is in flight, and a "listening" state during push-to-talk.
 */
export default function CoachBubble() {
  const bubbleText = useAppStore((s) => s.coach.bubbleText);
  const speaking = useAppStore((s) => s.coach.speaking);
  const listening = useAppStore((s) => s.coach.listening);
  const latest = useAppStore(selectLatestShot);
  const t = useT();

  // A turn is "in flight" when the newest shot has landed but neither its
  // transcript nor its coaching has arrived yet (no dedicated store flag —
  // approximated from stable signals).
  const thinking = !listening && !bubbleText && !!latest && !latest.coaching;

  if (!bubbleText && !speaking && !listening && !thinking) return null;

  return (
    <div className="coach-hero" aria-live="polite">
      <div className="coach-hero-head">
        <span className="brand-dot" aria-hidden />
        <span className="coach-hero-name">{t('brand.coach')}</span>
        {speaking && (
          <span className="coach-wave" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
      {listening ? (
        <span className="coach-hero-status">{t('live.listening')}</span>
      ) : thinking ? (
        <span className="coach-hero-status coach-pulse">{t('coach.thinking')}</span>
      ) : (
        <span className="coach-hero-text">{bubbleText}</span>
      )}
    </div>
  );
}

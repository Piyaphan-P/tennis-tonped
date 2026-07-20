import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import { audioPlayer } from '../coach/audioPlayer';
import BrandMark from '../components/BrandMark';
import LangToggle from '../components/LangToggle';
import StatsCard from '../components/StatsCard';
import HistoryList from '../components/HistoryList';
import type { CoachMode, FocusShot, VoiceTone } from '../types';

const FOCUS_OPTIONS: Array<{ value: FocusShot; labelKey: I18nKey }> = [
  { value: 'forehand', labelKey: 'home.forehand' },
  { value: 'backhand', labelKey: 'home.backhand' },
  { value: 'both', labelKey: 'home.both' },
];

const VOICE_TONE_OPTIONS: Array<{ value: VoiceTone; labelKey: I18nKey }> = [
  { value: 'gentleF', labelKey: 'home.voiceTone.gentleF' },
  { value: 'firmF', labelKey: 'home.voiceTone.firmF' },
  { value: 'firmM', labelKey: 'home.voiceTone.firmM' },
  { value: 'friendlyM', labelKey: 'home.voiceTone.friendlyM' },
];

const COACH_MODE_OPTIONS: Array<{ value: CoachMode; labelKey: I18nKey }> = [
  { value: 'encourage', labelKey: 'home.coachMode.encourage' },
  { value: 'hardcore', labelKey: 'home.coachMode.hardcore' },
  { value: 'polite', labelKey: 'home.coachMode.polite' },
  { value: 'buddy', labelKey: 'home.coachMode.buddy' },
];

/** Landing screen: brand, session setup, start CTA, stats + history. */
export default function HomeScreen() {
  const t = useT();
  const setScreen = useAppStore((s) => s.setScreen);
  const startSession = useAppStore((s) => s.startSession);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setUserName = useAppStore((s) => s.setUserName);
  const setVoiceTone = useAppStore((s) => s.setVoiceTone);
  const setCoachMode = useAppStore((s) => s.setCoachMode);

  const start = () => {
    // Unlock the AudioContext INSIDE this tap gesture so iOS Safari will play
    // the coach's voice later (the async Live mount would lose the gesture).
    void audioPlayer.unlock();
    startSession();
    setScreen('live');
  };

  return (
    <div className="screen">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <BrandMark />
        <LangToggle />
      </div>

      <div className="col" style={{ gap: 8, marginTop: 8 }}>
        <p className="dim">{t('home.tagline')}</p>
      </div>

      {/* --- dominant hand: prominent, must be explicit before playing --- */}
      <div className="card col" style={{ gap: 8 }}>
        <h3>{t('home.handedness.title')}</h3>
        <div className="row" style={{ gap: 8 }}>
          <button
            className={`btn tap${settings.dominantHand === 'right' ? ' btn-primary' : ' btn-ghost'}`}
            style={{ flex: 1, fontSize: '1.05rem', padding: '14px 8px' }}
            onClick={() => updateSettings({ dominantHand: 'right' })}
            aria-pressed={settings.dominantHand === 'right'}
          >
            {t('home.handedness.right')}
          </button>
          <button
            className={`btn tap${settings.dominantHand === 'left' ? ' btn-primary' : ' btn-ghost'}`}
            style={{ flex: 1, fontSize: '1.05rem', padding: '14px 8px' }}
            onClick={() => updateSettings({ dominantHand: 'left' })}
            aria-pressed={settings.dominantHand === 'left'}
          >
            {t('home.handedness.left')}
          </button>
        </div>
        <span className="faint" style={{ fontSize: '0.75rem' }}>
          {t('home.handedness.explainer')}
        </span>
      </div>

      {/* --- session setup --- */}
      <div className="card col" style={{ gap: 'var(--sp-4)' }}>
        <h3>{t('home.setup')}</h3>

        <div className="col" style={{ gap: 6 }}>
          <span className="dim" style={{ fontSize: '0.85rem' }}>
            {t('home.focusShot')}
          </span>
          <div className="segmented">
            {FOCUS_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`seg tap${settings.focusShot === o.value ? ' active' : ''}`}
                onClick={() => updateSettings({ focusShot: o.value })}
              >
                {t(o.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="col" style={{ gap: 6 }}>
          <span className="dim" style={{ fontSize: '0.85rem' }}>
            {t('home.yourName')}
          </span>
          <input
            type="text"
            autoComplete="off"
            maxLength={40}
            placeholder={t('home.namePlaceholder')}
            value={settings.userName}
            onChange={(e) => setUserName(e.target.value)}
          />
          <span className="faint" style={{ fontSize: '0.75rem' }}>
            {t('home.nameHint')}
          </span>
        </div>
      </div>

      {/* --- coach voice tone --- */}
      <div className="card col" style={{ gap: 8 }}>
        <h3>{t('home.voiceTone.title')}</h3>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {VOICE_TONE_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`btn tap${settings.voiceTone === o.value ? ' btn-primary' : ' btn-ghost'}`}
              style={{ flex: '1 1 40%', padding: '12px 8px' }}
              onClick={() => setVoiceTone(o.value)}
              aria-pressed={settings.voiceTone === o.value}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* --- coach mode / style --- */}
      <div className="card col" style={{ gap: 8 }}>
        <h3>{t('home.coachMode.title')}</h3>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {COACH_MODE_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`btn tap${settings.coachMode === o.value ? ' btn-primary' : ' btn-ghost'}`}
              style={{ flex: '1 1 40%', padding: '12px 8px' }}
              onClick={() => setCoachMode(o.value)}
              aria-pressed={settings.coachMode === o.value}
            >
              {t(o.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="col">
        <button className="btn btn-primary btn-block" onClick={start}>
          {t('home.start')}
        </button>
        <p className="faint" style={{ fontSize: '0.85rem', textAlign: 'center' }}>
          {t('home.subtitle')}
        </p>
        <p className="dim" style={{ fontSize: '0.8rem', textAlign: 'center' }}>
          {t('home.handedness.current')}:{' '}
          {settings.dominantHand === 'right'
            ? t('home.handedness.right')
            : t('home.handedness.left')}
        </p>
      </div>

      <StatsCard />
      <HistoryList />

      <div className="spacer" />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn btn-ghost" onClick={() => setScreen('devplan')}>
          {t('home.devplan')}
        </button>
        <button className="btn btn-ghost" onClick={() => setSettingsOpen(true)}>
          {t('home.settings')}
        </button>
      </div>
    </div>
  );
}

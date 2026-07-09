import { useState } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import { audioPlayer } from '../coach/audioPlayer';
import BrandMark from '../components/BrandMark';
import LangToggle from '../components/LangToggle';
import StatsCard from '../components/StatsCard';
import HistoryList from '../components/HistoryList';
import type { FocusShot } from '../types';

const FOCUS_OPTIONS: Array<{ value: FocusShot; labelKey: I18nKey }> = [
  { value: 'forehand', labelKey: 'home.forehand' },
  { value: 'backhand', labelKey: 'home.backhand' },
  { value: 'both', labelKey: 'home.both' },
];

/**
 * True when the backend provisions the coach automatically (prod/SIT): the
 * `/api/token` mint endpoint is baked in, or the app talks to the same-origin
 * relay. In that case the pasted-token field is a dev/fallback only — the start
 * flow must never gate on it and we suppress the "token missing" alarm.
 */
export function coachAutoProvisioned(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    return !!env?.VITE_TOKEN_ENDPOINT || env?.VITE_LIVE_TRANSPORT === 'relay';
  } catch {
    return false;
  }
}

/** Landing screen: brand, session setup, start CTA, stats + history. */
export default function HomeScreen() {
  const t = useT();
  const setScreen = useAppStore((s) => s.setScreen);
  const startSession = useAppStore((s) => s.startSession);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setUserName = useAppStore((s) => s.setUserName);
  const authToken = useAppStore((s) => s.authToken);

  const [tokenBannerDismissed, setTokenBannerDismissed] = useState(false);
  // Only nag about a missing token when the coach is NOT auto-provisioned
  // (pure local dev with no /api/token endpoint and no relay). On prod/SIT the
  // backend mints the token, so a missing pasted token is a non-issue.
  const showTokenBanner = !authToken && !coachAutoProvisioned() && !tokenBannerDismissed;

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

      {/* --- bilingual coach-token-missing warning (session still allowed) --- */}
      {showTokenBanner && (
        <div
          className="card col"
          role="alert"
          style={{ gap: 8, borderColor: 'var(--warn)' }}
        >
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <h3 style={{ color: 'var(--warn)' }}>{t('error.tokenMissing.title')}</h3>
            <button
              className="btn-ghost tap"
              aria-label={t('common.close')}
              onClick={() => setTokenBannerDismissed(true)}
              style={{ border: 0, background: 'transparent', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1, padding: 4 }}
            >
              ×
            </button>
          </div>
          <p className="dim" style={{ fontSize: '0.85rem' }}>
            {t('error.tokenMissing.body')}
          </p>
          <button className="btn btn-ghost" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }} onClick={() => setSettingsOpen(true)}>
            {t('home.settings')}
          </button>
        </div>
      )}

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

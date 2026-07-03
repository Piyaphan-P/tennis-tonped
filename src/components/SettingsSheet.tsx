import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { PricingRates } from '../types';

/** Bottom-sheet settings: pricing rates, session prefs, and coach token. */
export default function SettingsSheet() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const updateRates = useAppStore((s) => s.updateRates);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const authToken = useAppStore((s) => s.authToken);
  const setAuthToken = useAppStore((s) => s.setAuthToken);
  const t = useT();

  if (!open) return null;

  const rateField = (key: keyof PricingRates, labelKey: Parameters<typeof t>[0]) => (
    <label className="col" style={{ gap: 4 }}>
      <span className="dim" style={{ fontSize: '0.85rem' }}>
        {t(labelKey)}
      </span>
      <input
        type="number"
        step="0.1"
        min="0"
        value={settings.rates[key]}
        onChange={(e) => updateRates({ [key]: Number(e.target.value) } as Partial<PricingRates>)}
      />
    </label>
  );

  const tokenValid = authToken.startsWith('AQ.');

  return (
    <div className="sheet-backdrop" onClick={() => setOpen(false)}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2>{t('settings.title')}</h2>
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>
            {t('common.close')}
          </button>
        </div>

        {/* --- coach token --- */}
        <h3 style={{ marginBottom: 8 }}>{t('settings.session')}</h3>
        <label className="col" style={{ gap: 4, marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="dim" style={{ fontSize: '0.85rem' }}>
              {t('settings.token')}
            </span>
            <span
              className="faint"
              style={{ fontSize: '0.75rem', color: tokenValid ? 'var(--good)' : 'var(--warn)' }}
            >
              {tokenValid ? t('settings.tokenSet') : t('settings.tokenNone')}
            </span>
          </div>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="AQ.…"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
          />
          <span className="faint" style={{ fontSize: '0.75rem' }}>
            {t('settings.tokenHint')}
          </span>
        </label>

        {/* --- dominant hand --- */}
        <label className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <span>{t('settings.dominantHand')}</span>
          <div className="segmented" style={{ width: 'auto' }}>
            <button
              className={`seg tap${settings.dominantHand === 'left' ? ' active' : ''}`}
              onClick={() => updateSettings({ dominantHand: 'left' })}
            >
              {t('settings.handLeft')}
            </button>
            <button
              className={`seg tap${settings.dominantHand === 'right' ? ' active' : ''}`}
              onClick={() => updateSettings({ dominantHand: 'right' })}
            >
              {t('settings.handRight')}
            </button>
          </div>
        </label>

        {/* --- camera --- */}
        <label className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <span>{t('settings.camera')}</span>
          <div className="segmented" style={{ width: 'auto' }}>
            <button
              className={`seg tap${settings.cameraFacing === 'user' ? ' active' : ''}`}
              onClick={() => updateSettings({ cameraFacing: 'user' })}
            >
              {t('settings.cameraUser')}
            </button>
            <button
              className={`seg tap${settings.cameraFacing === 'environment' ? ' active' : ''}`}
              onClick={() => updateSettings({ cameraFacing: 'environment' })}
            >
              {t('settings.cameraEnv')}
            </button>
          </div>
        </label>

        <div className="col" style={{ marginBottom: 16 }}>
          <label className="row" style={{ justifyContent: 'space-between' }}>
            <span>{t('settings.sendFrame')}</span>
            <input
              type="checkbox"
              checked={settings.sendContactFrame}
              onChange={(e) => updateSettings({ sendContactFrame: e.target.checked })}
            />
          </label>
          <label className="row" style={{ justifyContent: 'space-between' }}>
            <span>{t('settings.coachVoice')}</span>
            <input
              type="checkbox"
              checked={settings.coachVoiceOn}
              onChange={(e) => updateSettings({ coachVoiceOn: e.target.checked })}
            />
          </label>
        </div>

        {/* --- pricing --- */}
        <h3 style={{ marginBottom: 8 }}>{t('settings.pricing')}</h3>
        <div className="col">
          {rateField('textInPer1M', 'settings.textIn')}
          {rateField('audioInPer1M', 'settings.audioIn')}
          {rateField('videoInPer1M', 'settings.videoIn')}
          {rateField('textOutPer1M', 'settings.textOut')}
          {rateField('audioOutPer1M', 'settings.audioOut')}
          {rateField('usdToThb', 'settings.usdToThb')}
        </div>
      </div>
    </div>
  );
}

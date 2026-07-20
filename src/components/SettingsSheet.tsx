import { useAppStore } from '../store';
import { useT } from '../i18n';
import * as api from '../data/api';
import type { PricingRates } from '../types';

/** Bottom-sheet settings: pricing rates and session prefs. (The manual coach
 *  token field was removed 2026-07-20 — the key is auto-provisioned server-side.
 *  store.authToken plumbing stays intact for liveClient/dev flows.) */
export default function SettingsSheet() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const updateRates = useAppStore((s) => s.updateRates);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
  const setScreen = useAppStore((s) => s.setScreen);
  const t = useT();

  if (!open) return null;

  /** Log out (players' only exit; admins also have one on AdminScreen). */
  async function handleLogout() {
    await api.logout();
    setOpen(false);
    setScreen('home');
    setAuth(null); // LoginGate reappears
  }

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

  return (
    <div className="sheet-backdrop" onClick={() => setOpen(false)}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2>{t('settings.title')}</h2>
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>
            {t('common.close')}
          </button>
        </div>

        {/* --- session prefs (coach token field removed — auto-provisioned) --- */}
        <h3 style={{ marginBottom: 8 }}>{t('settings.session')}</h3>

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

        {/* --- player height (calibrates swing speed → km/h) --- */}
        <label className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <span>{t('settings.playerHeight')}</span>
          <input
            type="number"
            inputMode="numeric"
            min={100}
            max={230}
            step={1}
            style={{ width: 92, textAlign: 'right' }}
            value={settings.playerHeightCm}
            onChange={(e) => {
              // Loose while typing (don't fight intermediate values like "1"→"17");
              // the hard 100–230 clamp lands on blur (and estimateSpeedKmh + the
              // store default both re-clamp as a safety net).
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n > 0) updateSettings({ playerHeightCm: n });
            }}
            onBlur={() =>
              updateSettings({
                playerHeightCm: Math.min(230, Math.max(100, settings.playerHeightCm)),
              })
            }
          />
        </label>

        {/* --- swing-speed calibration (× multiplier on km/h, PO-tunable) --- */}
        <label className="col" style={{ gap: 4, marginBottom: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>{t('settings.speedFactor')}</span>
            <input
              type="number"
              inputMode="decimal"
              min={0.5}
              max={3}
              step={0.05}
              style={{ width: 92, textAlign: 'right' }}
              value={settings.speedCorrectionFactor}
              onChange={(e) => {
                // Loose while typing; clampSpeedFactor (in the store setter) lands
                // the hard 0.5–3.0 clamp so a stray value can't poison the display.
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) updateSettings({ speedCorrectionFactor: n });
              }}
              onBlur={() =>
                updateSettings({
                  speedCorrectionFactor: Math.min(3, Math.max(0.5, settings.speedCorrectionFactor)),
                })
              }
            />
          </div>
          <span className="dim" style={{ fontSize: '0.8rem' }}>
            {t('settings.speedFactorHint')}
          </span>
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

        {/* --- account (UAM v1.5) — only when signed in via the gate --- */}
        {auth && (
          <>
            <h3 style={{ margin: '16px 0 8px' }}>{t('settings.account')}</h3>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span
                className="dim"
                style={{
                  fontSize: '0.85rem',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {auth.email}
              </span>
              <button className="btn btn-ghost tap" onClick={handleLogout}>
                {t('settings.logout')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import * as api from '../data/api';
import BrandMark from './BrandMark';

// ============================================================================
// LoginGate — per-user email+password gate in front of the whole app (UAM v1.5).
// On mount it probes GET /api/gate:
//   200 {email,role,…} → already signed in (cookie) → store auth → render app
//   401                → show the login form; POST /api/login sets the cookie
//   404 / network      → server has no gate (e.g. `npm run dev` without backend)
//                        → FAIL OPEN so local dev keeps working (auth stays null)
// The cookie is httpOnly + 90 days, so a device logs in once. Logout anywhere
// (SettingsSheet / AdminScreen) clears store.auth → the form reappears here.
// ============================================================================

/** Which error copy to show; serverMsg overrides only for unknown codes. */
interface LoginError {
  key: 'login.wrong' | 'login.tooMany' | 'login.error';
  serverMsg?: string;
}

export default function LoginGate({ children }: { children: ReactNode }) {
  const t = useT();
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
  const [checking, setChecking] = useState(true);
  /** True once /api/gate proved a gate exists (401 or a contract 200). */
  const [gateExists, setGateExists] = useState(false);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const gate = await api.fetchGate();
      if (cancelled) return;
      if (gate.status === 'authed') {
        setGateExists(true);
        setAuth(gate.user);
      } else {
        setGateExists(gate.status === 'unauthed');
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [setAuth]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await api.login(email.trim().toLowerCase(), pass);
    if (res.ok) {
      setAuth(res.user);
    } else if (res.error === 'bad_credentials') {
      setError({ key: 'login.wrong' });
    } else if (res.error === 'too_many_attempts') {
      setError({ key: 'login.tooMany' });
    } else {
      // 503 / unexpected: prefer the server's bilingual message when present.
      setError({ key: 'login.error', serverMsg: res.message });
    }
    setBusy(false);
  }

  // Open when: still no proven gate (dev fail-open) OR signed in.
  if (!checking && (!gateExists || auth)) return <>{children}</>;

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        padding: 24,
        background: 'var(--bg)',
      }}
    >
      <BrandMark />
      {checking ? (
        <p style={{ color: 'var(--text-dim)' }}>{t('login.checking')}</p>
      ) : (
        <form
          onSubmit={submit}
          style={{
            width: 'min(360px, 100%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            background: 'var(--surface)',
            border: '1px solid var(--surface-2)',
            borderRadius: 16,
            padding: 24,
          }}
        >
          <h1 style={{ fontSize: '1.15rem', margin: 0 }}>{t('login.title')}</h1>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', margin: 0 }}>{t('login.subtitle')}</p>
          <input
            type="text"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('login.email')}
            aria-label={t('login.email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder={t('login.pass')}
            aria-label={t('login.pass')}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          {error && (
            <p role="alert" style={{ color: 'var(--fault)', fontSize: '0.85rem', margin: 0 }}>
              {error.serverMsg ?? t(error.key)}
            </p>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy || !email || !pass}>
            {busy ? t('login.checking') : t('login.submit')}
          </button>
        </form>
      )}
    </div>
  );
}

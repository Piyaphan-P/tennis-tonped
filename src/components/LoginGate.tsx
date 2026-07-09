import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import BrandMark from './BrandMark';

// ============================================================================
// LoginGate — shared-credential gate in front of the whole app (SIT).
// On mount it probes GET /api/gate:
//   200            → already authorized (cookie) → render the app
//   401            → show the login form; POST /api/login sets the cookie
//   404 / network  → server has no gate (e.g. `npm run dev` without backend)
//                    → FAIL OPEN so local dev keeps working
// The cookie is httpOnly + 90 days, so a device logs in once.
// ============================================================================

type GateState = 'checking' | 'locked' | 'open';

export default function LoginGate({ children }: { children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<GateState>('checking');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'wrong' | 'network' | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/gate', { credentials: 'same-origin' });
        if (cancelled) return;
        setState(res.status === 401 ? 'locked' : 'open');
      } catch {
        if (!cancelled) setState('open'); // no backend (dev) → fail open
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ user: user.trim(), pass }),
      });
      if (res.ok) {
        setState('open');
      } else {
        setError('wrong');
      }
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'open') return <>{children}</>;

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
      {state === 'checking' ? (
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
            autoComplete="username"
            autoCapitalize="none"
            placeholder={t('login.user')}
            aria-label={t('login.user')}
            value={user}
            onChange={(e) => setUser(e.target.value)}
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
              {t(error === 'wrong' ? 'login.wrong' : 'login.error')}
            </p>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy || !user || !pass}>
            {busy ? t('login.checking') : t('login.submit')}
          </button>
        </form>
      )}
    </div>
  );
}

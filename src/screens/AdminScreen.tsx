// ============================================================================
// ADGE Tennis — Admin screen (UAM v1.5). Rendered ONLY for auth.role='admin'
// (App.tsx + BottomNav gate it; the server 403s /api/users for players anyway).
// Player management: list / add / reset password / enable-disable / delete.
// All calls go through data/api auth helpers (never throw, never touch the
// cloud offline latch).
// ============================================================================

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import * as api from '../data/api';
import { formatTHB, formatTokens } from '../cost/pricing';
import type { AdminUserRow } from '../types';
import './admin.css';

/** Client-side mirrors of the server's invalid_input rules. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASS_LEN = 4;

interface Msg {
  kind: 'ok' | 'err';
  key: I18nKey;
  /** Server-provided fallback copy for unknown errors. */
  serverMsg?: string;
}

/** Map a mutation failure to bilingual copy (server message as fallback). */
function msgOf(res: api.AuthFailure): Msg {
  if (res.error === 'user_exists') return { kind: 'err', key: 'admin.errUserExists' };
  return { kind: 'err', key: 'admin.errFailed', serverMsg: res.message };
}

export default function AdminScreen() {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
  const setScreen = useAppStore((s) => s.setScreen);

  const [users, setUsers] = useState<AdminUserRow[] | null | undefined>(undefined);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  // undefined = loading, null = load failed, else the report (same pattern as users).
  const [usage, setUsage] = useState<api.UsageReport | null | undefined>(undefined);

  // --- add-player form ---
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [displayName, setDisplayName] = useState('');

  const reload = useCallback(() => {
    setUsers(undefined);
    api.listUsers().then(setUsers);
  }, []);

  const reloadUsage = useCallback(() => {
    setUsage(undefined);
    api.fetchUsage().then(setUsage);
  }, []);

  useEffect(() => {
    reload();
    reloadUsage();
  }, [reload, reloadUsage]);

  /** Run one mutation, surface its result, refresh the list on success. */
  async function run(action: () => Promise<api.UserMutationResult>, okKey: I18nKey) {
    if (busy) return false;
    setBusy(true);
    setMsg(null);
    const res = await action();
    setMsg(res.ok ? { kind: 'ok', key: okKey } : msgOf(res));
    setBusy(false);
    if (res.ok) reload();
    return res.ok;
  }

  async function addPlayer(e: FormEvent) {
    e.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    // Client-side validation mirrors the server's invalid_input rules.
    if (!EMAIL_RE.test(cleanEmail)) {
      setMsg({ kind: 'err', key: 'admin.errInvalidEmail' });
      return;
    }
    if (pass.length < MIN_PASS_LEN) {
      setMsg({ kind: 'err', key: 'admin.errPassShort' });
      return;
    }
    const name = displayName.trim();
    const ok = await run(
      () => api.createUser({ email: cleanEmail, password: pass, ...(name ? { displayName: name } : {}) }),
      'admin.added',
    );
    if (ok) {
      setEmail('');
      setPass('');
      setDisplayName('');
    }
  }

  function resetPassword(u: AdminUserRow) {
    const entered = window.prompt(t('admin.resetPrompt').replace('{email}', u.email));
    if (entered == null) return; // cancelled
    if (entered.length < MIN_PASS_LEN) {
      setMsg({ kind: 'err', key: 'admin.errPassShort' });
      return;
    }
    void run(() => api.patchUser(u.email, { password: entered }), 'admin.updated');
  }

  function toggleDisabled(u: AdminUserRow) {
    void run(() => api.patchUser(u.email, { disabled: !u.disabled }), 'admin.updated');
  }

  function deletePlayer(u: AdminUserRow) {
    if (!window.confirm(t('admin.deleteConfirm').replace('{email}', u.email))) return;
    void run(() => api.deleteUser(u.email), 'admin.deleted');
  }

  async function handleLogout() {
    await api.logout();
    setScreen('home');
    setAuth(null); // LoginGate reappears (gate exists + auth null)
  }

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
  };

  return (
    <div className="screen">
      <div className="admin-header">
        <div className="admin-whoami">
          <h1>{t('admin.title')}</h1>
          <span className="faint" style={{ fontSize: '0.72rem' }}>
            {t('admin.signedInAs')}
          </span>
          <span className="admin-email">{auth?.email ?? '—'}</span>
        </div>
        <button className="btn btn-ghost tap" onClick={handleLogout}>
          {t('admin.logout')}
        </button>
      </div>

      {msg && (
        <div role="status" className={`admin-msg admin-msg--${msg.kind}`}>
          {msg.serverMsg ?? t(msg.key)}
        </div>
      )}

      {/* --- add player --- */}
      <div className="admin-card">
        <h2>{t('admin.addTitle')}</h2>
        <form className="admin-form" onSubmit={addPlayer}>
          <input
            type="text"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('login.email')}
            aria-label={t('login.email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t('admin.password')}
            aria-label={t('admin.password')}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          <input
            type="text"
            autoComplete="off"
            placeholder={t('admin.displayName')}
            aria-label={t('admin.displayName')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !email || !pass}>
            {t('admin.add')}
          </button>
        </form>
      </div>

      {/* --- player list --- */}
      <div className="admin-card">
        <h2>{t('admin.listTitle')}</h2>
        {users === undefined ? (
          <p className="dim">{t('common.loading')}</p>
        ) : users === null ? (
          <div className="col" style={{ gap: 8 }}>
            <p className="dim">{t('admin.loadFailed')}</p>
            <button className="btn btn-ghost tap" onClick={reload}>
              {t('admin.retry')}
            </button>
          </div>
        ) : users.length === 0 ? (
          <p className="dim">{t('admin.empty')}</p>
        ) : (
          <div className="admin-user-list">
            {users.map((u) => {
              const self = u.email === auth?.email;
              return (
                <div key={u.email} className={`user-row${u.disabled ? ' user-row--disabled' : ''}`}>
                  <div className="user-row-main">
                    <span className="user-email">{u.email}</span>
                    <span className="row" style={{ gap: 6 }}>
                      {self && <span className="user-badge user-badge--you">{t('admin.you')}</span>}
                      {u.role === 'admin' && <span className="user-badge">{t('admin.roleAdmin')}</span>}
                      {u.disabled && (
                        <span className="user-badge user-badge--disabled">{t('admin.disabledBadge')}</span>
                      )}
                    </span>
                  </div>
                  <span className="faint" style={{ fontSize: '0.72rem' }}>
                    {u.displayName && `${u.displayName} · `}
                    {t('admin.created')} {fmtDate(u.createdAt)}
                  </span>
                  <div className="user-actions">
                    <button className="btn btn-ghost tap" disabled={busy} onClick={() => resetPassword(u)}>
                      {t('admin.resetPass')}
                    </button>
                    {/* Self: no disable/delete (server rejects them too). */}
                    {!self && (
                      <>
                        <button className="btn btn-ghost tap" disabled={busy} onClick={() => toggleDisabled(u)}>
                          {t(u.disabled ? 'admin.enable' : 'admin.disable')}
                        </button>
                        <button
                          className="btn btn-ghost tap user-action-danger"
                          disabled={busy}
                          onClick={() => deletePlayer(u)}
                        >
                          {t('admin.delete')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* --- costs (real Gemini usage uploaded at session end; ≈ THB) --- */}
      <div className="admin-card">
        <h2>{t('admin.costTitle')}</h2>
        {usage === undefined ? (
          <p className="dim">{t('common.loading')}</p>
        ) : usage === null ? (
          <div className="col" style={{ gap: 8 }}>
            <p className="dim">{t('admin.costLoadFailed')}</p>
            <button className="btn btn-ghost tap" onClick={reloadUsage}>
              {t('admin.retry')}
            </button>
          </div>
        ) : (
          <>
            <div className="usage-total">
              <span className="faint" style={{ fontSize: '0.72rem' }}>
                {t('admin.costTotal')}
              </span>
              <span className="usage-total-thb num">≈{formatTHB(usage.total.thb)}</span>
              <span className="faint num" style={{ fontSize: '0.72rem' }}>
                {formatTokens(usage.total.tokensIn)} {t('admin.costTokensIn')} ·{' '}
                {formatTokens(usage.total.tokensOut)} {t('admin.costTokensOut')} ·{' '}
                {usage.total.sessions} {t('admin.costSessions')}
              </span>
            </div>

            {usage.users.length === 0 ? (
              <p className="dim">{t('admin.costEmpty')}</p>
            ) : (
              <div className="usage-table-wrap">
                {/* Rows rendered in server order (contract: sorted as returned). */}
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t('admin.costUser')}</th>
                      <th>{t('admin.costName')}</th>
                      <th className="usage-num">{t('admin.costThb')}</th>
                      <th className="usage-num">{t('admin.costTokensIn')}</th>
                      <th className="usage-num">{t('admin.costTokensOut')}</th>
                      <th className="usage-num">{t('admin.costSessions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.users.map((u) => (
                      <tr key={u.email}>
                        <td className="usage-email">{u.email}</td>
                        <td>{u.userName || '—'}</td>
                        <td className="num usage-num">≈{formatTHB(u.thb)}</td>
                        <td className="num usage-num">{formatTokens(u.tokensIn)}</td>
                        <td className="num usage-num">{formatTokens(u.tokensOut)}</td>
                        <td className="num usage-num">{u.sessions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Static infra estimates — clearly NOT a real bill. */}
            <div className="usage-infra">
              <span className="usage-infra-title">{t('admin.costInfraTitle')}</span>
              <ul>
                <li>{t('admin.costInfraRun')}</li>
                <li>{t('admin.costInfraAr')}</li>
                <li>{t('admin.costInfraStore')}</li>
              </ul>
              <span className="faint" style={{ fontSize: '0.72rem' }}>
                {t('admin.costInfraNote')}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Unit tests for the PURE auth primitives (server/authCore.mjs).
// Imports ONLY authCore.mjs (node:crypto inside) — no express / firestore — so
// the repo-root vitest run (no server deps installed) collects this cleanly.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  hashPasswordAsync,
  verifyPasswordAsync,
  signCookie,
  verifyCookie,
  isValidEmail,
  parseCookies,
  safeEqual,
  getAuthSecret,
  evaluateGuard,
  clientIpFromForwarded,
} from './authCore.mjs';

const SECRET = 'test-secret';

describe('hashPassword / verifyPassword (scrypt)', () => {
  it('roundtrips the correct password', () => {
    const { passSalt, passHash } = hashPassword('s3cret!');
    expect(passSalt).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes, hex
    expect(passHash).toMatch(/^[0-9a-f]{128}$/); // 64-byte scrypt key, hex
    expect(verifyPassword('s3cret!', passSalt, passHash)).toBe(true);
  });
  it('rejects a wrong password', () => {
    const { passSalt, passHash } = hashPassword('s3cret!');
    expect(verifyPassword('s3cret', passSalt, passHash)).toBe(false);
    expect(verifyPassword('', passSalt, passHash)).toBe(false);
  });
  it('salts are per-user random (same password → different hashes)', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a.passSalt).not.toBe(b.passSalt);
    expect(a.passHash).not.toBe(b.passHash);
  });
  it('never throws on garbage stored values', () => {
    expect(verifyPassword('x', 'not-hex!', 'zzz')).toBe(false);
    expect(verifyPassword('x', undefined, null)).toBe(false);
  });
});

describe('hashPasswordAsync / verifyPasswordAsync (event-loop-friendly)', () => {
  it('roundtrips the correct password with the same output shape as sync', async () => {
    const { passSalt, passHash } = await hashPasswordAsync('s3cret!');
    expect(passSalt).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes, hex
    expect(passHash).toMatch(/^[0-9a-f]{128}$/); // 64-byte scrypt key, hex
    expect(await verifyPasswordAsync('s3cret!', passSalt, passHash)).toBe(true);
    expect(await verifyPasswordAsync('wrong', passSalt, passHash)).toBe(false);
  });
  it('is interoperable with the SYNC pair (same KDF)', async () => {
    const { passSalt, passHash } = hashPassword('interop');
    expect(await verifyPasswordAsync('interop', passSalt, passHash)).toBe(true);
    const asyncHash = await hashPasswordAsync('interop');
    expect(verifyPassword('interop', asyncHash.passSalt, asyncHash.passHash)).toBe(true);
  });
  it('never rejects on garbage stored values', async () => {
    expect(await verifyPasswordAsync('x', 'not-hex!', 'zzz')).toBe(false);
    expect(await verifyPasswordAsync('x', undefined, null)).toBe(false);
  });
});

describe('getAuthSecret — production hard-fail', () => {
  it('throws when AUTH_SECRET is unset in production (no public-constant fallback)', () => {
    const prevSecret = process.env.AUTH_SECRET;
    const prevEnv = process.env.NODE_ENV;
    try {
      delete process.env.AUTH_SECRET;
      process.env.NODE_ENV = 'production';
      expect(() => getAuthSecret()).toThrow(/AUTH_SECRET is required in production/);
    } finally {
      if (prevSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = prevSecret;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });
  it('returns the env value when set (both in and out of production)', () => {
    const prevSecret = process.env.AUTH_SECRET;
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.AUTH_SECRET = 'live-secret';
      process.env.NODE_ENV = 'production';
      expect(getAuthSecret()).toBe('live-secret');
    } finally {
      if (prevSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = prevSecret;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });
  it('returns the dev constant (no throw) outside production when unset', () => {
    const prevSecret = process.env.AUTH_SECRET;
    const prevEnv = process.env.NODE_ENV;
    try {
      delete process.env.AUTH_SECRET;
      process.env.NODE_ENV = 'development';
      expect(typeof getAuthSecret()).toBe('string');
      expect(getAuthSecret().length).toBeGreaterThan(0);
    } finally {
      if (prevSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = prevSecret;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }
  });
});

describe('evaluateGuard — per-request store re-check (UAM revocation)', () => {
  const player = { email: 'p@b.co', role: 'player' };
  const admin = { email: 'a@b.co', role: 'admin' };

  it('allows a present, non-disabled, role-matching user (role from STORE)', () => {
    const out = evaluateGuard({
      identity: player,
      user: { email: 'p@b.co', role: 'player', displayName: 'Player One' },
      lookupFailed: false,
    });
    expect(out).toEqual({ allow: true, role: 'player', displayName: 'Player One' });
  });
  it('denies a DELETED user (null)', () => {
    expect(evaluateGuard({ identity: player, user: null, lookupFailed: false })).toEqual({
      allow: false,
    });
  });
  it('denies a DISABLED user', () => {
    expect(
      evaluateGuard({ identity: player, user: { role: 'player', disabled: true }, lookupFailed: false }),
    ).toEqual({ allow: false });
  });
  it('denies a DEMOTED user (cookie admin, store player)', () => {
    expect(
      evaluateGuard({ identity: admin, user: { role: 'player' }, lookupFailed: false }),
    ).toEqual({ allow: false });
  });
  it('denies an ESCALATION (cookie player, store admin) — cookie stale-high blocked either way', () => {
    expect(
      evaluateGuard({ identity: player, user: { role: 'admin' }, lookupFailed: false }),
    ).toEqual({ allow: false });
  });
  it('trusts the cookie on a transient lookup failure (never locks everyone out)', () => {
    expect(evaluateGuard({ identity: admin, user: null, lookupFailed: true })).toEqual({
      allow: true,
      role: 'admin',
      displayName: 'a@b.co',
    });
  });
  it('falls back to email as displayName when the stored user has none', () => {
    const out = evaluateGuard({ identity: player, user: { role: 'player' }, lookupFailed: false });
    expect(out).toEqual({ allow: true, role: 'player', displayName: 'p@b.co' });
  });
});

describe('clientIpFromForwarded — rate-limit key uses the RIGHTMOST hop', () => {
  it('takes the rightmost XFF entry (Cloud Run appends the real client IP)', () => {
    // Leftmost is attacker-controlled — must NOT be returned.
    expect(clientIpFromForwarded('1.1.1.1, 2.2.2.2, 9.9.9.9', 'sock')).toBe('9.9.9.9');
    expect(clientIpFromForwarded('evil-spoof, 203.0.113.7', 'sock')).toBe('203.0.113.7');
  });
  it('trims whitespace and handles a single entry', () => {
    expect(clientIpFromForwarded('  1.2.3.4  ', 'sock')).toBe('1.2.3.4');
  });
  it('falls back to the socket peer when the header is absent', () => {
    expect(clientIpFromForwarded(undefined, '10.0.0.5')).toBe('10.0.0.5');
    expect(clientIpFromForwarded('', '10.0.0.5')).toBe('10.0.0.5');
  });
  it('falls back to "?" when neither is present', () => {
    expect(clientIpFromForwarded(undefined, undefined)).toBe('?');
  });
});

describe('signCookie / verifyCookie', () => {
  const now = 1_800_000_000; // fixed "current" unix seconds for determinism

  it('roundtrips email/role/exp', () => {
    const v = signCookie({ email: 'a@b.co', role: 'player', exp: now + 60 }, SECRET);
    expect(v).toMatch(/^v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(verifyCookie(v, SECRET, now)).toEqual({ email: 'a@b.co', role: 'player', exp: now + 60 });
  });
  it('rejects a tampered payload (role escalation attempt)', () => {
    const v = signCookie({ email: 'a@b.co', role: 'player', exp: now + 60 }, SECRET);
    const [, , sig] = v.split('.');
    const forged = `v1.${Buffer.from(`a@b.co|admin|${now + 60}`).toString('base64url')}.${sig}`;
    expect(verifyCookie(forged, SECRET, now)).toBeNull();
  });
  it('rejects a tampered signature and a wrong secret', () => {
    const v = signCookie({ email: 'a@b.co', role: 'admin', exp: now + 60 }, SECRET);
    expect(verifyCookie(v.slice(0, -1) + (v.endsWith('0') ? '1' : '0'), SECRET, now)).toBeNull();
    expect(verifyCookie(v, 'other-secret', now)).toBeNull();
  });
  it('rejects an expired cookie (exp <= now)', () => {
    const v = signCookie({ email: 'a@b.co', role: 'player', exp: now - 1 }, SECRET);
    expect(verifyCookie(v, SECRET, now)).toBeNull();
    const atNow = signCookie({ email: 'a@b.co', role: 'player', exp: now }, SECRET);
    expect(verifyCookie(atNow, SECRET, now)).toBeNull();
  });
  it('rejects malformed values and unknown roles', () => {
    expect(verifyCookie('', SECRET, now)).toBeNull();
    expect(verifyCookie('v2.abc.def', SECRET, now)).toBeNull();
    expect(verifyCookie('garbage', SECRET, now)).toBeNull();
    expect(verifyCookie(undefined, SECRET, now)).toBeNull();
    const weird = signCookie({ email: 'a@b.co', role: 'superuser', exp: now + 60 }, SECRET);
    expect(verifyCookie(weird, SECRET, now)).toBeNull();
  });
  it('a pipe in the email cannot smuggle a role (split from the end)', () => {
    const v = signCookie({ email: 'evil|admin@b.co', role: 'player', exp: now + 60 }, SECRET);
    const out = verifyCookie(v, SECRET, now);
    expect(out).toEqual({ email: 'evil|admin@b.co', role: 'player', exp: now + 60 });
  });
});

describe('isValidEmail', () => {
  it('accepts normal emails', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('piyaphan.p@infinitaskt.com')).toBe(true);
  });
  it('rejects malformed ones', () => {
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.co')).toBe(false);
    expect(isValidEmail('@b.co')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
  });
});

describe('parseCookies / safeEqual / COOKIE_NAME', () => {
  it('parses a multi-cookie header', () => {
    expect(parseCookies(`foo=1; ${COOKIE_NAME}=v1.abc.def; bar=x`)).toEqual({
      foo: '1',
      [COOKIE_NAME]: 'v1.abc.def',
      bar: 'x',
    });
    expect(parseCookies(undefined)).toEqual({});
  });
  it('safeEqual compares without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
  it('cookie name matches the frozen contract', () => {
    expect(COOKIE_NAME).toBe('adge_auth');
  });
});

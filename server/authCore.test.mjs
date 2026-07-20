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
  signCookie,
  verifyCookie,
  isValidEmail,
  parseCookies,
  safeEqual,
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

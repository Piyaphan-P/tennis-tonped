import { describe, it, expect } from 'vitest';
import { parseLineQr } from './parseQr';

describe('parseLineQr', () => {
  it('parses the exact producer sample (mixed key casing)', () => {
    const raw = JSON.stringify({
      LineuserId: 'U4af4980629abcdef',
      displayName: 'Ton',
      pictureUrl: 'https://profile.line-scdn.net/abc',
      email: 'Hello@gmail.com',
    });
    expect(parseLineQr(raw)).toEqual({
      lineUserId: 'U4af4980629abcdef',
      displayName: 'Ton',
      pictureUrl: 'https://profile.line-scdn.net/abc',
      email: 'hello@gmail.com', // lowercased
    });
  });

  it('accepts camelCase lineUserId too', () => {
    const raw = JSON.stringify({ lineUserId: 'Uxyz', displayName: 'A', email: 'A@B.CO' });
    const p = parseLineQr(raw)!;
    expect(p.lineUserId).toBe('Uxyz');
    expect(p.email).toBe('a@b.co');
  });

  it('lowercases the email so query-by-email matches', () => {
    const raw = JSON.stringify({ LineuserId: 'U1', email: 'MixedCase@Example.COM' });
    expect(parseLineQr(raw)!.email).toBe('mixedcase@example.com');
  });

  it('fills missing optional fields with empty strings, keeps the id', () => {
    const raw = JSON.stringify({ LineuserId: 'U1' });
    expect(parseLineQr(raw)).toEqual({
      lineUserId: 'U1',
      displayName: '',
      pictureUrl: '',
      email: '',
    });
  });

  it('rejects a payload with no lineUserId', () => {
    expect(parseLineQr(JSON.stringify({ displayName: 'Ton', email: 'a@b.co' }))).toBeNull();
  });

  it('rejects non-JSON / broken payloads', () => {
    expect(parseLineQr('not json at all')).toBeNull();
    expect(parseLineQr('{ broken')).toBeNull();
    expect(parseLineQr('')).toBeNull();
    expect(parseLineQr('   ')).toBeNull();
  });

  it('rejects JSON that is not an object', () => {
    expect(parseLineQr('"a string"')).toBeNull();
    expect(parseLineQr('42')).toBeNull();
    expect(parseLineQr('[1,2,3]')).toBeNull();
    expect(parseLineQr('null')).toBeNull();
  });

  it('ignores whitespace-only field values', () => {
    const raw = JSON.stringify({ LineuserId: 'U1', displayName: '   ', email: '  ' });
    const p = parseLineQr(raw)!;
    expect(p.displayName).toBe('');
    expect(p.email).toBe('');
  });
});

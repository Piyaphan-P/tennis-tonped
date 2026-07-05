import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REFS,
  loadRefPrefs,
  parseReferenceUrl,
  saveRefPref,
  youtubeEmbedUrl,
} from './referenceSource';

const ID = 'dQw4w9WgXcQ';

describe('parseReferenceUrl', () => {
  const table: Array<[string, ReturnType<typeof parseReferenceUrl>]> = [
    [`https://www.youtube.com/watch?v=${ID}`, { kind: 'youtube', videoId: ID }],
    [`https://www.youtube.com/watch?v=${ID}&t=42s&feature=share`, { kind: 'youtube', videoId: ID }],
    [`youtube.com/watch?v=${ID}`, { kind: 'youtube', videoId: ID }],
    [`https://youtu.be/${ID}`, { kind: 'youtube', videoId: ID }],
    [`youtu.be/${ID}`, { kind: 'youtube', videoId: ID }],
    [`https://youtu.be/${ID}?t=5`, { kind: 'youtube', videoId: ID }],
    [`https://www.youtube.com/shorts/${ID}`, { kind: 'youtube', videoId: ID }],
    [`https://www.youtube.com/embed/${ID}`, { kind: 'youtube', videoId: ID }],
    [`https://m.youtube.com/watch?v=${ID}`, { kind: 'youtube', videoId: ID }],
    [`https://m.youtube.com/shorts/${ID}`, { kind: 'youtube', videoId: ID }],
    [`https://www.youtube-nocookie.com/embed/${ID}`, { kind: 'youtube', videoId: ID }],
    ['https://example.com/clip.mp4', { kind: 'video', url: 'https://example.com/clip.mp4' }],
    ['http://example.com/clip.mov', { kind: 'video', url: 'http://example.com/clip.mov' }],
    ['example.com/clip.mp4', { kind: 'video', url: 'https://example.com/clip.mp4' }],
    ['', null],
    ['   ', null],
    ['not a url at all', null],
    ['https://www.youtube.com/watch?v=short', null],
    ['https://www.youtube.com/', null],
    ['ftp://example.com/clip.mp4', null],
  ];

  for (const [input, expected] of table) {
    it(`parses ${JSON.stringify(input)}`, () => {
      expect(parseReferenceUrl(input)).toEqual(expected);
    });
  }
});

describe('youtubeEmbedUrl', () => {
  it('builds a privacy-enhanced embed URL', () => {
    expect(youtubeEmbedUrl(ID)).toBe(
      `https://www.youtube-nocookie.com/embed/${ID}?rel=0&playsinline=1`,
    );
  });
});

describe('DEFAULT_REFS', () => {
  it('has a forehand and backhand default', () => {
    expect(typeof DEFAULT_REFS.forehand).toBe('string');
    expect(typeof DEFAULT_REFS.backhand).toBe('string');
    expect(parseReferenceUrl(DEFAULT_REFS.forehand)).not.toBeNull();
    expect(parseReferenceUrl(DEFAULT_REFS.backhand)).not.toBeNull();
  });
});

describe('ref prefs round-trip', () => {
  // vitest here runs in a plain node environment (no jsdom/localStorage), so
  // these assert the guarded no-throw contract; a browser env would also see
  // the round-tripped value persist, exercised manually in the app.
  it('round-trips a saved pref when localStorage is available', () => {
    expect(() => saveRefPref('forehand', 'https://youtu.be/aaaaaaaaaaa')).not.toThrow();
    const prefs = loadRefPrefs();
    if (typeof localStorage === 'undefined') {
      expect(prefs).toEqual({});
    } else {
      expect(prefs.forehand).toBe('https://youtu.be/aaaaaaaaaaa');
    }
  });

  it('returns an object (possibly empty) when nothing stored', () => {
    expect(loadRefPrefs()).toEqual(expect.any(Object));
  });

  it('never throws even if localStorage is unavailable', () => {
    expect(() => loadRefPrefs()).not.toThrow();
    expect(() => saveRefPref('backhand', 'https://youtu.be/bbbbbbbbbbb')).not.toThrow();
  });
});

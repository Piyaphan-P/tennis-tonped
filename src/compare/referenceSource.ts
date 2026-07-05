// ============================================================================
// ต้นและเพชร Tennis Club — Compare screen reference-video source parsing.
//
// Pure helpers: parse a pasted URL into a YouTube embed or direct video
// source, build the privacy-enhanced embed URL, and remember the user's
// chosen reference video per shot type (localStorage 'tp.refVideos').
// ============================================================================

import type { RefPrefs, ShotType } from '../types';

export type RefSource = { kind: 'youtube'; videoId: string } | { kind: 'video'; url: string } | null;

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Parse a pasted URL into a reference source.
 * Accepts youtube.com/watch?v=ID (with extra params), youtu.be/ID,
 * youtube.com/shorts/ID, youtube.com/embed/ID, m.youtube.com variants,
 * with or without protocol. Any other http(s) URL is treated as a direct
 * video URL. Invalid/empty input returns null.
 */
export function parseReferenceUrl(input: string): RefSource {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Normalize so URL parsing works even without a protocol. Only prepend a
  // protocol when none is present at all — a non-http(s) protocol (e.g.
  // ftp://) must be rejected below, not silently coerced.
  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    if (YT_ID_RE.test(id)) return { kind: 'youtube', videoId: id };
    return null;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') {
      const id = url.searchParams.get('v') ?? '';
      if (YT_ID_RE.test(id)) return { kind: 'youtube', videoId: id };
      return null;
    }
    if ((parts[0] === 'shorts' || parts[0] === 'embed') && parts[1]) {
      const id = parts[1];
      if (YT_ID_RE.test(id)) return { kind: 'youtube', videoId: id };
      return null;
    }
    return null;
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'video', url: url.toString() };
  }
  return null;
}

/** Privacy-enhanced YouTube embed URL for a parsed video id. */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&playsinline=1`;
}

/** Sensible default technique-video references per shot type. */
export const DEFAULT_REFS: Record<'forehand' | 'backhand', string> = {
  // Verified live via YouTube oEmbed (HTTP 200, embeddable) 2026-07-05:
  // forehand — "Perfect Forehand in 3 Easy Steps" (Top Tennis Training)
  // backhand — "Perfect Two Handed Backhand in 3 Steps" (Top Tennis Training)
  forehand: 'https://www.youtube.com/watch?v=5arVdubK9Pg',
  backhand: 'https://www.youtube.com/watch?v=i1k8MLOsOwI',
};

const LS_REF_VIDEOS = 'tp.refVideos';

function lsGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* quota/private mode — persistence is best-effort */
  }
}

/** Load remembered reference-video URLs per shot type. Never throws. */
export function loadRefPrefs(): RefPrefs {
  const raw = lsGet(LS_REF_VIDEOS);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: RefPrefs = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k as ShotType] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember the chosen reference-video URL for a shot type. Never throws. */
export function saveRefPref(type: ShotType, url: string): void {
  const prefs = loadRefPrefs();
  prefs[type] = url;
  lsSet(LS_REF_VIDEOS, JSON.stringify(prefs));
}

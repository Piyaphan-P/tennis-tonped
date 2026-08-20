import type { LineProfile } from '../types';

/**
 * Parse a scanned LINE-profile QR payload into a normalized {@link LineProfile}.
 *
 * The QR encodes JSON, but the producer's key casing is NOT stable — real
 * samples use `"LineuserId"` (capital L, lower i) alongside camelCase
 * `"displayName"`. So we match keys case-insensitively and accept a few
 * spellings. The personal email is **lowercased** so the external
 * history API's query-by-email matches (the sample is capitalized:
 * `"Hello@gmail.com"`).
 *
 * Returns null on anything that isn't a JSON object or that carries no usable
 * lineUserId — a bad scan must never bind a broken profile.
 */
export function parseLineQr(raw: string): LineProfile | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  // Case-insensitive key lookup over the raw object.
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    lower[k.toLowerCase()] = v;
  }
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = lower[k.toLowerCase()];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const lineUserId = pick('lineUserId', 'lineuserid', 'userId', 'uid');
  if (!lineUserId) return null; // no identity → reject

  return {
    lineUserId,
    displayName: pick('displayName', 'name'),
    pictureUrl: pick('pictureUrl', 'picture', 'photoUrl'),
    email: pick('email', 'mail').toLowerCase(),
  };
}

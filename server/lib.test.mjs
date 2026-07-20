// ============================================================================
// Unit tests for the PURE server helpers (server/lib.mjs).
// Imports ONLY lib.mjs — no pg / gcs / express — so the repo-root vitest run
// (which does not install server deps) collects and passes this file cleanly.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  extFromMime,
  clipObjectPath,
  sessionRowToJson,
  shotRowToJson,
  sessionDocToJson,
  shotDocToJson,
  userDocToJson,
  validateShotMeta,
  sanitizeUsage,
  aggregateUsageRows,
  leaderboardScores,
  unavailableBody,
} from './lib.mjs';

// A fake Firestore Timestamp: duck-typed via toDate() exactly like the real one,
// so we exercise lib.mjs's import-free timestamp handling without the SDK.
const ts = (iso) => ({ toDate: () => new Date(iso) });

describe('extFromMime', () => {
  it('returns mp4 for video/mp4 families', () => {
    expect(extFromMime('video/mp4')).toBe('mp4');
    expect(extFromMime('video/mp4;codecs=avc1.42E01E')).toBe('mp4');
  });
  it('returns webm for webm and anything else', () => {
    expect(extFromMime('video/webm;codecs=vp9')).toBe('webm');
    expect(extFromMime('application/octet-stream')).toBe('webm');
    expect(extFromMime(undefined)).toBe('webm');
    expect(extFromMime('')).toBe('webm');
  });
});

describe('clipObjectPath', () => {
  it('builds <sessionId>/<shotId>.<ext>', () => {
    expect(clipObjectPath('sess-1', 'shot-9', 'video/mp4')).toBe('sess-1/shot-9.mp4');
    expect(clipObjectPath('s', 'x', 'video/webm;codecs=vp8')).toBe('s/x.webm');
  });
});

describe('leaderboardScores — recompute from stored shots (never trust client)', () => {
  it('returns the mean and max of the stored shot scores', () => {
    expect(leaderboardScores([80, 90, 100])).toEqual({ avgScore: 90, maxScore: 100 });
  });
  it('mean is unrounded (matches Postgres avg())', () => {
    const { avgScore, maxScore } = leaderboardScores([80, 85]);
    expect(avgScore).toBeCloseTo(82.5, 10);
    expect(maxScore).toBe(85);
  });
  it('returns null for zero shots so the caller skips the upsert', () => {
    expect(leaderboardScores([])).toBeNull();
    expect(leaderboardScores(undefined)).toBeNull();
    expect(leaderboardScores(null)).toBeNull();
  });
  it('coerces non-numeric scores to 0 and never trusts a passed-in avg', () => {
    expect(leaderboardScores([50, 'x', undefined, 100])).toEqual({ avgScore: 37.5, maxScore: 100 });
  });
});

describe('sessionRowToJson', () => {
  it('maps snake_case → wire shape with ISO timestamps', () => {
    const row = {
      id: 'a',
      user_name: 'Ton',
      started_at: new Date('2026-07-05T10:00:00.000Z'),
      ended_at: new Date('2026-07-05T11:00:00.000Z'),
      avg_score: 82.5,
      shot_count: 12,
      summary: { goodFormPct: 50 },
    };
    expect(sessionRowToJson(row)).toEqual({
      id: 'a',
      userName: 'Ton',
      startedAt: '2026-07-05T10:00:00.000Z',
      endedAt: '2026-07-05T11:00:00.000Z',
      avgScore: 82.5,
      shotCount: 12,
      summary: { goodFormPct: 50 },
      ownerEmail: null, // no owner_email column value → legacy row
    });
  });
  it('passes owner_email through as ownerEmail (UAM v1.5)', () => {
    const out = sessionRowToJson({
      id: 'c',
      started_at: '2026-07-05T10:00:00.000Z',
      owner_email: 'player@adge.co',
    });
    expect(out.ownerEmail).toBe('player@adge.co');
  });
  it('tolerates null ended_at / summary and missing user_name', () => {
    const out = sessionRowToJson({
      id: 'b',
      started_at: '2026-07-05T10:00:00.000Z',
      ended_at: null,
      avg_score: 0,
      shot_count: 0,
      summary: null,
    });
    expect(out.endedAt).toBeNull();
    expect(out.summary).toBeNull();
    expect(out.userName).toBe('');
  });
});

describe('shotRowToJson', () => {
  it('sets hasClip from clip_path presence', () => {
    const withClip = shotRowToJson({
      id: 's1',
      session_id: 'sess',
      idx: 3,
      type: 'forehand',
      score: 77,
      angles: { a: 1 },
      statuses: { domElbow: 'good' },
      issues: [{ key: 'x' }],
      peak_wrist_speed: 1.4,
      clip_path: 'sess/s1.mp4',
      clip_mime: 'video/mp4',
      created_at: '2026-07-05T10:00:00.000Z',
    });
    expect(withClip.hasClip).toBe(true);
    expect(withClip.clipMime).toBe('video/mp4');
    expect(withClip.idx).toBe(3);

    const noClip = shotRowToJson({
      id: 's2',
      session_id: 'sess',
      idx: 4,
      type: 'backhand',
      score: 50,
      angles: null,
      statuses: null,
      issues: null,
      peak_wrist_speed: 0,
      clip_path: null,
      clip_mime: null,
      created_at: '2026-07-05T10:00:00.000Z',
    });
    expect(noClip.hasClip).toBe(false);
    expect(noClip.clipMime).toBeNull();
    expect(noClip.issues).toEqual([]);
  });
});

describe('sessionDocToJson (Firestore)', () => {
  it('maps a Firestore doc to the SAME wire shape as sessionRowToJson', () => {
    const pg = sessionRowToJson({
      id: 'a',
      user_name: 'Ton',
      started_at: new Date('2026-07-05T10:00:00.000Z'),
      ended_at: new Date('2026-07-05T11:00:00.000Z'),
      avg_score: 82.5,
      shot_count: 12,
      summary: { goodFormPct: 50 },
    });
    const fs = sessionDocToJson('a', {
      userName: 'Ton',
      startedAt: ts('2026-07-05T10:00:00.000Z'),
      endedAt: ts('2026-07-05T11:00:00.000Z'),
      avgScore: 82.5,
      shotCount: 12,
      summary: { goodFormPct: 50 },
      expireAt: ts('2026-07-08T10:00:00.000Z'), // ignored by the mapper
    });
    expect(fs).toEqual(pg);
  });
  it('tolerates null endedAt/summary and missing userName', () => {
    const out = sessionDocToJson('b', {
      startedAt: ts('2026-07-05T10:00:00.000Z'),
      endedAt: null,
      avgScore: 0,
      shotCount: 0,
      summary: null,
    });
    expect(out.endedAt).toBeNull();
    expect(out.summary).toBeNull();
    expect(out.userName).toBe('');
    expect(out.startedAt).toBe('2026-07-05T10:00:00.000Z');
    expect(out.ownerEmail).toBeNull(); // legacy doc without ownerEmail
  });
  it('passes ownerEmail through (UAM v1.5)', () => {
    const out = sessionDocToJson('c', {
      startedAt: ts('2026-07-05T10:00:00.000Z'),
      ownerEmail: 'player@adge.co',
    });
    expect(out.ownerEmail).toBe('player@adge.co');
  });
});

describe('userDocToJson (Firestore, UAM v1.5)', () => {
  it('maps to the /api/users wire shape and NEVER leaks credential fields', () => {
    const out = userDocToJson({
      email: 'player@adge.co',
      passSalt: 'aa'.repeat(16),
      passHash: 'bb'.repeat(64),
      role: 'player',
      displayName: 'Ton',
      disabled: false,
      createdAt: ts('2026-07-20T10:00:00.000Z'),
    });
    expect(out).toEqual({
      email: 'player@adge.co',
      displayName: 'Ton',
      role: 'player',
      disabled: false,
      createdAt: '2026-07-20T10:00:00.000Z',
    });
    expect('passHash' in out).toBe(false);
    expect('passSalt' in out).toBe(false);
  });
  it('defaults missing fields and coerces unknown roles to player', () => {
    const out = userDocToJson({ email: 'x@y.co', role: 'superuser' });
    expect(out.role).toBe('player');
    expect(out.displayName).toBe('');
    expect(out.disabled).toBe(false);
    expect(out.createdAt).toBeNull();
  });
});

describe('shotDocToJson (Firestore)', () => {
  it('matches shotRowToJson byte-for-byte (with/without clip+audio)', () => {
    const pg = shotRowToJson({
      id: 's1',
      session_id: 'sess',
      idx: 3,
      type: 'forehand',
      score: 77,
      angles: { a: 1 },
      statuses: { domElbow: 'good' },
      issues: [{ key: 'x' }],
      peak_wrist_speed: 1.4,
      clip_path: 'sess/s1.mp4',
      clip_mime: 'video/mp4',
      audio_path: 'audio/sess/s1.wav',
      created_at: '2026-07-05T10:00:00.000Z',
    });
    const fs = shotDocToJson('s1', {
      id: 's1',
      sessionId: 'sess',
      idx: 3,
      type: 'forehand',
      score: 77,
      angles: { a: 1 },
      statuses: { domElbow: 'good' },
      issues: [{ key: 'x' }],
      peakWristSpeed: 1.4,
      clipPath: 'sess/s1.mp4',
      clipMime: 'video/mp4',
      audioPath: 'audio/sess/s1.wav',
      audioMime: 'audio/wav',
      createdAt: ts('2026-07-05T10:00:00.000Z'),
      expireAt: ts('2026-07-08T10:00:00.000Z'),
    });
    expect(fs).toEqual(pg);
    expect(fs.hasClip).toBe(true);
    expect(fs.hasAudio).toBe(true);

    const noBlobs = shotDocToJson('s2', {
      id: 's2',
      sessionId: 'sess',
      idx: 4,
      type: 'backhand',
      score: 50,
      angles: null,
      statuses: null,
      issues: null,
      peakWristSpeed: 0,
      clipPath: null,
      clipMime: null,
      audioPath: null,
      audioMime: null,
      createdAt: ts('2026-07-05T10:00:00.000Z'),
    });
    expect(noBlobs.hasClip).toBe(false);
    expect(noBlobs.hasAudio).toBe(false);
    expect(noBlobs.clipMime).toBeNull();
    expect(noBlobs.issues).toEqual([]);
  });
});

describe('validateShotMeta', () => {
  const valid = {
    idx: 1,
    type: 'forehand',
    score: 88,
    angles: { rightElbowDeg: 150 },
    statuses: { domElbow: 'good' },
    issues: [],
    peakWristSpeed: 1.2,
  };
  it('accepts a well-formed body', () => {
    expect(validateShotMeta(valid)).toEqual({ ok: true, errors: [] });
  });
  it('rejects non-objects', () => {
    expect(validateShotMeta(null).ok).toBe(false);
    expect(validateShotMeta(undefined).ok).toBe(false);
    expect(validateShotMeta('nope').ok).toBe(false);
  });
  it('rejects bad type and out-of-range score', () => {
    expect(validateShotMeta({ ...valid, type: 'serve' }).ok).toBe(false);
    expect(validateShotMeta({ ...valid, score: 120 }).ok).toBe(false);
    expect(validateShotMeta({ ...valid, score: -1 }).ok).toBe(false);
  });
  it('rejects missing numeric/object/array fields', () => {
    expect(validateShotMeta({ ...valid, idx: 'x' }).ok).toBe(false);
    expect(validateShotMeta({ ...valid, angles: [] }).ok).toBe(false);
    expect(validateShotMeta({ ...valid, issues: {} }).ok).toBe(false);
    expect(validateShotMeta({ ...valid, peakWristSpeed: 'fast' }).ok).toBe(false);
  });
});

describe('unavailableBody', () => {
  it('returns the bilingual cloud_unavailable 503 body', () => {
    const b = unavailableBody('history');
    expect(b.error).toBe('cloud_unavailable');
    expect(b.message).toContain('Cloud history is not configured');
    expect(b.message).toContain('ยังไม่ได้ตั้งค่าระบบคลาวด์');
  });
});

describe('sanitizeUsage', () => {
  it('returns null when absent or not a plain object (old clients keep working)', () => {
    expect(sanitizeUsage(undefined)).toBeNull();
    expect(sanitizeUsage(null)).toBeNull();
    expect(sanitizeUsage('7.5')).toBeNull();
    expect(sanitizeUsage([1, 2])).toBeNull();
  });
  it('coerces numbers with Number()||0 and keeps detail only when plain object', () => {
    expect(
      sanitizeUsage({ thb: '7.25', tokensIn: 1200, tokensOut: '340', detail: { audio: 1 } }),
    ).toEqual({ thb: 7.25, tokensIn: 1200, tokensOut: 340, detail: { audio: 1 } });
    expect(sanitizeUsage({ thb: 'x', tokensIn: NaN, detail: [1] })).toEqual({
      thb: 0,
      tokensIn: 0,
      tokensOut: 0,
      detail: null,
    });
  });
});

describe('aggregateUsageRows', () => {
  // Fake Firestore Timestamp playedAt — exercises the import-free duck-typing.
  const row = (ownerEmail, userName, thb, tokensIn, tokensOut, playedAtIso) => ({
    ownerEmail,
    userName,
    thb,
    tokensIn,
    tokensOut,
    playedAt: playedAtIso ? ts(playedAtIso) : null,
  });

  it('returns empty shape on no rows', () => {
    expect(aggregateUsageRows([])).toEqual({
      users: [],
      total: { thb: 0, tokensIn: 0, tokensOut: 0, sessions: 0 },
    });
    expect(aggregateUsageRows(undefined).users).toEqual([]);
  });

  it('groups by ownerEmail, sums, sorts by thb desc, rounds thb to 2 decimals', () => {
    const out = aggregateUsageRows([
      row('a@x.com', 'A', 1.005, 100, 10, '2026-07-18T10:00:00Z'),
      row('a@x.com', 'A2', 2.001, 200, 20, '2026-07-19T10:00:00Z'),
      row('b@x.com', 'B', 9.999, 50, 5, '2026-07-17T10:00:00Z'),
    ]);
    expect(out.users.map((u) => u.email)).toEqual(['b@x.com', 'a@x.com']);
    const a = out.users[1];
    expect(a).toEqual({
      email: 'a@x.com',
      userName: 'A2', // most recent record names the group
      thb: 3.01,
      tokensIn: 300,
      tokensOut: 30,
      sessions: 2,
    });
    expect(out.users[0].thb).toBe(10);
    expect(out.total).toEqual({ thb: 13.01, tokensIn: 350, tokensOut: 35, sessions: 3 });
  });

  it('buckets null ownerEmail under "(legacy)" and tolerates missing playedAt', () => {
    const out = aggregateUsageRows([
      row(null, 'Old Phone', 0.5, 10, 1, null),
      row(null, 'Older Phone', 0.25, 5, 1, null),
    ]);
    expect(out.users).toHaveLength(1);
    expect(out.users[0].email).toBe('(legacy)');
    expect(out.users[0].sessions).toBe(2);
    expect(out.users[0].thb).toBe(0.75);
  });

  it('most-recent userName wins regardless of row order', () => {
    const out = aggregateUsageRows([
      row('a@x.com', 'Newest', 1, 1, 1, '2026-07-20T00:00:00Z'),
      row('a@x.com', 'Oldest', 1, 1, 1, '2026-07-01T00:00:00Z'),
    ]);
    expect(out.users[0].userName).toBe('Newest');
  });
});

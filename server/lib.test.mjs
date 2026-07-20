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

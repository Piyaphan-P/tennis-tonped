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
  validateShotMeta,
  unavailableBody,
} from './lib.mjs';

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
    });
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

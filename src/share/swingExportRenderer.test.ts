// ============================================================================
// ADGE Tennis — swingExportRenderer pure-helper tests.
// Covers the layout / radar geometry / duration+loop / mime / filename logic.
// The DOM export path (exportSwingVideo) is NOT exercised here — node has no
// MediaRecorder/canvas.captureStream, so it must return null without throwing.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  EXPORT_W,
  EXPORT_H,
  EXPORT_MAX_MS,
  exportLayout,
  radarAxisPoint,
  radarPolygon,
  recordDurationMs,
  shouldLoopClip,
  pickExportMimeType,
  exportFilename,
  scoreExportColor,
  exportSwingVideo,
} from './swingExportRenderer';
import { CLIP_MAX_MS } from '../analysis/swingRecorder';

describe('scoreExportColor', () => {
  it('maps score bands to the semantic palette', () => {
    expect(scoreExportColor(95)).toBe('#39d08a'); // good
    expect(scoreExportColor(80)).toBe('#39d08a'); // boundary → good
    expect(scoreExportColor(72)).toBe('#f1a24a'); // warn
    expect(scoreExportColor(60)).toBe('#f1a24a'); // boundary → warn
    expect(scoreExportColor(40)).toBe('#ff6a4d'); // fault
    expect(scoreExportColor(0)).toBe('#ff6a4d');
  });
});

describe('exportLayout', () => {
  it('keeps every region inside the 1080×1920 card', () => {
    const l = exportLayout();
    expect(l.video.x).toBeGreaterThanOrEqual(0);
    expect(l.video.x + l.video.w).toBeLessThanOrEqual(EXPORT_W);
    expect(l.video.y + l.video.h).toBeLessThanOrEqual(EXPORT_H);
    // radar ring fits horizontally within the card
    expect(l.radar.cx - l.radar.r).toBeGreaterThan(0);
    expect(l.radar.cx + l.radar.r).toBeLessThan(EXPORT_W);
    // fix bullets start below the radar and above the footer
    expect(l.fixStartY).toBeGreaterThan(l.radar.cy + l.radar.r);
    expect(l.fixStartY).toBeLessThan(EXPORT_H);
  });

  it('keeps the radar clear of the video box and gives the fix bullets a wide gap (v1.0.3)', () => {
    const l = exportLayout();
    const videoBottom = l.video.y + l.video.h;
    const topLabelY = l.radar.cy - l.radar.r * l.radar.labelFactor;
    const bottomLabelY = l.radar.cy + l.radar.r * l.radar.labelFactor;
    // top axis label sits BELOW the video box (no title row anymore)
    expect(topLabelY - 26).toBeGreaterThan(videoBottom);
    // bottom axis label gets a WIDE gap before the fix bullets (was crowding)
    expect(l.fixStartY - bottomLabelY).toBeGreaterThanOrEqual(100);
  });
});

describe('radarAxisPoint', () => {
  const cx = 100;
  const cy = 100;
  const r = 50;

  it('puts axis 0 straight up at full radius', () => {
    const [x, y] = radarAxisPoint(0, 6, 1, cx, cy, r);
    expect(x).toBeCloseTo(cx, 5);
    expect(y).toBeCloseTo(cy - r, 5);
  });

  it('scales toward the center for smaller fractions', () => {
    const [, yHalf] = radarAxisPoint(0, 6, 0.5, cx, cy, r);
    expect(yHalf).toBeCloseTo(cy - r * 0.5, 5);
  });

  it('goes clockwise (axis 1 of 4 is to the right)', () => {
    const [x, y] = radarAxisPoint(1, 4, 1, cx, cy, r);
    expect(x).toBeCloseTo(cx + r, 5);
    expect(y).toBeCloseTo(cy, 5);
  });
});

describe('radarPolygon', () => {
  it('returns one point per value', () => {
    const pts = radarPolygon([1, 1, 1, 1, 1, 1], 0, 0, 60);
    expect(pts).toHaveLength(6);
    pts.forEach(([x, y]) => {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    });
  });

  it('handles the empty case', () => {
    expect(radarPolygon([], 0, 0, 60)).toEqual([]);
  });
});

describe('recordDurationMs', () => {
  it('takes the max of clip and audio when both are finite', () => {
    expect(recordDurationMs(4000, 6000)).toBe(6000);
    expect(recordDurationMs(6000, 4000)).toBe(6000);
  });

  it('caps at EXPORT_MAX_MS', () => {
    expect(recordDurationMs(5000, 999999)).toBe(EXPORT_MAX_MS);
  });

  it('falls back to audio when the clip duration is Infinity (WebM header)', () => {
    // The exact real-device trap: <video>.duration = Infinity for MediaRecorder
    // WebM must NOT force a 20s export.
    expect(recordDurationMs(Infinity, 3000)).toBe(3000);
    expect(recordDurationMs(NaN, 3000)).toBe(3000);
  });

  it('falls back to CLIP_MAX_MS when neither duration is usable', () => {
    expect(recordDurationMs(Infinity, 0)).toBe(CLIP_MAX_MS);
    expect(recordDurationMs(0, 0)).toBe(CLIP_MAX_MS);
    expect(recordDurationMs(NaN, NaN)).toBe(CLIP_MAX_MS);
  });

  it('uses clip length when audio is absent', () => {
    expect(recordDurationMs(5000, 0)).toBe(5000);
  });
});

describe('shouldLoopClip', () => {
  it('loops only when the voice outlasts a known clip', () => {
    expect(shouldLoopClip(3000, 6000)).toBe(true);
    expect(shouldLoopClip(6000, 3000)).toBe(false);
    expect(shouldLoopClip(3000, 3000)).toBe(false);
  });

  it('never loops when there is no audio', () => {
    expect(shouldLoopClip(3000, 0)).toBe(false);
    expect(shouldLoopClip(Infinity, 0)).toBe(false);
  });

  it('loops an unknown-length clip when audio exists (avoids a frozen frame)', () => {
    expect(shouldLoopClip(Infinity, 4000)).toBe(true);
    expect(shouldLoopClip(NaN, 4000)).toBe(true);
  });
});

describe('pickExportMimeType', () => {
  it('prefers mp4 (iOS) when supported', () => {
    expect(pickExportMimeType(() => true)).toBe('video/mp4;codecs=avc1.42E01E');
  });

  it('returns null when nothing is supported', () => {
    expect(pickExportMimeType(() => false)).toBeNull();
  });

  it('falls through the chain to webm', () => {
    expect(pickExportMimeType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9');
  });
});

describe('exportFilename', () => {
  it('derives the extension from the mimeType and namespaces by shot index', () => {
    expect(exportFilename(3, 'video/mp4')).toBe('adge-swing-3.mp4');
    expect(exportFilename(12, 'video/webm;codecs=vp9')).toBe('adge-swing-12.webm');
  });
});

describe('exportSwingVideo (node/jsdom guard)', () => {
  it('resolves null (never throws) with no MediaRecorder present', async () => {
    const blob = await exportSwingVideo({
      clipSrc: 'blob:fake',
      shotIndex: 1,
      shotTypeLabel: 'แบ็คแฮนด์',
      score: 72,
      radar: [],
      fixLines: [],
      lang: 'th',
    });
    expect(blob).toBeNull();
  });
});

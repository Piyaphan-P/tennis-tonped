import { describe, it, expect } from 'vitest';
import {
  formatMinutes,
  formatSpeedValue,
  statsCardFilename,
  statsCardLayout,
  renderStatsCard,
  STATS_W,
  STATS_H,
  type StatsCardData,
} from './statsCardRenderer';

describe('statsCardRenderer pure helpers', () => {
  it('formatMinutes localizes and rounds', () => {
    expect(formatMinutes(12.6, 'th')).toBe('13 นาที');
    expect(formatMinutes(12.6, 'en')).toBe('13 min');
    expect(formatMinutes(-5, 'en')).toBe('0 min');
  });

  it('formatSpeedValue prefixes ≈ or shows — when absent', () => {
    expect(formatSpeedValue(58)).toBe('≈ 58');
    expect(formatSpeedValue(undefined)).toBe('—');
    expect(formatSpeedValue(0)).toBe('—');
  });

  it('statsCardFilename is a png with the adge-stats base', () => {
    expect(statsCardFilename()).toBe('adge-stats.png');
  });

  it('layout: 2×2 tile grid stays within content width and the spin block sits above the footer', () => {
    const l = statsCardLayout();
    expect(l.tiles).toHaveLength(4);
    for (const tile of l.tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x + tile.w).toBeLessThanOrEqual(STATS_W);
    }
    // two columns, two rows
    expect(l.tiles[0].y).toBe(l.tiles[1].y);
    expect(l.tiles[2].y).toBe(l.tiles[3].y);
    expect(l.tiles[2].y).toBeGreaterThan(l.tiles[0].y);
    // spin block below the grid, above the footer band
    expect(l.spin.y).toBeGreaterThan(l.tiles[3].y + l.tiles[3].h);
    expect(l.spin.y + l.spin.h).toBeLessThan(STATS_H - 140);
  });

  it('renderStatsCard resolves a Blob without throwing (node: no document → empty png)', async () => {
    const data: StatsCardData = {
      lang: 'th',
      playerName: 'ทดสอบ',
      dateLabel: '20 ก.ค.',
      minutes: 30,
      shots: 12,
      avgSpeedKmh: 58,
      kcal: 130,
      spin: { topspin: 60, backspin: 25, flat: 15 },
      cumMinutes: 90,
      cumShots: 40,
      cumAvgSpeedKmh: 55,
      cumKcal: 400,
    };
    const blob = await renderStatsCard(data);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });
});

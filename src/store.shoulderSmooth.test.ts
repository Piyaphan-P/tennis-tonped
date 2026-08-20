// ============================================================================
// v1.4 mitigation — LIVE shoulder-status EMA smoothing (z-noise de-flicker).
//
// The CRITICAL invariant: smoothing touches ONLY the live status coloring
// (pose.statuses.domShoulder); the RAW angle stored in pose.angles — which the
// shot detector captures for scoring — must stay byte-for-byte instantaneous.
// This test is the durable proof of that (code refactors can't silently break
// it), plus that a single z-noise spike no longer flips the status chip.
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './store';
import type { JointAngles, PoseFrame } from './types';

// Root vitest runs in bare node (no DOM): minimal in-memory localStorage so the
// store's lsGet/lsSet (checked at call time) don't throw.
if (typeof localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => mem.delete(k),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
  } as Storage;
}

function angles(rightShoulderDeg: number): JointAngles {
  return {
    timestampMs: 0,
    leftElbowDeg: 140,
    rightElbowDeg: 140, // in the elbow 'good' window (isolate the shoulder)
    leftShoulderDeg: 90,
    rightShoulderDeg,
    leftKneeDeg: 140,
    rightKneeDeg: 140,
    leftHipDeg: 120,
    rightHipDeg: 120,
    trunkLeanDeg: 5,
    wristSpeed: 0,
    wristVelX: 0,
  };
}

const FRAME: PoseFrame = { timestampMs: 0, landmarks: [] };

describe('live shoulder-status EMA smoothing (display-only)', () => {
  beforeEach(() => {
    // startSession resets the module-level shoulder EMA and the pose slice.
    useAppStore.getState().startSession();
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, dominantHand: 'right' } });
    // A non-idle phase so evaluateAngleStatuses judges (idle = all neutral).
    useAppStore.getState().setPhase('contact');
  });

  it('stores the RAW shoulder angle in pose.angles (never the smoothed value)', () => {
    useAppStore.getState().pushPoseFrame(FRAME, angles(100)); // seed
    useAppStore.getState().pushPoseFrame(FRAME, angles(40)); // spike frame
    // pose.angles is the raw object we passed — the scoring path reads this.
    expect(useAppStore.getState().pose.angles?.rightShoulderDeg).toBe(40);
  });

  it('a single z-noise spike does NOT flip the status chip (the flicker fix)', () => {
    useAppStore.getState().pushPoseFrame(FRAME, angles(100)); // good (60–110)
    expect(useAppStore.getState().pose.statuses?.domShoulder).toBe('good');
    // One bad frame at 40° would read 'warn' un-smoothed; EMA keeps it inside.
    useAppStore.getState().pushPoseFrame(FRAME, angles(40));
    expect(useAppStore.getState().pose.statuses?.domShoulder).toBe('good');
    // …while the raw stored angle still reflects reality.
    expect(useAppStore.getState().pose.angles?.rightShoulderDeg).toBe(40);
  });

  it('a sustained real move DOES cross the status boundary (not just frozen)', () => {
    for (let i = 0; i < 15; i++) useAppStore.getState().pushPoseFrame(FRAME, angles(30));
    expect(useAppStore.getState().pose.statuses?.domShoulder).toBe('warn');
  });
});

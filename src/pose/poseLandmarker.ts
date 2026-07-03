// ============================================================================
// ต้นและเพชร Tennis Club — MediaPipe PoseLandmarker bootstrap + pose loop
//
// Owns the singleton PoseLandmarker (VIDEO mode) and the per-frame detection
// loop that feeds the Zustand store. Verified init pattern lives in CLAUDE.md.
// No React imports — this is a plain imperative module driven by the Live view.
// ============================================================================

import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type { JointAngles, Landmark, PoseFrame } from '../types';
import { appStore } from '../store';
import { computeJointAngles } from './angles';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let landmarkerPromise: Promise<PoseLandmarker> | null = null;
let landmarkerInstance: PoseLandmarker | null = null;

/**
 * Create (or reuse) the singleton PoseLandmarker in VIDEO mode. Idempotent and
 * safe to call repeatedly — the underlying promise is cached. On failure the
 * cache is cleared so a later call can retry.
 */
export function initPoseLandmarker(): Promise<void> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_BASE)
      .then((fileset) =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL },
          runningMode: 'VIDEO',
          numPoses: 1,
        }),
      )
      .then((lm) => {
        landmarkerInstance = lm;
        return lm;
      })
      .catch((err) => {
        // Allow a subsequent call to retry after a transient failure.
        landmarkerPromise = null;
        landmarkerInstance = null;
        throw err;
      });
  }
  return landmarkerPromise.then(() => undefined);
}

function toLandmarks(
  raw: Array<{ x: number; y: number; z: number; visibility?: number }> | undefined,
): Landmark[] {
  return raw
    ? raw.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }))
    : [];
}

/**
 * Start the pose detection loop on a <video>. Detects one frame per callback via
 * requestVideoFrameCallback (falling back to requestAnimationFrame), computes
 * joint angles, pushes them into the store, and invokes `onFrame` (the Live view
 * wires this to the shot detector). MediaPipe requires strictly increasing
 * timestamps, so frames whose performance.now() is not greater than the last
 * processed one are skipped. Returns a stop() that cancels the loop; the shared
 * landmarker is intentionally left open for reuse.
 */
export function startPoseLoop(
  video: HTMLVideoElement,
  onFrame?: (frame: PoseFrame, angles: JointAngles) => void,
): () => void {
  let stopped = false;
  let lastTs = 0;
  let prev: { frame: PoseFrame; angles: JointAngles } | null = null;

  // FPS: rolling 1s window, pushed to the store at most once per second.
  let frameCount = 0;
  let fpsWindowStart = performance.now();

  const useVfc = typeof video.requestVideoFrameCallback === 'function';
  let rafHandle = 0;
  let vfcHandle = 0;

  function schedule(): void {
    if (stopped) return;
    if (useVfc) {
      vfcHandle = video.requestVideoFrameCallback(() => tick());
    } else {
      rafHandle = requestAnimationFrame(() => tick());
    }
  }

  function tick(): void {
    if (stopped) return;

    // Landmarker not ready yet, or the video has no decodable data — retry.
    if (!landmarkerInstance || video.readyState < 2) {
      schedule();
      return;
    }

    const ts = performance.now();
    // Guard strictly increasing timestamps (MediaPipe throws otherwise).
    if (ts <= lastTs) {
      schedule();
      return;
    }

    let landmarks: Landmark[];
    try {
      const result = landmarkerInstance.detectForVideo(video, ts);
      landmarks = toLandmarks(result.landmarks?.[0]);
    } catch (err) {
      // A single bad frame must not kill the loop.
      console.error('[pose] detectForVideo failed', err);
      schedule();
      return;
    }
    lastTs = ts;

    const frame: PoseFrame = { timestampMs: ts, landmarks };
    const dominantHand = appStore.getState().settings.dominantHand;
    const angles = computeJointAngles(frame, prev, dominantHand);

    appStore.getState().pushPoseFrame(frame, angles);
    prev = { frame, angles };
    onFrame?.(frame, angles);

    // Rolling FPS counter, throttled to one store write per second.
    frameCount += 1;
    const elapsed = ts - fpsWindowStart;
    if (elapsed >= 1000) {
      const fps = Math.round((frameCount * 1000) / elapsed);
      appStore.getState().setPoseFps(fps);
      frameCount = 0;
      fpsWindowStart = ts;
    }

    schedule();
  }

  // Kick off once the landmarker is ready; loop tolerates it being null early.
  // An already-initialized landmarker resolves on the next microtask, so this
  // single entry point starts the loop exactly once in both cold and warm cases.
  initPoseLandmarker()
    .then(() => {
      if (stopped) return;
      // Clear any prior init-failure state now that the model is ready.
      appStore.getState().setPoseInitError(null);
      schedule();
    })
    .catch((err) => {
      console.error('[pose] initPoseLandmarker failed', err);
      // Surface a visible, bilingual state on Live (never a silent black screen).
      appStore.getState().setPoseInitError('error.poseInitFailed');
    });

  return function stop(): void {
    if (stopped) return;
    stopped = true;
    if (useVfc && vfcHandle) {
      video.cancelVideoFrameCallback(vfcHandle);
    } else if (rafHandle) {
      cancelAnimationFrame(rafHandle);
    }
  };
}

/** Release the singleton landmarker (e.g. on app teardown). */
export function closePoseLandmarker(): void {
  const inst = landmarkerInstance;
  landmarkerInstance = null;
  landmarkerPromise = null;
  inst?.close();
}

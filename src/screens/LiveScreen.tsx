// ============================================================================
// ต้นและเพชร Tennis Club — Live screen (COACH IS THE HERO)
//
// Full-bleed 100dvh, no page scroll: the camera <video> sits behind everything
// with the skeleton overlay on top, and all controls are overlaid with
// safe-area insets. Layout, top→bottom:
//   • prominent brand banner + connection chip
//   • compact HUD (phase chip, score pill, telemetry) + corner ฿ cost button
//   • swipeable swing-capture gallery strip
//   • the BIG coach message (lower third) — the dominant element
//   • continuous open mic (MicControl) + End Session
// Bilingual overlays cover camera-denied, pose-init-failed and coach errors —
// never a raw API/English string, never a silent black screen.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useT, translateError } from '../i18n';
import { startPoseLoop } from '../pose/poseLandmarker';
import { ShotDetector } from '../analysis/shotDetector';
import type { CaptureContext } from '../analysis/shotDetector';
import { coachLive } from '../coach/liveClient';
import type { JointAngles, PoseFrame, Shot } from '../types';
import PhaseChip from '../components/PhaseChip';
import PoseCanvas from '../components/PoseCanvas';
import CoachBubble from '../components/CoachBubble';
import CaptureGallery from '../components/CaptureGallery';
import TelemetryStrip from '../components/TelemetryStrip';
import DetectionHud from '../components/DetectionHud';
import ScoreBadge from '../components/ScoreBadge';
import CostFab from '../components/CostFab';
import MicControl from '../components/MicControl';

/** Max width (px) of the JPEG we snapshot for captures + the coach frame. */
const CAPTURE_MAX_W = 640;
const CAPTURE_QUALITY = 0.6;

export default function LiveScreen() {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const setScreen = useAppStore((s) => s.setScreen);
  const endSession = useAppStore((s) => s.endSession);
  const connection = useAppStore((s) => s.connection);
  const coachError = useAppStore((s) => s.coach.error);
  const poseInitError = useAppStore((s) => s.pose.initError);
  const cameraFacing = useAppStore((s) => s.settings.cameraFacing);
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Last pose tick with a full 33-landmark frame, kept fresh from the pose
  // loop callback. getJpeg() falls back to this when the store's pose is
  // momentarily empty/short (a one-tick MediaPipe dropout), so a capture at
  // contact isn't lost to a single missed frame.
  const lastGoodPoseRef = useRef<{ frame: PoseFrame; angles: JointAngles } | null>(null);
  const mirrored = cameraFacing === 'user';

  // Camera error is LOCAL UI state (never a raw store error string). retryKey
  // re-runs the camera/pose/coach effect when the user taps "retry".
  const [cameraError, setCameraError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let stopLoop: (() => void) | null = null;
    let stream: MediaStream | null = null;
    let cancelled = false;

    // Snapshot the current video frame as base64 JPEG (no data: prefix) plus
    // the matching pose, so a capture's skeleton lines up with its image.
    const getJpeg = (): CaptureContext | undefined => {
      try {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth) return undefined;

        // Prefer the live store pose; fall back to the last known-good pose
        // (from the pose loop callback) so one dropped MediaPipe tick doesn't
        // sink an otherwise-grabbable capture.
        const pose = useAppStore.getState().pose;
        const frame =
          pose.frame && pose.frame.landmarks.length >= 33
            ? pose.frame
            : lastGoodPoseRef.current?.frame;
        const angles =
          pose.frame && pose.frame.landmarks.length >= 33
            ? pose.angles
            : lastGoodPoseRef.current?.angles;
        if (!frame || !angles || frame.landmarks.length < 33) return undefined;

        let canvas = captureCanvasRef.current;
        if (!canvas) {
          canvas = document.createElement('canvas');
          captureCanvasRef.current = canvas;
        }
        const scale = Math.min(1, CAPTURE_MAX_W / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', CAPTURE_QUALITY);
        const comma = url.indexOf(',');
        if (comma < 0) return undefined;
        return {
          jpegBase64: url.slice(comma + 1),
          landmarks: frame.landmarks,
          angles,
          tsMs: frame.timestampMs,
        };
      } catch {
        // Never throw into the pose loop / shot detector — a failed capture
        // just means this keyframe is skipped.
        return undefined;
      }
    };

    lastGoodPoseRef.current = null;

    // A completed swing → ask the coach (queued/dropped per liveClient rules).
    const detector = new ShotDetector({
      onShotCompleted: (shot: Shot) => coachLive.sendShotForCoaching(shot),
    });
    detector.reset();

    // Connect the realtime coach (non-fatal if the token is missing/expired —
    // the local skeleton, angles and score keep working regardless).
    coachLive.connect().catch(() => {
      /* session/coach error already surfaced to the store by connect() */
    });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: cameraFacing },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        setCameraError(false);
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        stopLoop = startPoseLoop(video, (frame, angles) => {
          if (frame.landmarks.length === 33) {
            lastGoodPoseRef.current = { frame, angles };
          }
          detector.onFrame(frame, angles, getJpeg);
        });
      } catch {
        // Bilingual camera-denied overlay — NEVER a raw getUserMedia string.
        if (!cancelled) setCameraError(true);
      }
    })();

    return () => {
      cancelled = true;
      stopLoop?.();
      stream?.getTracks().forEach((tr) => tr.stop());
      const video = videoRef.current;
      if (video) video.srcObject = null;
      detector.reset();
      coachLive.disconnect();
    };
  }, [cameraFacing, retryKey]);

  const end = () => {
    coachLive.disconnect();
    endSession();
    setScreen('summary');
  };

  const retryCamera = () => {
    setCameraError(false);
    setRetryKey((k) => k + 1);
  };

  const connColor =
    connection === 'connected'
      ? 'var(--good)'
      : connection === 'connecting'
        ? 'var(--warn)'
        : 'var(--fault)';
  const connLabel =
    connection === 'connected'
      ? t('live.connected')
      : connection === 'connecting'
        ? t('live.connecting')
        : t('live.disconnected');

  return (
    <div className="live-fullbleed">
      <video
        ref={videoRef}
        className="live-video"
        playsInline
        muted
        autoPlay
        style={{ transform: mirrored ? 'scaleX(-1)' : 'none' }}
      />
      <PoseCanvas videoRef={videoRef} mirrored={mirrored} />

      <div className="live-overlay">
        <div className="live-top">
          <div className="live-banner">
            <span className="brand-dot" aria-hidden />
            <span className="live-banner-name">{t('brand.name')}</span>
            <span className="live-conn chip">
              <span
                className="brand-dot"
                style={{ width: 8, height: 8, background: connColor, boxShadow: 'none' }}
              />
              {connLabel}
            </span>
          </div>

          <div className="live-hud">
            <PhaseChip />
            <ScoreBadge compact />
          </div>
          <TelemetryStrip />
          <DetectionHud />

          {coachError && (
            <span className="chip live-coach-err">{translateError(coachError, lang)}</span>
          )}
        </div>

        <div className="spacer" />

        <div className="live-bottom">
          <CaptureGallery />
          <CoachBubble />
          <div className="row live-controls">
            <MicControl />
            <button className="btn btn-danger" onClick={end}>
              {t('live.end')}
            </button>
          </div>
        </div>
      </div>

      <CostFab />

      {poseInitError && (
        <div className="live-error-scrim">
          <div className="card live-error-card">
            <h2>{t('error.poseInitFailed.title')}</h2>
            <p className="dim">{t('error.poseInitFailed.body')}</p>
          </div>
        </div>
      )}

      {cameraError && (
        <div className="live-error-scrim">
          <div className="card live-error-card">
            <h2>{t('error.cameraDenied.title')}</h2>
            <p className="dim">{t('error.cameraDenied.body')}</p>
            <button className="btn btn-primary" onClick={retryCamera}>
              {t('error.retry')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

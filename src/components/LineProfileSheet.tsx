import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import { parseLineQr } from '../line/parseQr';
import type { LineProfile } from '../types';

// ============================================================================
// LineProfileSheet (SIT v2.1) — bind the current PLAYER's LINE identity before
// a session. Two tabs: สแกน QR (camera + jsQR, decodes the LINE-profile JSON)
// and กรอกเอง (manual). On confirm → store.setLineProfile (persists + seeds
// userName). The camera track is ALWAYS stopped on close / tab-away / unmount
// so it can't fight Live's getUserMedia for the device.
// ============================================================================

type Tab = 'scan' | 'manual';

export default function LineProfileSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const setLineProfile = useAppStore((s) => s.setLineProfile);
  const [tab, setTab] = useState<Tab>('scan');
  /** A decoded-but-not-yet-confirmed profile (preview card). */
  const [pending, setPending] = useState<LineProfile | null>(null);
  const [camError, setCamError] = useState<string | null>(null);

  // Manual-entry fields.
  const [mId, setMId] = useState('');
  const [mName, setMName] = useState('');
  const [mEmail, setMEmail] = useState('');
  const [mPic, setMPic] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  /** Hard-stop the camera + decode loop (idempotent). */
  const stopCamera = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Scanning is active only on the scan tab with no pending preview yet.
  const scanning = tab === 'scan' && pending == null;

  useEffect(() => {
    if (!scanning) {
      stopCamera();
      return;
    }
    let cancelled = false;
    setCamError(null);

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          for (const tr of stream.getTracks()) tr.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play().catch(() => {});

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const tick = () => {
          if (cancelled || !ctx || !videoRef.current) return;
          const v = videoRef.current;
          if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
            // Downscale to ≤320px on the long edge — jsQR is O(pixels) and a
            // full 720p frame per rAF janks the phone.
            const scale = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
            const w = Math.round(v.videoWidth * scale);
            const h = Math.round(v.videoHeight * scale);
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(v, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
            if (code?.data) {
              const parsed = parseLineQr(code.data);
              if (parsed) {
                setPending(parsed); // stops scanning via the scanning flag
                return;
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        if (!cancelled) setCamError(t('line.camError'));
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [scanning, stopCamera, t]);

  // Belt-and-braces: stop the camera if the component unmounts mid-scan.
  useEffect(() => stopCamera, [stopCamera]);

  function confirm(profile: LineProfile) {
    setLineProfile(profile);
    stopCamera();
    onClose();
  }

  function confirmManual() {
    const lineUserId = mId.trim();
    if (!lineUserId) return;
    confirm({
      lineUserId,
      displayName: mName.trim(),
      pictureUrl: mPic.trim(),
      email: mEmail.trim().toLowerCase(),
    });
  }

  const tabBtn = (id: Tab, label: string) => (
    <button
      className={`seg tap${tab === id ? ' active' : ''}`}
      onClick={() => {
        setPending(null);
        setTab(id);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2>{t('line.title')}</h2>
          <button className="btn btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

        <p className="dim" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          {t('line.subtitle')}
        </p>

        <div className="segmented" style={{ marginBottom: 12 }}>
          {tabBtn('scan', t('line.tabScan'))}
          {tabBtn('manual', t('line.tabManual'))}
        </div>

        {/* Preview card (a decoded QR OR a manual entry ready to confirm). */}
        {pending ? (
          <div className="col" style={{ gap: 12, alignItems: 'center' }}>
            {pending.pictureUrl ? (
              <img
                src={pending.pictureUrl}
                alt=""
                width={72}
                height={72}
                style={{ borderRadius: '50%', objectFit: 'cover' }}
                onError={(e) => ((e.currentTarget.style.display = 'none'))}
              />
            ) : null}
            <div className="col" style={{ gap: 2, alignItems: 'center' }}>
              <strong style={{ fontSize: '1.05rem' }}>{pending.displayName || pending.lineUserId}</strong>
              {pending.email ? <span className="dim" style={{ fontSize: '0.85rem' }}>{pending.email}</span> : null}
              <span className="dim" style={{ fontSize: '0.72rem' }}>{pending.lineUserId}</span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-ghost tap" onClick={() => setPending(null)}>
                {t('line.rescan')}
              </button>
              <button className="btn btn-primary tap" onClick={() => confirm(pending)}>
                {t('line.confirm')}
              </button>
            </div>
          </div>
        ) : tab === 'scan' ? (
          <div className="col" style={{ gap: 8, alignItems: 'center' }}>
            <div
              style={{
                position: 'relative',
                width: 'min(280px, 80vw)',
                aspectRatio: '1 / 1',
                borderRadius: 16,
                overflow: 'hidden',
                background: '#000',
                border: '2px solid var(--surface-2)',
              }}
            >
              <video
                ref={videoRef}
                muted
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              {/* Scanning reticle. */}
              <div
                style={{
                  position: 'absolute',
                  inset: '18%',
                  border: '2px solid var(--accent)',
                  borderRadius: 12,
                  pointerEvents: 'none',
                }}
              />
            </div>
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            {camError ? (
              <p role="alert" style={{ color: 'var(--fault)', fontSize: '0.85rem', textAlign: 'center' }}>
                {camError}
              </p>
            ) : (
              <p className="dim" style={{ fontSize: '0.82rem', textAlign: 'center' }}>
                {t('line.scanHint')}
              </p>
            )}
          </div>
        ) : (
          <div className="col" style={{ gap: 10 }}>
            <input
              type="text"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t('line.fieldId')}
              aria-label={t('line.fieldId')}
              value={mId}
              onChange={(e) => setMId(e.target.value)}
            />
            <input
              type="text"
              placeholder={t('line.fieldName')}
              aria-label={t('line.fieldName')}
              value={mName}
              onChange={(e) => setMName(e.target.value)}
            />
            <input
              type="text"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t('line.fieldEmail')}
              aria-label={t('line.fieldEmail')}
              value={mEmail}
              onChange={(e) => setMEmail(e.target.value)}
            />
            <input
              type="text"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t('line.fieldPicture')}
              aria-label={t('line.fieldPicture')}
              value={mPic}
              onChange={(e) => setMPic(e.target.value)}
            />
            <button className="btn btn-primary tap" onClick={confirmManual} disabled={!mId.trim()}>
              {t('line.confirm')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

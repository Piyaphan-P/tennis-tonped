// ============================================================================
// ADGE Tennis — History screen.
// LIST: cloud 3-day session list (offline → localStorage stats-only fallback).
// DETAIL (cloud only): end-of-session summary (top faults + trend + bar chart)
// then per-shot clip cards (video + radar + improvement lines + compare).
// All cloud calls go through data/api (never throw; null = fall back offline).
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import * as api from '../data/api';
import {
  radarData,
  shotImprovementLines,
  overallSummary,
  formatSessionDate,
} from '../history/derive';
import RadarChart from '../components/charts/RadarChart';
import BarChart from '../components/charts/BarChart';
import SwingExportButton from '../components/SwingExportButton';
import { getCoachAudioBlob } from '../coach/coachAudioTap';
import type {
  CloudSessionDetail,
  CloudSessionSummary,
  CloudShot,
  StoredSession,
} from '../types';
import './history.css';

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--good)';
  if (score >= 60) return 'var(--warn)';
  return 'var(--fault)';
}

function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="hist-score num" style={{ color: scoreColor(score) }}>
      {Math.round(score)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LIST VIEW
// ---------------------------------------------------------------------------

function ListView({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const localHistory = useAppStore((s) => s.history);
  const [sessions, setSessions] = useState<CloudSessionSummary[] | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setSessions(undefined);
    api.fetchHistory(3).then((res) => {
      if (!cancelled) setSessions(res);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (sessions === undefined) {
    return (
      <div className="screen">
        <h1>{t('history.title')}</h1>
        <div className="hist-skeleton" aria-live="polite">
          {t('history.loading')}
        </div>
      </div>
    );
  }

  const offline = sessions === null;
  const cloud = sessions ?? [];
  const useLocal = offline || cloud.length === 0;
  const local = [...localHistory].sort((a, b) => b.tsMs - a.tsMs);

  const bothEmpty = cloud.length === 0 && local.length === 0;

  return (
    <div className="screen">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>{t('history.title')}</h1>
        <span className="faint" style={{ fontSize: '0.7rem' }}>
          {t('history.expiryNote')}
        </span>
      </div>

      {bothEmpty ? (
        <div className="hist-empty">
          <span style={{ fontSize: '2rem' }} aria-hidden>
            🎾
          </span>
          <p className="dim">{t('history.empty')}</p>
        </div>
      ) : useLocal ? (
        <div className="history-list">
          {offline && <div className="hist-banner">{t('history.offlineNote')}</div>}
          {local.map((h) => (
            <LocalCard key={h.id} session={h} lang={lang} />
          ))}
        </div>
      ) : (
        <div className="history-list">
          {cloud.map((s) => (
            <button
              key={s.id}
              type="button"
              className="session-card tap"
              onClick={() => onOpen(s.id)}
            >
              <div className="col" style={{ gap: 3, minWidth: 0, textAlign: 'left' }}>
                <span className="session-date">{formatSessionDate(s.startedAt, lang)}</span>
                <span className="faint num" style={{ fontSize: '0.72rem' }}>
                  {s.shotCount} {t('history.shots')}
                  {s.userName ? ` · ${s.userName}` : ''}
                </span>
              </div>
              <div className="col" style={{ alignItems: 'flex-end', gap: 1 }}>
                <ScoreBadge score={s.avgScore} />
                <span className="faint" style={{ fontSize: '0.62rem' }}>
                  {t('history.avgScore')}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Offline stats-only card (localStorage StoredSession) — no detail navigation. */
function LocalCard({ session, lang }: { session: StoredSession; lang: string }) {
  const t = useT();
  return (
    <div className="session-card session-card--local">
      <div className="col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <span className="session-date">{formatSessionDate(new Date(session.tsMs).toISOString(), lang as 'th' | 'en')}</span>
          <ScoreBadge score={session.avgScore} />
        </div>
        <span className="faint num" style={{ fontSize: '0.72rem' }}>
          {session.shotCount} {t('history.shots')} · {session.goodFormPct.toFixed(0)}%
        </span>
        {session.improvements.length > 0 && (
          <ul className="hist-improve">
            {session.improvements.map((imp) => (
              <li key={imp.key} style={{ color: imp.severity === 'fault' ? 'var(--fault)' : 'var(--warn)' }}>
                {lang === 'th' ? imp.messageTH : imp.messageEN}
                {imp.target ? ` (${imp.target})` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DETAIL VIEW (cloud only)
// ---------------------------------------------------------------------------

function DetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const dominantHand = useAppStore((s) => s.settings.dominantHand);
  const cloudSessionId = useAppStore((s) => s.cloudSessionId);
  const localShots = useAppStore((s) => s.shots);
  const setScreen = useAppStore((s) => s.setScreen);
  const setCompareClip = useAppStore((s) => s.setCompareClip);

  const [detail, setDetail] = useState<CloudSessionDetail | null | undefined>(undefined);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const load = useCallback(() => {
    setDetail(undefined);
    let cancelled = false;
    api.fetchSessionDetail(id).then((res) => {
      if (!cancelled) setDetail(res);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => load(), [load]);

  /** Prefer the live in-memory blob URL when this detail is the current session. */
  const clipSrc = useCallback(
    (shot: CloudShot): string | null => {
      if (!shot.hasClip) return null;
      if (cloudSessionId && cloudSessionId === id) {
        const localMatch = localShots.find(
          (s) => s.clip?.url && s.index === shot.idx,
        );
        if (localMatch?.clip?.url) return localMatch.clip.url;
      }
      return api.clipUrl(shot.id);
    },
    [cloudSessionId, id, localShots],
  );

  /** The in-memory local Shot for this row when the detail is the live session. */
  const localShotFor = useCallback(
    (shot: CloudShot) =>
      cloudSessionId && cloudSessionId === id
        ? localShots.find((s) => s.index === shot.idx)
        : undefined,
    [cloudSessionId, id, localShots],
  );

  /**
   * Coach voice for the export video: prefer the in-memory session Blob (no
   * network) for the live session, else the same-origin cloud audio stream when
   * the row has audio. `hasAudio` may be absent on old cloud rows → treat falsy.
   */
  const coachAudioSrc = useCallback(
    (shot: CloudShot): string | Blob | null => {
      const local = localShotFor(shot);
      if (local) {
        const blob = getCoachAudioBlob(local.id);
        if (blob) return blob;
      }
      const hasAudio = (shot as CloudShot & { hasAudio?: boolean }).hasAudio;
      return hasAudio ? api.audioUrl(shot.id) : null;
    },
    [localShotFor],
  );

  const onDelete = async () => {
    if (!window.confirm(t('history.deleteConfirm'))) return;
    setDeleteFailed(false);
    const ok = await api.deleteSessionCloud(id);
    if (ok) onBack();
    else setDeleteFailed(true);
  };

  if (detail === undefined) {
    return (
      <div className="screen">
        <BackBar onBack={onBack} label={t('common.back')} />
        <div className="hist-skeleton" aria-live="polite">
          {t('history.loading')}
        </div>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="screen">
        <BackBar onBack={onBack} label={t('common.back')} />
        <div className="hist-empty">
          <p className="dim">{t('history.loadFailed')}</p>
          <button type="button" className="btn" onClick={load}>
            {t('history.retry')}
          </button>
        </div>
      </div>
    );
  }

  const shots = detail.shots ?? [];
  const summary = overallSummary(shots);
  const trendKey: I18nKey =
    summary.trend === 'improving'
      ? 'history.trendUp'
      : summary.trend === 'declining'
        ? 'history.trendDown'
        : 'history.trendFlat';

  return (
    <div className="screen">
      <BackBar onBack={onBack} label={t('common.back')} />

      <div className="detail-header">
        {detail.userName ? (
          <span className="detail-player">
            {t('history.byPlayer').replace('{name}', detail.userName)}
          </span>
        ) : null}
        <h1 style={{ margin: 0 }}>{formatSessionDate(detail.startedAt, lang)}</h1>
        <div className="row" style={{ gap: 12, alignItems: 'baseline' }}>
          <span className="faint num">
            {detail.shotCount} {t('history.shots')}
          </span>
          <span className="row" style={{ gap: 4, alignItems: 'baseline' }}>
            <ScoreBadge score={detail.avgScore} />
            <span className="faint" style={{ fontSize: '0.62rem' }}>
              {t('history.avgScore')}
            </span>
          </span>
        </div>
      </div>

      {/* --- END-OF-SESSION SUMMARY --- */}
      <div className="card col" style={{ gap: 12, borderColor: 'var(--line-strong)' }}>
        <h3 style={{ margin: 0 }}>{t('history.summaryTitle')}</h3>

        <div className="hist-trend">
          <span>{t(trendKey)}</span>
          <span className="num faint">
            {summary.firstHalfAvg} → {summary.secondHalfAvg}
          </span>
        </div>

        {summary.topFaults.length > 0 && (
          <div className="col" style={{ gap: 6 }}>
            <span className="dim" style={{ fontSize: '0.8rem' }}>
              {t('history.topFaults')}
            </span>
            <ul className="hist-improve">
              {summary.topFaults.map((f) => (
                <li key={f.key} style={{ color: f.severity === 'fault' ? 'var(--fault)' : 'var(--warn)' }}>
                  {lang === 'th' ? f.messageTH : f.messageEN}
                  {f.target ? ` (${f.target})` : ''} · {f.count}
                </li>
              ))}
            </ul>
          </div>
        )}

        {shots.length > 0 && (
          <div className="col" style={{ gap: 6 }}>
            <span className="dim" style={{ fontSize: '0.8rem' }}>
              {t('history.perShotScores')}
            </span>
            <div className="barchart-wrap">
              <BarChart values={shots.map((s) => s.score)} lang={lang} />
            </div>
          </div>
        )}
      </div>

      {/* --- PER-SHOT CLIP CARDS --- */}
      <div className="clip-grid">
        {shots.map((shot) => {
          const src = clipSrc(shot);
          const lines = shotImprovementLines(shot.issues, lang);
          // Unknown stroke ⇒ show just "#N" (no "ไม่ทราบชนิด" placeholder).
          const typeLabel = shot.type === 'unknown' ? '' : t(`shot.${shot.type}` as I18nKey);
          const radar = radarData(shot.angles, shot.peakWristSpeed, dominantHand);
          const localMatch = localShotFor(shot);
          return (
            <div key={shot.id} className="clip-card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span className="dim" style={{ fontSize: '0.85rem' }}>
                  #{shot.idx}
                  {typeLabel ? ` · ${typeLabel}` : ''}
                </span>
                <ScoreBadge score={shot.score} />
              </div>

              {src ? (
                <video
                  className="clip-video"
                  controls
                  muted
                  playsInline
                  preload="metadata"
                  src={src}
                />
              ) : (
                <div className="clip-noclip faint">{t('history.noClip')}</div>
              )}

              <div className="radar-wrap">
                <span className="faint" style={{ fontSize: '0.68rem' }}>
                  {t('history.radarTitle')}
                </span>
                <RadarChart data={radar} lang={lang} size={180} />
              </div>

              {lines.length > 0 && (
                <ul className="hist-improve">
                  {lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}

              {shot.hasClip && (
                <button
                  type="button"
                  className="btn btn-block"
                  onClick={() => {
                    setCompareClip({
                      url: src ?? api.clipUrl(shot.id),
                      mimeType: shot.clipMime ?? 'video/mp4',
                      shotType: shot.type,
                    });
                    setScreen('compare');
                  }}
                >
                  {t('history.compareThis')}
                </button>
              )}

              {shot.hasClip && src && (
                <SwingExportButton
                  opts={{
                    clipSrc: src,
                    audioSrc: coachAudioSrc(shot),
                    shotIndex: shot.idx,
                    shotTypeLabel: typeLabel,
                    score: shot.score,
                    radar,
                    fixLines: lines,
                    playerName: detail.userName,
                    lang,
                    clipDurationMs: localMatch?.clip?.durationMs,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="col" style={{ gap: 8 }}>
        <button type="button" className="btn btn-danger btn-block" onClick={onDelete}>
          {t('history.delete')}
        </button>
        {deleteFailed && (
          <span className="t-fault" style={{ fontSize: '0.8rem' }}>
            {t('history.deleteFailed')}
          </span>
        )}
      </div>

      <div className="spacer" />
    </div>
  );
}

function BackBar({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button type="button" className="hist-back tap" onClick={onBack}>
      ‹ {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Screen shell — swaps LIST / DETAIL by local state (no router).
// ---------------------------------------------------------------------------

export default function HistoryScreen() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  return selectedSessionId === null ? (
    <ListView onOpen={setSelectedSessionId} />
  ) : (
    <DetailView id={selectedSessionId} onBack={() => setSelectedSessionId(null)} />
  );
}

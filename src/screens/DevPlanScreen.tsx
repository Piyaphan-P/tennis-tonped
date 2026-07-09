// ============================================================================
// ADGE Tennis — Development Plan (v0.8)
//
// A player-friendly, shareable review of the latest session:
//   1. "จุดที่พลาด" — the lowest-scoring shots that have a swing clip (worst
//      first, up to 3). Each card plays the clip inline (tap → lightbox),
//      shows the score, the shot's worst joint issue in plain Thai, and which
//      phase it happened in — plus a one-tap Story share.
//   2. "แนวทางพัฒนา" — for each recurring fault this session, a structured
//      block: อาการ → เพราะอะไร → วิธีซ้อม → cue สั้น (copy authored in i18n).
//   3. One "แชร์สรุปวันนี้" for the session's best moment.
//
// Everything is derived from existing Shot data (issues/statuses/captures/clip
// + scoring.ts vocabulary). Never a blank page: empty / no-clip / all-good
// states all render a clear message.
// ============================================================================

import { memo, useEffect, useRef, useState, useMemo, type ReactNode } from 'react';
import { useAppStore } from '../store';
import { translate, useT } from '../i18n';
import type { I18nKey } from '../i18n';
import type { DominantHand, IssueSeverity, Lang, Shot, ShotIssue, SwingCapture } from '../types';
import StoryShareButton from '../components/StoryShareButton';
import CaptureLightbox from '../components/CaptureLightbox';
import { renderCaptureToDataUrl } from '../analysis/captureRenderer';
import type { StoryData } from '../share/storyRenderer';
import './devplan.css';

// ---------------------------------------------------------------------------
// Issue key → coaching area id (mirrors scoring.ts issue vocabulary). The area
// copy (title / อาการ / เพราะอะไร / วิธีซ้อม / cue) lives in i18n so it stays
// bilingual and editable without touching this screen.
// ---------------------------------------------------------------------------

const AREA_IDS = [
  'contact-extension',
  'knee-load',
  'balance',
  'racket-prep',
  'swing-speed',
] as const;
type AreaId = (typeof AREA_IDS)[number];

function areaForIssue(key: string): AreaId | null {
  switch (key) {
    case 'elbow-too-bent':
    case 'arm-locked':
      return 'contact-extension';
    case 'no-knee-bend':
      return 'knee-load';
    case 'leaning':
    case 'off-balance':
      return 'balance';
    case 'shoulder-angle':
      return 'racket-prep';
    case 'swing-faster':
      return 'swing-speed';
    default:
      return null;
  }
}

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = { fault: 2, warn: 1, good: 0 };

interface RankedArea {
  id: AreaId;
  weight: number;
  shots: number;
}

// ---------------------------------------------------------------------------
// Derivations (pure)
// ---------------------------------------------------------------------------

/** Worst non-good issue on a shot (fault ranks above warn), or null. */
function worstIssue(shot: Shot): ShotIssue | null {
  let best: ShotIssue | null = null;
  for (const issue of shot.issues) {
    if (issue.severity === 'good') continue;
    if (!best || SEVERITY_WEIGHT[issue.severity] > SEVERITY_WEIGHT[best.severity]) {
      best = issue;
    }
  }
  return best;
}

/** The capture used as the story's hero frame (contact, else first). */
function heroCapture(shot: Shot): SwingCapture | undefined {
  return shot.captures.find((c) => c.phase === 'contact') ?? shot.captures[0];
}

/** Top coaching area for a single shot (worst-weighted), or null. */
function topAreaForShot(shot: Shot): AreaId | null {
  const acc = new Map<AreaId, number>();
  for (const issue of shot.issues) {
    if (issue.severity === 'good') continue;
    const id = areaForIssue(issue.key);
    if (!id) continue;
    acc.set(id, (acc.get(id) ?? 0) + SEVERITY_WEIGHT[issue.severity]);
  }
  let top: AreaId | null = null;
  let topW = 0;
  for (const [id, w] of acc) {
    if (w > topW) {
      topW = w;
      top = id;
    }
  }
  return top;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function DevPlanScreen() {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const setScreen = useAppStore((s) => s.setScreen);
  const shots = useAppStore((s) => s.shots);
  const hand = useAppStore((s) => s.settings.dominantHand);

  // Rank recurring faults into coaching areas (worst first, up to 3).
  const ranked = useMemo<RankedArea[]>(() => {
    const acc = new Map<AreaId, { weight: number; shots: number }>();
    for (const shot of shots) {
      const seen = new Set<AreaId>();
      for (const issue of shot.issues) {
        if (issue.severity === 'good') continue;
        const id = areaForIssue(issue.key);
        if (!id) continue;
        const e = acc.get(id) ?? { weight: 0, shots: 0 };
        e.weight += SEVERITY_WEIGHT[issue.severity];
        if (!seen.has(id)) {
          e.shots += 1;
          seen.add(id);
        }
        acc.set(id, e);
      }
    }
    return [...acc.entries()]
      .map(([id, v]) => ({ id, weight: v.weight, shots: v.shots }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3);
  }, [shots]);

  // Lowest-scoring shots that have BOTH a clip and a hero capture (worst first).
  const missShots = useMemo<Shot[]>(
    () =>
      shots
        .filter((s) => s.clip && heroCapture(s))
        .sort((a, b) => a.score - b.score)
        .slice(0, 3),
    [shots],
  );

  // Best moment for the highlight share: highest score, preferring a clip.
  const bestShot = useMemo<Shot | null>(() => {
    const withCapture = shots.filter((s) => heroCapture(s));
    if (withCapture.length === 0) return null;
    return [...withCapture].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.clip ? 1 : 0) - (a.clip ? 1 : 0);
    })[0];
  }, [shots]);

  const hasSession = shots.length > 0;
  const allGood = ranked.length === 0;
  const dateLabel = useMemo(
    () =>
      new Date().toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    [lang],
  );

  const shotLabel = (shot: Shot): string =>
    shot.type === 'backhand'
      ? t('shot.backhand')
      : shot.type === 'forehand'
        ? t('shot.forehand')
        : t('devplan.title');

  /** Fix + cue text (current lang) for a shot's top area, or the "best" copy. */
  const fixCueForShot = (shot: Shot): { fix: string; cue: string } => {
    const area = topAreaForShot(shot);
    if (area) {
      return {
        fix: t(`devplan.area.${area}.drill` as I18nKey),
        cue: t(`devplan.area.${area}.cue` as I18nKey),
      };
    }
    return { fix: t('devplan.bestFix'), cue: t('devplan.bestCue') };
  };

  const buildStory = (shot: Shot, kind: 'miss' | 'best'): StoryData => {
    const { fix, cue } = fixCueForShot(shot);
    const titleKey: I18nKey =
      kind === 'best' ? 'devplan.storyBestTitle' : 'devplan.storyMissTitle';
    return {
      titleTh: translate(titleKey, 'th'),
      titleEn: translate(titleKey, 'en'),
      lang,
      score: shot.score,
      shotLabel: shotLabel(shot),
      fixText: fix,
      cueText: cue,
      dateLabel,
    };
  };

  return (
    <div className="screen devplan-screen">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{t('devplan.title')}</h1>
        <button className="btn btn-ghost" onClick={() => setScreen('home')}>
          {t('common.back')}
        </button>
      </div>
      <p className="dim">{t('devplan.subtitle')}</p>

      {!hasSession ? (
        <div className="card col" style={{ gap: 12, alignItems: 'center', textAlign: 'center' }}>
          <span className="dim">{t('devplan.empty')}</span>
          <button className="btn btn-primary" onClick={() => setScreen('home')}>
            {t('devplan.startSession')}
          </button>
        </div>
      ) : (
        <>
          {/* ---- Missed moments ---- */}
          <section className="devplan-section">
            <h3>{t('devplan.missTitle')}</h3>
            <p className="dim devplan-section-sub">{t('devplan.missSubtitle')}</p>

            {missShots.length > 0 ? (
              <div className="col devplan-miss-list">
                {missShots.map((shot) => {
                  const cap = heroCapture(shot)!;
                  const issue = worstIssue(shot);
                  return (
                    <MissClipCard
                      key={shot.id}
                      shot={shot}
                      capture={cap}
                      issue={issue}
                      hand={hand}
                      lang={lang}
                      shareButton={
                        <StoryShareButton
                          capture={cap}
                          hand={hand}
                          data={buildStory(shot, 'miss')}
                          clip={shot.clip}
                          filenameBase={`adge-shot-${shot.index}`}
                          label={t('devplan.shareStory')}
                        />
                      }
                    />
                  );
                })}
              </div>
            ) : (
              <div className="card devplan-note">
                <span className="dim">
                  {allGood ? t('devplan.noMiss') : t('devplan.noClips')}
                </span>
              </div>
            )}
          </section>

          {/* ---- Improvement guidance ---- */}
          <section className="devplan-section">
            {allGood ? (
              <div className="card col" style={{ gap: 6 }}>
                <span className="t-good" style={{ fontWeight: 700 }}>
                  {t('devplan.cleanNote')}
                </span>
              </div>
            ) : (
              <>
                <h3>{t('devplan.guideTitle')}</h3>
                <div className="col devplan-guide-list">
                  {ranked.map((r, i) => (
                    <GuidanceCard key={r.id} area={r.id} rank={i + 1} shots={r.shots} />
                  ))}
                </div>
              </>
            )}
          </section>

          {/* ---- Session highlight share ---- */}
          {bestShot && heroCapture(bestShot) && (
            <section className="devplan-section devplan-summary-share">
              <StoryShareButton
                capture={heroCapture(bestShot)!}
                hand={hand}
                data={buildStory(bestShot, 'best')}
                clip={bestShot.clip}
                filenameBase={`adge-highlight-shot-${bestShot.index}`}
                label={t('devplan.shareSummary')}
                variant="primary"
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structured guidance card: อาการ → เพราะอะไร → วิธีซ้อม → cue
// ---------------------------------------------------------------------------

function GuidanceCard({ area, rank, shots }: { area: AreaId; rank: number; shots: number }) {
  const t = useT();
  const k = (suffix: string) => t(`devplan.area.${area}.${suffix}` as I18nKey);
  return (
    <div className="card col devplan-guide-card" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="row" style={{ gap: 8 }}>
          <span className="rank-dot num">{rank}</span>
          <b>{k('title')}</b>
        </span>
        <span className="faint num devplan-affected">
          {t('devplan.affected')} {shots} {t('devplan.shotsUnit')}
        </span>
      </div>

      <GuideRow label={t('devplan.symptom')} tone="fault" text={k('symptom')} />
      <GuideRow label={t('devplan.why')} tone="dim" text={k('why')} />
      <GuideRow label={t('devplan.drill')} tone="good" text={k('drill')} />
      <div className="devplan-cue">
        <span className="devplan-cue-label">{t('devplan.cue')}</span>
        <span className="devplan-cue-text">“{k('cue')}”</span>
      </div>
    </div>
  );
}

function GuideRow({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: 'fault' | 'good' | 'dim';
}) {
  return (
    <div className="devplan-guide-row">
      <span className={`devplan-guide-tag devplan-tag-${tone}`}>{label}</span>
      <span className="devplan-guide-text">{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Miss clip card: plays the swing clip inline (tap → lightbox), score badge,
// the worst joint issue in plain speech, the phase it happened in, + share.
// ---------------------------------------------------------------------------

interface MissClipCardProps {
  shot: Shot;
  capture: SwingCapture;
  issue: ShotIssue | null;
  hand: DominantHand;
  lang: Lang;
  shareButton: ReactNode;
}

const MissClipCard = memo(function MissClipCard({
  shot,
  capture,
  issue,
  hand,
  lang,
  shareButton,
}: MissClipCardProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [clipFailed, setClipFailed] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const clip = shot.clip;
  const showClip = !!clip && !clipFailed;

  // Rendered still is the fallback when the clip won't decode / is absent.
  useEffect(() => {
    let cancelled = false;
    renderCaptureToDataUrl(capture, hand)
      .then((url) => !cancelled && setImgUrl(url))
      .catch(() => !cancelled && setImgUrl(`data:image/jpeg;base64,${capture.jpegBase64}`));
    return () => {
      cancelled = true;
    };
  }, [capture, hand]);

  const scoreTone =
    shot.score >= 80 ? 't-good' : shot.score >= 60 ? 't-warn' : 't-fault';
  const issueMsg = issue ? (lang === 'th' ? issue.messageTH : issue.messageEN) : '';
  const phaseKey = `phase.${capture.phase}` as I18nKey;

  return (
    <div className="card col devplan-miss-card" style={{ gap: 10 }}>
      <div
        className="devplan-miss-media tap"
        onClick={() => setOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(true)}
      >
        {showClip ? (
          <video
            className="devplan-miss-video"
            src={clip!.url}
            muted
            loop
            playsInline
            autoPlay
            preload="metadata"
            onError={() => setClipFailed(true)}
          />
        ) : imgUrl ? (
          <img className="devplan-miss-video" src={imgUrl} alt={t(phaseKey)} />
        ) : (
          <div className="devplan-miss-video capture-img-loading" />
        )}
        <span className={`devplan-miss-badge num ${scoreTone}`}>
          {t('devplan.missScore')} {shot.score}
        </span>
        <span className="devplan-miss-shot num">
          {t('capture.shot')} {shot.index}
        </span>
        <span className="capture-tap-hint">{t('gallery.clipHint')}</span>
      </div>

      {issueMsg && <p className="devplan-miss-issue">{issueMsg}</p>}
      <span className="devplan-miss-phase dim">
        {t('devplan.missPhase')} {t(phaseKey)}
      </span>

      {shareButton}

      {open && (
        <CaptureLightbox
          capture={capture}
          shotIndex={shot.index}
          clip={shot.clip}
          dominantHand={hand}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
});

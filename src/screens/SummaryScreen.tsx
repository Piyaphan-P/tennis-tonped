import {
  useAppStore,
  selectSessionCostTHB,
  selectTHBPerShot,
  selectShotCount,
  selectAvgScore,
  selectSessionDurationMs,
  selectSessionImprovements,
  selectUserStats,
  GOOD_FORM_SCORE,
} from '../store';
import { useT } from '../i18n';
import type { I18nKey } from '../i18n';
import { formatTHB } from '../cost/pricing';
import type {
  Shot,
  ShotIssue,
  SessionImprovement,
  StoredSession,
  IssueSeverity,
  Lang,
} from '../types';

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--good)';
  if (score >= 60) return 'var(--warn)';
  return 'var(--fault)';
}

/** warn → amber, fault → red. (good is filtered out of improvements/chips-as-issue.) */
function severityColor(sev: IssueSeverity): string {
  if (sev === 'fault') return 'var(--fault)';
  if (sev === 'warn') return 'var(--warn)';
  return 'var(--good)';
}

function fmtDate(tsMs: number, lang: Lang): string {
  try {
    return new Date(tsMs).toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-US', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(tsMs).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Inline SVG sparkline of per-shot scores (0–100), newest on the right. */
function Sparkline({ shots }: { shots: Shot[] }) {
  const W = 300;
  const H = 56;
  const pad = 4;
  if (shots.length === 0) return null;

  const pts = shots.map((sh, i) => {
    const x =
      shots.length === 1
        ? W / 2
        : pad + (i * (W - pad * 2)) / (shots.length - 1);
    const y = pad + ((100 - sh.score) / 100) * (H - pad * 2);
    return [x, y] as const;
  });

  const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="score trend"
    >
      {/* 60 / 80 reference lines */}
      {[60, 80].map((v) => {
        const y = pad + ((100 - v) / 100) * (H - pad * 2);
        return (
          <line
            key={v}
            x1={0}
            x2={W}
            y1={y}
            y2={y}
            stroke="var(--line)"
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        );
      })}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={2.5} fill={scoreColor(shots[i].score)} />
      ))}
      <circle cx={last[0]} cy={last[1]} r={4} fill="var(--accent)" />
    </svg>
  );
}

/** One "Things to Improve" row: severity dot + localized message + count + target. */
function ImprovementRow({
  imp,
  lang,
  affectedLabel,
  shotsUnit,
}: {
  imp: SessionImprovement;
  lang: Lang;
  affectedLabel: string;
  shotsUnit: string;
}) {
  const msg = lang === 'th' ? imp.messageTH : imp.messageEN;
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: severityColor(imp.severity),
          marginTop: 6,
          flex: 'none',
          boxShadow: `0 0 8px ${severityColor(imp.severity)}66`,
        }}
      />
      <div className="col" style={{ gap: 3, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: '0.95rem', fontWeight: 600, lineHeight: 1.35 }}>{msg}</span>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="faint num" style={{ fontSize: '0.72rem' }}>
            {affectedLabel} {imp.count} {shotsUnit}
          </span>
          {imp.target && (
            <span
              className="chip num"
              style={{
                fontSize: '0.7rem',
                padding: '1px 8px',
                borderColor: severityColor(imp.severity),
                color: severityColor(imp.severity),
              }}
            >
              {imp.target}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** A single ShotIssue chip: localized message (or key), measured value in mono. */
function IssueChip({ issue, lang }: { issue: ShotIssue; lang: Lang }) {
  const label = (lang === 'th' ? issue.messageTH : issue.messageEN) || issue.key;
  const color = severityColor(issue.severity);
  return (
    <span
      className="chip"
      style={{
        fontSize: '0.7rem',
        padding: '2px 8px',
        gap: 4,
        borderColor: color,
        color,
        background: 'transparent',
      }}
    >
      <span>{label}</span>
      {issue.measured !== undefined && (
        <span className="num" style={{ opacity: 0.85 }}>
          {issue.measured.toFixed(0)}
        </span>
      )}
    </span>
  );
}

/** Post-session summary: cost, stats, improvements, per-shot cards, breakdown, history. */
export default function SummaryScreen() {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const setScreen = useAppStore((s) => s.setScreen);
  const total = useAppStore(selectSessionCostTHB);
  const perShot = useAppStore(selectTHBPerShot);
  const shotCount = useAppStore(selectShotCount);
  const avg = useAppStore(selectAvgScore);
  const duration = useAppStore(selectSessionDurationMs);
  const tokens = useAppStore((s) => s.cost.tokens);
  const breakdown = useAppStore((s) => s.cost.breakdown);
  const shots = useAppStore((s) => s.shots);
  const improvements = useAppStore(selectSessionImprovements);
  const stats = useAppStore(selectUserStats);
  const history = useAppStore((s) => s.history);

  const goodFormPct =
    shotCount === 0
      ? 0
      : (shots.filter((sh) => sh.score >= GOOD_FORM_SCORE).length / shotCount) * 100;

  const stat = (label: string, value: string) => (
    <div className="card col" style={{ gap: 2 }}>
      <span className="dim" style={{ fontSize: '0.8rem' }}>
        {label}
      </span>
      <span className="num" style={{ fontSize: '1.3rem', fontWeight: 800 }}>
        {value}
      </span>
    </div>
  );

  // THB-per-modality bars. width ∝ largest modality cost; token counts as secondary text.
  const modalityRows: Array<{ label: string; thb: number; tok: number }> = [
    { label: t('token.textIn'), thb: breakdown.textInTHB, tok: tokens.textIn },
    { label: t('token.audioIn'), thb: breakdown.audioInTHB, tok: tokens.audioIn },
    { label: t('token.videoIn'), thb: breakdown.videoInTHB, tok: tokens.videoIn },
    { label: t('token.textOut'), thb: breakdown.textOutTHB, tok: tokens.textOut },
    { label: t('token.audioOut'), thb: breakdown.audioOutTHB, tok: tokens.audioOut },
    { label: t('token.thoughts'), thb: breakdown.thoughtsTHB, tok: tokens.thoughts },
  ];
  const maxTHB = Math.max(...modalityRows.map((r) => r.thb), 0);

  return (
    <div className="screen">
      <h1>{t('summary.title')}</h1>

      <div className="card cost-meter col" style={{ gap: 4 }}>
        <span className="dim">{t('summary.totalCost')}</span>
        <span className="big">{formatTHB(total)}</span>
        <span className="dim num" style={{ fontSize: '0.85rem' }}>
          ~{formatTHB(perShot)} {t('summary.costPerShot')} ({t('common.approx')})
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--sp-3)',
        }}
      >
        {stat(t('summary.totalShots'), String(shotCount))}
        {stat(t('summary.avgScore'), avg.toFixed(0))}
        {stat(t('summary.duration'), fmtDuration(duration))}
        {stat(t('stats.goodForm'), `${goodFormPct.toFixed(0)}%`)}
      </div>

      {/* --- HERO: things to improve (from this session's shot issues) --- */}
      <div className="card col" style={{ gap: 12, borderColor: 'var(--line-strong)' }}>
        <h3>{t('summary.improve')}</h3>
        {improvements.length === 0 ? (
          <span className="t-good" style={{ fontWeight: 700 }}>
            {t('summary.improveNone')}
          </span>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            {improvements.map((imp) => (
              <ImprovementRow
                key={imp.key}
                imp={imp}
                lang={lang}
                affectedLabel={t('devplan.affected')}
                shotsUnit={t('devplan.shotsUnit')}
              />
            ))}
          </div>
        )}
      </div>

      {shots.length > 0 && (
        <div className="card col" style={{ gap: 8 }}>
          <h3>{t('summary.scoreTrend')}</h3>
          <Sparkline shots={shots} />
        </div>
      )}

      {shots.length > 0 ? (
        <div className="card col" style={{ gap: 8 }}>
          <h3>{t('summary.shotsList')}</h3>
          <div className="col" style={{ gap: 6 }}>
            {shots.map((sh) => {
              const typeKey = `shot.${sh.type}` as I18nKey;
              const coach = sh.coaching?.text;
              const contact =
                sh.captures.find((c) => c.phase === 'contact') ?? sh.captures[0];
              return (
                <div key={sh.id} className="shot-row" style={{ alignItems: 'flex-start' }}>
                  <span className="num shot-idx" style={{ marginTop: 2 }}>
                    #{sh.index}
                  </span>
                  {contact && (
                    <img
                      src={`data:image/jpeg;base64,${contact.jpegBase64}`}
                      alt=""
                      style={{
                        width: 46,
                        height: 62,
                        objectFit: 'cover',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--line)',
                        flex: 'none',
                      }}
                    />
                  )}
                  <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                      <span className="dim" style={{ fontSize: '0.85rem' }}>
                        {t(typeKey)}
                      </span>
                      <span className="num faint" style={{ fontSize: '0.75rem' }}>
                        {sh.costTHB !== undefined ? `~${formatTHB(sh.costTHB)}` : '—'}
                      </span>
                    </div>
                    {sh.issues.length > 0 && (
                      <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
                        {sh.issues.map((iss, i) => (
                          <IssueChip key={`${iss.key}-${i}`} issue={iss} lang={lang} />
                        ))}
                      </div>
                    )}
                    {coach && (
                      <span className="faint shot-coach" style={{ fontSize: '0.8rem' }}>
                        {lang === 'th' ? '“' : '"'}
                        {coach}
                        {lang === 'th' ? '”' : '"'}
                      </span>
                    )}
                  </div>
                  <span
                    className="num shot-score"
                    style={{ color: scoreColor(sh.score), marginTop: 2 }}
                  >
                    {Math.round(sh.score)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="dim">{t('summary.noShots')}</p>
      )}

      {/* --- cost by modality: THB bars + secondary token counts --- */}
      <div className="card col" style={{ gap: 10 }}>
        <h3>{t('summary.breakdown')}</h3>
        <div className="col" style={{ gap: 10 }}>
          {modalityRows.map((r) => (
            <div key={r.label} className="col" style={{ gap: 3 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span className="dim" style={{ fontSize: '0.82rem' }}>
                  {r.label}
                </span>
                <span className="num" style={{ fontSize: '0.85rem', fontWeight: 700 }}>
                  {formatTHB(r.thb)}
                </span>
              </div>
              <div
                style={{
                  height: 6,
                  borderRadius: 'var(--radius-pill)',
                  background: 'rgba(255,255,255,0.08)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: maxTHB > 0 ? `${(r.thb / maxTHB) * 100}%` : '0%',
                    background: 'var(--accent)',
                    borderRadius: 'var(--radius-pill)',
                  }}
                />
              </div>
              <span className="faint num" style={{ fontSize: '0.7rem' }}>
                {r.tok.toLocaleString()} tok
              </span>
            </div>
          ))}
        </div>
        <p className="faint" style={{ fontSize: '0.78rem' }}>
          {t('summary.approxNote')}
        </p>
      </div>

      {/* --- cross-session stats (your progress) --- */}
      {stats.sessions > 0 && (
        <div className="card col" style={{ gap: 10 }}>
          <h3>{t('stats.title')}</h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 'var(--sp-3)',
            }}
          >
            <div className="col" style={{ gap: 2 }}>
              <span className="faint" style={{ fontSize: '0.72rem' }}>
                {t('stats.sessions')}
              </span>
              <span className="num" style={{ fontSize: '1.1rem', fontWeight: 800 }}>
                {stats.sessions}
              </span>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="faint" style={{ fontSize: '0.72rem' }}>
                {t('stats.totalShots')}
              </span>
              <span className="num" style={{ fontSize: '1.1rem', fontWeight: 800 }}>
                {stats.totalShots}
              </span>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="faint" style={{ fontSize: '0.72rem' }}>
                {t('stats.avgScore')}
              </span>
              <span
                className="num"
                style={{ fontSize: '1.1rem', fontWeight: 800, color: scoreColor(stats.avgScore) }}
              >
                {stats.avgScore.toFixed(0)}
              </span>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="faint" style={{ fontSize: '0.72rem' }}>
                {t('stats.goodForm')}
              </span>
              <span className="num" style={{ fontSize: '1.1rem', fontWeight: 800 }}>
                {stats.goodFormPct.toFixed(0)}%
              </span>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="faint" style={{ fontSize: '0.72rem' }}>
                {t('stats.bestSpeed')}
              </span>
              <span className="num" style={{ fontSize: '1.1rem', fontWeight: 800 }}>
                {stats.bestPeakWristSpeed.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* --- session history (3-day auto-expiry, pruned in store) --- */}
      <div className="card col" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <h3>{t('history.title')}</h3>
          <span className="faint" style={{ fontSize: '0.7rem', textAlign: 'right' }}>
            {t('history.expiryNote')}
          </span>
        </div>
        {history.length === 0 ? (
          <span className="dim" style={{ fontSize: '0.85rem' }}>
            {t('history.empty')}
          </span>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {[...history]
              .sort((a, b) => b.tsMs - a.tsMs)
              .map((h: StoredSession) => (
                <div key={h.id} className="shot-row" style={{ gap: 10 }}>
                  <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                      {fmtDate(h.tsMs, lang)}
                    </span>
                    <span className="faint num" style={{ fontSize: '0.72rem' }}>
                      {h.shotCount} {t('history.shots')} · {h.goodFormPct.toFixed(0)}%{' '}
                      {t('stats.goodForm')} · ~{formatTHB(h.totalCostTHB)}
                    </span>
                  </div>
                  <span
                    className="num shot-score"
                    style={{ color: scoreColor(h.avgScore), fontSize: '1.1rem' }}
                  >
                    {h.avgScore.toFixed(0)}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="spacer" />

      <div className="row">
        <button className="btn btn-block" onClick={() => setScreen('devplan')}>
          {t('summary.viewPlan')}
        </button>
        <button className="btn btn-primary" onClick={() => setScreen('home')}>
          {t('summary.done')}
        </button>
      </div>
    </div>
  );
}

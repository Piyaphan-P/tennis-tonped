import { useAppStore } from '../store';
import { useT } from '../i18n';
import type { IssueSeverity } from '../types';

// ---------------------------------------------------------------------------
// Issue key → improvement area + drill (bilingual). Several rule keys map to
// the same coaching area so the plan reads as a few clear priorities, not a
// long flat list. Severity weight: fault=2, warn=1 → ranks the worst first.
// ---------------------------------------------------------------------------

interface AreaDef {
  id: string;
  titleTH: string;
  titleEN: string;
  drillTH: string;
  drillEN: string;
}

const AREAS: AreaDef[] = [
  {
    id: 'contact-extension',
    titleTH: 'จุดกระทบและการเหยียดแขน',
    titleEN: 'Contact point & arm extension',
    drillTH:
      'ดริลล์ shadow swing 10 ครั้ง เน้นกระทบลูกด้านหน้าลำตัว ให้ศอกเหยียดราว 140° ทุกครั้ง',
    drillEN:
      '10 shadow swings focusing on a contact point out in front, extending the elbow to ~140° each rep.',
  },
  {
    id: 'knee-load',
    titleTH: 'การย่อเข่าและการโหลดพลัง',
    titleEN: 'Knee bend & loading',
    drillTH:
      'สปลิตสเต็ปแล้วย่อเข่าค้าง 2 วินาทีก่อนตีลูก 15 ลูก ให้เข่าอยู่ราว 130–150°',
    drillEN:
      'Split-step then hold a 2-second knee bend before hitting — 15 balls, knees around 130–150°.',
  },
  {
    id: 'balance',
    titleTH: 'การทรงตัวและลำตัว',
    titleEN: 'Balance & trunk',
    drillTH:
      'ตีโดยตั้งลำตัวให้ตรง จบสวิงแล้วค้างท่า follow-through 2 วินาที เช็กว่าไม่เสียบาลานซ์',
    drillEN:
      'Hit with an upright trunk and hold your follow-through for 2 seconds to check you finish balanced.',
  },
  {
    id: 'racket-prep',
    titleTH: 'การเตรียมไม้และหัวไหล่',
    titleEN: 'Racket prep & shoulder',
    drillTH: 'เน้น unit turn เตรียมไม้ให้เร็วขึ้น ยกแขนให้หัวไหล่อยู่ราว 80–100° ตอนกระทบ',
    drillEN: 'Emphasize an early unit turn; set the shoulder to ~80–100° at contact.',
  },
  {
    id: 'swing-speed',
    titleTH: 'ความเร็วและการเร่งสวิง',
    titleEN: 'Swing speed & acceleration',
    drillTH: 'ดริลล์ low-to-high เร่งความเร็วช่วงเข้าหาลูก ตี 15 ลูกให้เสียงวืดชัดขึ้น',
    drillEN: 'Low-to-high drill: accelerate through the ball — 15 reps chasing a louder swing "whoosh".',
  },
];

const AREA_BY_ID: Record<string, AreaDef> = Object.fromEntries(
  AREAS.map((a) => [a.id, a]),
);

/** Map an emitted ShotIssue.key to its coaching area id. */
function areaForIssue(key: string): string | null {
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
  area: AreaDef;
  weight: number;
  shots: number;
}

/** Personalized dev plan: rank the session's recurring faults into drills. */
export default function DevPlanScreen() {
  const t = useT();
  const lang = useAppStore((s) => s.lang);
  const setScreen = useAppStore((s) => s.setScreen);
  const shots = useAppStore((s) => s.shots);

  // Aggregate weighted issue counts per area across all shots.
  const acc = new Map<string, { weight: number; shots: number }>();
  for (const shot of shots) {
    const seenThisShot = new Set<string>();
    for (const issue of shot.issues) {
      if (issue.severity === 'good') continue;
      const areaId = areaForIssue(issue.key);
      if (!areaId) continue;
      const entry = acc.get(areaId) ?? { weight: 0, shots: 0 };
      entry.weight += SEVERITY_WEIGHT[issue.severity];
      if (!seenThisShot.has(areaId)) {
        entry.shots += 1;
        seenThisShot.add(areaId);
      }
      acc.set(areaId, entry);
    }
  }

  const ranked: RankedArea[] = [...acc.entries()]
    .map(([id, v]) => ({ area: AREA_BY_ID[id], weight: v.weight, shots: v.shots }))
    .filter((r) => r.area)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);

  const hasSession = shots.length > 0;
  const title = (a: AreaDef) => (lang === 'th' ? a.titleTH : a.titleEN);
  const drill = (a: AreaDef) => (lang === 'th' ? a.drillTH : a.drillEN);

  return (
    <div className="screen">
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
      ) : ranked.length === 0 ? (
        <div className="card col" style={{ gap: 6 }}>
          <span className="t-good" style={{ fontWeight: 700 }}>
            {t('devplan.cleanNote')}
          </span>
        </div>
      ) : (
        <>
          <h3>{t('devplan.focusAreas')}</h3>
          <div className="col">
            {ranked.map((r, i) => (
              <div key={r.area.id} className="card col" style={{ gap: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="rank-dot num">{i + 1}</span>
                    <b>{title(r.area)}</b>
                  </span>
                  <span className="faint num" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                    {t('devplan.affected')} {r.shots} {t('devplan.shotsUnit')}
                  </span>
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <span className="dim" style={{ fontSize: '0.8rem' }}>
                    {t('devplan.drills')}
                  </span>
                  <span style={{ fontSize: '0.9rem' }}>{drill(r.area)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

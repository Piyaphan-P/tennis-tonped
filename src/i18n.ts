// ============================================================================
// ต้นและเพชร Tennis Club — i18n (TH primary, EN switchable)
//
// Usage in components:
//   const t = useT();
//   <h1>{t('home.title')}</h1>
//
// Non-hook (imperative modules):
//   translate('coach.reconnecting', 'th')
//
// Language persistence lives in store.setLang (localStorage 'tp.lang').
// RULE: user-visible error states MUST come from keys here (both languages) —
// never raw API/English error strings.
// ============================================================================

import { useAppStore } from './store';
import type { Lang } from './types';

// ---------------------------------------------------------------------------
// Dictionary. Every key carries both languages. TH is authored first.
// ---------------------------------------------------------------------------

const DICT = {
  // --- brand / common ---
  'brand.name': { th: 'ต้นและเพชร เทนนิส คลับ', en: 'Ton & Phet Tennis Club' },
  'brand.coach': { th: 'โค้ชต้นและเพชร', en: 'Coach Ton & Phet' },
  'common.close': { th: 'ปิด', en: 'Close' },
  'common.back': { th: 'ย้อนกลับ', en: 'Back' },
  'common.save': { th: 'บันทึก', en: 'Save' },
  'common.reset': { th: 'รีเซ็ต', en: 'Reset' },
  'common.baht': { th: 'บาท', en: 'THB' },
  'common.approx': { th: 'โดยประมาณ', en: 'approx.' },
  'common.perShot': { th: 'ต่อครั้ง', en: 'per shot' },
  'common.loading': { th: 'กำลังโหลด…', en: 'Loading…' },
  'common.times': { th: 'ครั้ง', en: 'x' },

  // --- language toggle ---
  'lang.th': { th: 'ไทย', en: 'Thai' },
  'lang.en': { th: 'อังกฤษ', en: 'English' },

  // --- home screen ---
  'home.title': { th: 'ต้นและเพชร เทนนิส คลับ', en: 'Ton & Phet Tennis Club' },
  'home.tagline': {
    th: 'โค้ชเทนนิสส่วนตัว วิเคราะห์ฟอร์มเรียลไทม์ข้างคอร์ต',
    en: 'Your personal courtside coach — realtime form analysis',
  },
  'home.start': { th: 'เริ่มฝึกซ้อม', en: 'Start Session' },
  'home.subtitle': {
    th: 'วางโทรศัพท์แนวตั้ง หันกล้องมาที่ตัวคุณ',
    en: 'Prop your phone in portrait, camera facing you',
  },
  'home.devplan': { th: 'แผนพัฒนา', en: 'Dev Plan' },
  'home.settings': { th: 'ตั้งค่า', en: 'Settings' },
  'home.setup': { th: 'ตั้งค่าการฝึก', en: 'Session Setup' },
  'home.yourName': { th: 'ชื่อของคุณ', en: 'Your Name' },
  'home.namePlaceholder': { th: 'พิมพ์ชื่อเล่นของคุณ…', en: 'Type your nickname…' },
  'home.nameHint': {
    th: 'โค้ชจะเรียกชื่อคุณตอนสอน',
    en: 'The coach will call you by this name',
  },
  'home.focusShot': { th: 'ลูกที่จะฝึก', en: 'Focus Shot' },
  'home.forehand': { th: 'โฟร์แฮนด์', en: 'Forehand' },
  'home.backhand': { th: 'แบ็คแฮนด์', en: 'Backhand' },
  'home.both': { th: 'ทั้งสอง', en: 'Both' },

  // --- errors (ALWAYS bilingual, never raw API strings) ---
  'error.tokenMissing.title': { th: 'ยังไม่ได้ตั้งค่าโทเคนโค้ช', en: 'Coach token not set' },
  'error.tokenMissing.body': {
    th: 'วางโทเคน Gemini ชั่วคราว (ขึ้นต้น AQ.) ในหน้าตั้งค่า จึงจะคุยกับโค้ชได้ — การวิเคราะห์ท่าและคะแนนยังใช้งานได้ปกติ',
    en: 'Paste a Gemini ephemeral token (starts with AQ.) in Settings to enable the coach — pose analysis and scoring still work without it.',
  },
  'error.cameraDenied.title': { th: 'เข้าถึงกล้องไม่ได้', en: 'Camera unavailable' },
  'error.cameraDenied.body': {
    th: 'แอปต้องใช้กล้องเพื่อวิเคราะห์วงสวิง โปรดอนุญาตการใช้กล้องในการตั้งค่าเบราว์เซอร์ แล้วลองใหม่',
    en: 'The app needs your camera to analyze your swing. Allow camera access in your browser settings and try again.',
  },
  'error.poseInitFailed.title': { th: 'โหลดตัววิเคราะห์ท่าไม่สำเร็จ', en: 'Pose engine failed to load' },
  'error.poseInitFailed.body': {
    th: 'โหลดโมเดลวิเคราะห์ท่าทางไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองเข้าใหม่อีกครั้ง',
    en: 'Could not load the pose model. Check your connection and reload the app.',
  },
  'error.micDenied': {
    th: 'ใช้ไมโครโฟนไม่ได้ โปรดอนุญาตไมค์ในเบราว์เซอร์',
    en: 'Microphone unavailable — allow mic access in your browser.',
  },
  'error.retry': { th: 'ลองใหม่', en: 'Retry' },

  // --- score badge ---
  'score.latest': { th: 'ช็อตล่าสุด', en: 'Last shot' },
  'score.waiting': { th: 'รอช็อตแรก…', en: 'Awaiting first shot…' },

  // --- shot types ---
  'shot.forehand': { th: 'โฟร์แฮนด์', en: 'Forehand' },
  'shot.backhand': { th: 'แบ็คแฮนด์', en: 'Backhand' },
  'shot.unknown': { th: 'ไม่ทราบชนิด', en: 'Unknown' },

  // --- bottom nav ---
  'nav.home': { th: 'หน้าหลัก', en: 'Home' },
  'nav.summary': { th: 'สรุป', en: 'Summary' },
  'nav.devplan': { th: 'พัฒนา', en: 'Plan' },
  'nav.settings': { th: 'ตั้งค่า', en: 'Settings' },

  // --- continuous open mic ---
  'live.micOn': { th: 'ไมค์เปิด — พูดกับโค้ชได้เลย', en: 'Mic on — just talk to the coach' },
  'live.micOff': { th: 'ไมค์ปิด', en: 'Mic off' },

  // --- live screen ---
  'live.title': { th: 'กำลังฝึกซ้อม', en: 'Live Session' },
  'live.connecting': { th: 'กำลังเชื่อมต่อโค้ช…', en: 'Connecting to coach…' },
  'live.connected': { th: 'เชื่อมต่อแล้ว', en: 'Connected' },
  'live.disconnected': { th: 'ยังไม่เชื่อมต่อ', en: 'Disconnected' },
  'live.end': { th: 'จบการฝึก', en: 'End Session' },
  'live.listening': { th: 'กำลังฟัง…', en: 'Listening…' },
  'live.shots': { th: 'จำนวนช็อต', en: 'Shots' },
  'live.fps': { th: 'เฟรมต่อวินาที', en: 'FPS' },
  'live.phase': { th: 'ช่วงสวิง', en: 'Phase' },
  'live.score': { th: 'คะแนน', en: 'Score' },
  'live.waitingPose': { th: 'กำลังหาตัวผู้เล่น…', en: 'Looking for player…' },
  'live.captures': { th: 'ภาพจังหวะสวิง', en: 'Swing Captures' },
  'live.noCaptures': {
    th: 'ตีลูกแรกเพื่อดูภาพวิเคราะห์วงสวิง',
    en: 'Hit your first ball to see swing analysis frames',
  },

  // --- skeleton color legend ---
  'legend.neutral': { th: 'ติดตามท่า', en: 'Tracking' },
  'legend.good': { th: 'ฟอร์มดี', en: 'Good form' },
  'legend.fix': { th: 'ต้องปรับ', en: 'Needs fix' },

  // --- shot phases ---
  'phase.idle': { th: 'พร้อม', en: 'Idle' },
  'phase.preparation': { th: 'เตรียมตัว', en: 'Preparation' },
  'phase.backswing': { th: 'เหวี่ยงหลัง', en: 'Backswing' },
  'phase.forward-swing': { th: 'เหวี่ยงหน้า', en: 'Forward Swing' },
  'phase.contact': { th: 'สัมผัสลูก', en: 'Contact' },
  'phase.follow-through': { th: 'ส่งลูก', en: 'Follow-through' },

  // --- coach ---
  'coach.thinking': { th: 'โค้ชกำลังคิด…', en: 'Coach is thinking…' },
  'coach.speaking': { th: 'โค้ชกำลังพูด', en: 'Coach speaking' },
  'coach.reconnecting': {
    th: 'โค้ชหลุด กำลังเชื่อมต่อใหม่…',
    en: 'Coach dropped — reconnecting…',
  },
  'coach.connectionLost': {
    th: 'เชื่อมต่อโค้ชไม่สำเร็จ การวิเคราะห์ท่ายังทำงานต่อ',
    en: 'Could not reach the coach — pose analysis keeps working.',
  },
  'coach.error': { th: 'โค้ชขัดข้อง', en: 'Coach error' },
  'coach.persona': {
    th: 'โค้ชต้นและเพชร: พูดสั้น กระชับ ให้กำลังใจ',
    en: 'Coach Ton & Phet: short, punchy, encouraging',
  },

  // --- capture gallery / critique ---
  'capture.critique': { th: 'โค้ชวิเคราะห์ภาพนี้', en: "Coach's take on this frame" },
  'capture.pending': { th: 'รอโค้ชวิเคราะห์…', en: 'Waiting for the coach…' },
  'capture.shot': { th: 'ช็อต', en: 'Shot' },
  'capture.tapHint': { th: 'แตะเพื่อขยาย', en: 'Tap to enlarge' },

  // --- capture gallery empty state (feature visible before first capture) ---
  'gallery.empty': {
    th: 'สวิงให้สุดวง — ภาพช็อตจะแสดงที่นี่',
    en: 'Complete a swing — shot captures appear here',
  },

  // --- on-court detection HUD (phase trail short forms, TH primary) ---
  'hud.phase.idle': { th: 'พร้อม', en: 'Idle' },
  'hud.phase.prep': { th: 'เตรียม', en: 'Prep' },
  'hud.phase.back': { th: 'ง้าง', en: 'Back' },
  'hud.phase.fwd': { th: 'สวิง', en: 'Fwd' },
  'hud.phase.contact': { th: 'กระทบ', en: 'Hit' },
  'hud.phase.follow': { th: 'ส่ง', en: 'Follow' },
  'hud.speed': { th: 'สปีด', en: 'spd' },
  'hud.shots': { th: 'ช็อต', en: 'Shots' },
  'hud.skip': { th: 'ทิ้ง', en: 'skip' },
  'hud.captured': { th: 'บันทึกภาพแล้ว', en: 'Captured' },
  'hud.completed': { th: 'ช็อต #{n} ✓ พีค {peak}', en: 'Shot #{n} ✓ peak {peak}' },
  'hud.discard.noContact': {
    th: 'สวิงไม่ถึงจุดกระทบ (พีค {peak})',
    en: 'swing missed contact (peak {peak})',
  },
  'hud.discard.tooShort': {
    th: 'สวิงสั้นเกินไป ({ms}ms)',
    en: 'swing too short ({ms}ms)',
  },
  'hud.discard.tooLong': {
    th: 'สวิงยาวเกินไป ({ms}ms)',
    en: 'swing too long ({ms}ms)',
  },

  // --- cost (demoted: corner ฿ button + testing panel) ---
  'cost.button': { th: 'ดูค่าใช้จ่าย', en: 'View cost' },
  'cost.title': { th: 'ค่าใช้จ่าย (สำหรับทดสอบ)', en: 'Cost (testing)' },
  'cost.total': { th: 'รวมทั้งเซสชัน', en: 'Session total' },
  'cost.usageEvents': { th: 'ข้อความ usage', en: 'usage events' },

  // --- summary screen ---
  'summary.title': { th: 'สรุปการฝึก', en: 'Session Summary' },
  'summary.totalCost': { th: 'ค่าใช้จ่ายรวม', en: 'Total Cost' },
  'summary.costPerShot': { th: 'ค่าใช้จ่ายต่อครั้ง', en: 'Cost per Shot' },
  'summary.totalShots': { th: 'ช็อตทั้งหมด', en: 'Total Shots' },
  'summary.avgScore': { th: 'คะแนนเฉลี่ย', en: 'Average Score' },
  'summary.duration': { th: 'ระยะเวลา', en: 'Duration' },
  'summary.tokens': { th: 'โทเคนตามประเภท', en: 'Tokens by Modality' },
  'summary.breakdown': { th: 'ค่าใช้จ่ายตามประเภท (บาท)', en: 'Cost by Modality (THB)' },
  'summary.improve': { th: 'สิ่งที่ควรปรับปรุง', en: 'Things to Improve' },
  'summary.improveNone': {
    th: 'ฟอร์มโดยรวมดีมาก ไม่พบจุดที่ต้องแก้ซ้ำ ๆ ในเซสชันนี้',
    en: 'Great overall form — no recurring faults this session.',
  },
  'summary.issues': { th: 'จุดที่พบ', en: 'Issues' },
  'summary.approxNote': {
    th: 'ค่าใช้จ่ายต่อครั้งเป็นค่าประมาณจาก usageMetadata',
    en: 'Per-shot cost is approximate, derived from usageMetadata',
  },
  'summary.done': { th: 'กลับหน้าหลัก', en: 'Back to Home' },
  'summary.noShots': { th: 'ยังไม่มีช็อตในเซสชันนี้', en: 'No shots in this session' },
  'summary.shotsList': { th: 'รายการช็อต', en: 'Shots' },
  'summary.scoreTrend': { th: 'แนวโน้มคะแนน', en: 'Score Trend' },
  'summary.viewPlan': { th: 'ดูแผนพัฒนา', en: 'View Dev Plan' },

  // --- stats (cross-session, Home) ---
  'stats.title': { th: 'สถิติของคุณ', en: 'Your Stats' },
  'stats.sessions': { th: 'เซสชัน', en: 'Sessions' },
  'stats.totalShots': { th: 'ช็อตสะสม', en: 'Total Shots' },
  'stats.avgScore': { th: 'คะแนนเฉลี่ย', en: 'Avg Score' },
  'stats.goodForm': { th: 'ฟอร์มดี', en: 'Good Form' },
  'stats.bestSpeed': { th: 'สวิงเร็วสุด', en: 'Best Speed' },

  // --- session history (3-day auto-expiry) ---
  'history.title': { th: 'ประวัติการฝึก', en: 'Session History' },
  'history.empty': {
    th: 'ยังไม่มีประวัติ เริ่มฝึกเซสชันแรกของคุณเลย',
    en: 'No history yet — start your first session!',
  },
  'history.expiryNote': {
    th: 'ประวัติเก็บไว้ 3 วัน แล้วลบอัตโนมัติ',
    en: 'History is kept for 3 days, then auto-deleted',
  },
  'history.shots': { th: 'ช็อต', en: 'shots' },

  // --- token modality labels ---
  'token.textIn': { th: 'ข้อความเข้า', en: 'Text In' },
  'token.audioIn': { th: 'เสียงเข้า', en: 'Audio In' },
  'token.videoIn': { th: 'วิดีโอเข้า', en: 'Video In' },
  'token.textOut': { th: 'ข้อความออก', en: 'Text Out' },
  'token.audioOut': { th: 'เสียงออก', en: 'Audio Out' },
  'token.thoughts': { th: 'การคิด', en: 'Thoughts' },

  // --- settings ---
  'settings.title': { th: 'ตั้งค่า', en: 'Settings' },
  'settings.pricing': { th: 'ราคา (USD ต่อ 1M โทเคน)', en: 'Pricing (USD per 1M tokens)' },
  'settings.textIn': { th: 'ข้อความเข้า', en: 'Text In' },
  'settings.audioIn': { th: 'เสียงเข้า', en: 'Audio In' },
  'settings.videoIn': { th: 'วิดีโอเข้า', en: 'Video In' },
  'settings.textOut': { th: 'ข้อความออก', en: 'Text Out' },
  'settings.audioOut': { th: 'เสียงออก', en: 'Audio Out' },
  'settings.usdToThb': { th: 'อัตราแลกเปลี่ยน USD→THB', en: 'USD→THB Rate' },
  'settings.sendFrame': { th: 'ส่งภาพจังหวะสัมผัสลูก', en: 'Send contact frame' },
  'settings.coachVoice': { th: 'เปิดเสียงโค้ช', en: 'Coach voice' },
  'settings.dominantHand': { th: 'มือถนัด', en: 'Dominant hand' },
  'settings.handLeft': { th: 'ซ้าย', en: 'Left' },
  'settings.handRight': { th: 'ขวา', en: 'Right' },
  'settings.camera': { th: 'กล้อง', en: 'Camera' },
  'settings.cameraUser': { th: 'กล้องหน้า', en: 'Front' },
  'settings.cameraEnv': { th: 'กล้องหลัง', en: 'Rear' },
  'settings.session': { th: 'การฝึกซ้อม', en: 'Session' },
  'settings.token': { th: 'โทเคน Gemini (AQ.…)', en: 'Gemini token (AQ.…)' },
  'settings.tokenHint': {
    th: 'วางโทเคนชั่วคราวใหม่เพื่อเชื่อมต่อโค้ชโดยไม่ต้อง build ใหม่',
    en: 'Paste a fresh ephemeral token to connect the coach without rebuilding.',
  },
  'settings.tokenSet': { th: 'ตั้งค่าโทเคนแล้ว', en: 'Token set' },
  'settings.tokenNone': { th: 'ยังไม่มีโทเคน', en: 'No token' },

  // --- dev plan screen ---
  'devplan.title': { th: 'แผนพัฒนา', en: 'Development Plan' },
  'devplan.subtitle': {
    th: 'จุดที่ควรพัฒนาและดริลล์แนะนำ จากเซสชันล่าสุด',
    en: 'Top areas to improve and suggested drills from your latest session',
  },
  'devplan.focusAreas': { th: 'จุดที่ควรพัฒนา', en: 'Top Improvement Areas' },
  'devplan.drills': { th: 'ดริลล์แนะนำ', en: 'Suggested Drills' },
  'devplan.empty': {
    th: 'ยังไม่มีข้อมูลช็อต เริ่มฝึกซ้อมเพื่อรับแผนพัฒนาเฉพาะตัว',
    en: 'No shot data yet — start a session to get your personalized plan.',
  },
  'devplan.affected': { th: 'พบใน', en: 'seen in' },
  'devplan.shotsUnit': { th: 'ช็อต', en: 'shots' },
  'devplan.startSession': { th: 'เริ่มฝึกซ้อม', en: 'Start a Session' },
  'devplan.cleanNote': {
    th: 'ฟอร์มโดยรวมดีมาก ไม่พบจุดที่ต้องแก้ไขซ้ำ ๆ',
    en: 'Great overall form — no recurring faults detected.',
  },
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type I18nKey = keyof typeof DICT;

/** True if `key` exists in the dictionary (for translating stored error keys). */
export function isI18nKey(key: string): key is I18nKey {
  return key in DICT;
}

/** Translate a key into the given language. Falls back to the key if missing. */
export function translate(key: I18nKey, lang: Lang): string {
  const entry = DICT[key];
  if (!entry) return key;
  return entry[lang] ?? entry.th ?? key;
}

/**
 * Translate a string that SHOULD be an i18n key (store error slots). Unknown
 * strings fall back to the generic coach-error copy — raw API/English strings
 * must never reach the screen.
 */
export function translateError(key: string, lang: Lang): string {
  return isI18nKey(key) ? translate(key, lang) : translate('coach.error', lang);
}

/** Reactive translator hook. Re-renders when the store language changes. */
export function useT(): (key: I18nKey) => string {
  const lang = useAppStore((s) => s.lang);
  return (key: I18nKey) => translate(key, lang);
}

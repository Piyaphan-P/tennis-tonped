// ============================================================================
// ADGE Tennis — i18n (TH primary, EN switchable)
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
  'brand.name': { th: 'ADGE Tennis', en: 'ADGE Tennis' },
  'brand.coach': { th: 'โค้ช ADGE', en: 'Coach ADGE' },
  'common.close': { th: 'ปิด', en: 'Close' },
  'common.back': { th: 'ย้อนกลับ', en: 'Back' },
  'common.save': { th: 'บันทึก', en: 'Save' },
  'common.reset': { th: 'รีเซ็ต', en: 'Reset' },
  'common.baht': { th: 'บาท', en: 'THB' },
  'common.approx': { th: 'โดยประมาณ', en: 'approx.' },
  'common.perShot': { th: 'ต่อครั้ง', en: 'per shot' },
  'common.loading': { th: 'กำลังโหลด…', en: 'Loading…' },
  'common.times': { th: 'ครั้ง', en: 'x' },

  // --- login gate (UAM v1.5: per-user email+password) ---
  'login.title': { th: 'เข้าสู่ระบบ', en: 'Sign in' },
  'login.subtitle': { th: 'กรอกอีเมลและรหัสผ่านเพื่อเริ่มใช้งาน', en: 'Enter your email and password to continue' },
  'login.email': { th: 'อีเมล', en: 'Email' },
  'login.pass': { th: 'รหัสผ่าน', en: 'Password' },
  'login.submit': { th: 'เข้าสู่ระบบ', en: 'Sign in' },
  'login.checking': { th: 'กำลังตรวจสอบ…', en: 'Checking…' },
  'login.wrong': { th: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', en: 'Wrong email or password' },
  'login.tooMany': {
    th: 'ลองเข้าสู่ระบบผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่',
    en: 'Too many attempts — wait a moment and try again',
  },
  'login.error': { th: 'เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง', en: 'Connection failed — try again' },

  // --- language toggle ---
  'lang.th': { th: 'ไทย', en: 'Thai' },
  'lang.en': { th: 'อังกฤษ', en: 'English' },

  // --- home screen ---
  'home.title': { th: 'ADGE Tennis', en: 'ADGE Tennis' },
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
  'home.handedness.title': { th: 'มือที่ถือแร็กเกต', en: 'Racket Hand' },
  'home.handedness.right': { th: 'ถนัดขวา 🎾', en: 'Right-handed 🎾' },
  'home.handedness.left': { th: 'ถนัดซ้าย 🎾', en: 'Left-handed 🎾' },
  'home.handedness.explainer': {
    th: 'การแยกโฟร์แฮนด์/แบ็คแฮนด์ใช้มือที่เลือกนี้',
    en: 'Forehand/backhand detection uses this hand.',
  },
  'home.handedness.current': { th: 'กำลังวิเคราะห์แบบมือ', en: 'Analyzing as' },

  // --- errors (ALWAYS bilingual, never raw API strings) ---
  // (The manual token field was removed 2026-07-20 — coach auth is provisioned
  // server-side, so this copy no longer tells the user to paste anything.)
  'error.tokenMissing.body': {
    th: 'ยังเชื่อมต่อโค้ชไม่ได้ในตอนนี้ — การวิเคราะห์ท่าและคะแนนยังใช้งานได้ปกติ',
    en: 'The coach cannot connect right now — pose analysis and scoring still work.',
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

  // --- coach spoken shot-name opener (v0.7): every critique OPENS by naming
  // the shot number + stroke, in the reply language. {n} = shot number. ---
  'coach.shotOpener.forehand': { th: 'ช็อตที่ {n} โฟร์แฮนด์', en: 'Shot {n}, forehand' },
  'coach.shotOpener.backhand': { th: 'ช็อตที่ {n} แบ็คแฮนด์', en: 'Shot {n}, backhand' },
  'coach.shotOpener.unknown': { th: 'ช็อตที่ {n}', en: 'Shot {n}' },

  // --- bottom nav ---
  'nav.home': { th: 'หน้าหลัก', en: 'Home' },
  'nav.history': { th: 'ประวัติ', en: 'History' },
  'nav.summary': { th: 'สรุป', en: 'Summary' },
  'nav.devplan': { th: 'พัฒนา', en: 'Plan' },
  'nav.settings': { th: 'ตั้งค่า', en: 'Settings' },
  'nav.admin': { th: 'ผู้ดูแล', en: 'Admin' },

  // --- admin screen (UAM v1.5 — role 'admin' only) ---
  'admin.title': { th: 'จัดการผู้เล่น', en: 'Manage players' },
  'admin.signedInAs': { th: 'เข้าสู่ระบบเป็น', en: 'Signed in as' },
  'admin.logout': { th: 'ออกจากระบบ', en: 'Log out' },
  'admin.addTitle': { th: 'เพิ่มผู้เล่น', en: 'Add player' },
  'admin.password': { th: 'รหัสผ่าน (อย่างน้อย 4 ตัวอักษร)', en: 'Password (min 4 characters)' },
  'admin.displayName': { th: 'ชื่อที่แสดง (ไม่บังคับ)', en: 'Display name (optional)' },
  'admin.add': { th: 'เพิ่มผู้เล่น', en: 'Add player' },
  'admin.listTitle': { th: 'ผู้เล่นทั้งหมด', en: 'All players' },
  'admin.you': { th: 'คุณ', en: 'you' },
  'admin.roleAdmin': { th: 'แอดมิน', en: 'admin' },
  'admin.disabledBadge': { th: 'ปิดใช้งาน', en: 'disabled' },
  'admin.created': { th: 'สร้างเมื่อ', en: 'Created' },
  'admin.enable': { th: 'เปิดใช้งาน', en: 'Enable' },
  'admin.disable': { th: 'ระงับ', en: 'Disable' },
  'admin.resetPass': { th: 'รีเซ็ตรหัสผ่าน', en: 'Reset password' },
  'admin.resetPrompt': {
    th: 'รหัสผ่านใหม่สำหรับ {email} (อย่างน้อย 4 ตัวอักษร)',
    en: 'New password for {email} (min 4 characters)',
  },
  'admin.delete': { th: 'ลบ', en: 'Delete' },
  'admin.deleteConfirm': {
    th: 'ลบผู้เล่น {email}? ประวัติ session จะหมดอายุเองใน 3 วัน',
    en: 'Delete player {email}? Their session history expires on its own within 3 days.',
  },
  'admin.empty': { th: 'ยังไม่มีผู้เล่น', en: 'No players yet' },
  'admin.loadFailed': { th: 'โหลดรายชื่อไม่สำเร็จ ลองใหม่อีกครั้ง', en: 'Failed to load players — try again' },
  'admin.retry': { th: 'ลองใหม่', en: 'Retry' },
  'admin.added': { th: 'เพิ่มผู้เล่นแล้ว', en: 'Player added' },
  'admin.updated': { th: 'บันทึกแล้ว', en: 'Saved' },
  'admin.deleted': { th: 'ลบผู้เล่นแล้ว', en: 'Player deleted' },
  'admin.errInvalidEmail': { th: 'รูปแบบอีเมลไม่ถูกต้อง', en: 'Invalid email format' },
  'admin.errPassShort': {
    th: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร',
    en: 'Password must be at least 4 characters',
  },
  'admin.errUserExists': { th: 'มีผู้ใช้อีเมลนี้อยู่แล้ว', en: 'A user with this email already exists' },
  'admin.errFailed': { th: 'ดำเนินการไม่สำเร็จ ลองใหม่อีกครั้ง', en: 'Action failed — try again' },

  // --- admin cost section (GET /api/usage — real Gemini spend, ≈-labelled) ---
  'admin.costTitle': { th: 'ค่าใช้จ่าย', en: 'Costs' },
  'admin.costTotal': { th: 'รวมทั้งหมด (Gemini)', en: 'Total (Gemini)' },
  'admin.costUser': { th: 'อีเมล', en: 'Email' },
  'admin.costName': { th: 'ชื่อ', en: 'Name' },
  'admin.costThb': { th: 'THB ≈', en: 'THB ≈' },
  'admin.costTokensIn': { th: 'โทเคนเข้า', en: 'Tokens in' },
  'admin.costTokensOut': { th: 'โทเคนออก', en: 'Tokens out' },
  'admin.costSessions': { th: 'เซสชัน', en: 'Sessions' },
  'admin.costEmpty': { th: 'ยังไม่มีข้อมูลค่าใช้จ่าย', en: 'No usage data yet' },
  'admin.costLoadFailed': {
    th: 'โหลดข้อมูลค่าใช้จ่ายไม่สำเร็จ ลองใหม่อีกครั้ง',
    en: 'Failed to load costs — try again',
  },
  'admin.costInfraTitle': { th: 'ค่าโครงสร้างพื้นฐาน (ประมาณการ)', en: 'Infra (estimate)' },
  'admin.costInfraRun': {
    th: 'Cloud Run (scale-to-zero) ≈ ฿0–20/เดือน',
    en: 'Cloud Run (scale-to-zero) ≈ ฿0–20/month',
  },
  'admin.costInfraAr': { th: 'Artifact Registry ≈ ฿5/เดือน', en: 'Artifact Registry ≈ ฿5/month' },
  'admin.costInfraStore': {
    th: 'GCS + Firestore อยู่ใน free tier ≈ ฿0',
    en: 'GCS + Firestore within the free tier ≈ ฿0',
  },
  'admin.costInfraNote': {
    th: 'ประมาณการคงที่ ไม่ใช่บิลจริง',
    en: 'Static estimates — not an actual bill',
  },

  // --- continuous open mic ---
  'live.micOn': { th: 'ไมค์เปิด — พูดกับโค้ชได้เลย', en: 'Mic on — just talk to the coach' },
  'live.micOff': { th: 'ไมค์ปิด', en: 'Mic off' },

  // --- live screen ---
  'live.title': { th: 'กำลังฝึกซ้อม', en: 'Live Session' },
  'live.connecting': { th: 'กำลังเชื่อมต่อโค้ช…', en: 'Connecting to coach…' },
  'live.connected': { th: 'เชื่อมต่อแล้ว', en: 'Connected' },
  'live.disconnected': { th: 'ยังไม่เชื่อมต่อ', en: 'Disconnected' },
  // Non-blocking reassurance when the coach cannot connect at all — everything
  // local (pose, scoring, captures, clips, cloud sync, history) keeps working.
  'live.coachOffline': {
    th: 'โค้ชออฟไลน์ — เก็บคลิป/คะแนนตามปกติ',
    en: 'Coach offline — clips & scores still recording.',
  },
  'live.end': { th: 'จบการฝึก', en: 'End Session' },
  'live.flipCamera': { th: 'สลับกล้อง', en: 'Flip camera' },
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
  // Relay transport (Vertex): the server refused the Live session (permission /
  // credentials). Permanent — no auto-retry. Pose analysis is unaffected.
  'coach.relayDenied': {
    th: 'เชื่อมต่อโค้ชไม่ได้ (เซิร์ฟเวอร์ปฏิเสธสิทธิ์) การวิเคราะห์ท่ายังทำงานต่อ',
    en: 'Coach unavailable — server denied the voice session. Pose analysis keeps working.',
  },
  'coach.error': { th: 'โค้ชขัดข้อง', en: 'Coach error' },
  'coach.persona': {
    th: 'โค้ช ADGE: พูดสั้น กระชับ ให้กำลังใจ',
    en: 'Coach ADGE: short, punchy, encouraging',
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
  'gallery.clipHint': { th: 'แตะเพื่อดูวิดีโอสวิง', en: 'Tap to watch the swing' },

  // --- swing video clips ---
  'clip.badge': { th: 'วิดีโอ', en: 'Video' },
  'clip.replay': { th: 'ดูซ้ำ', en: 'Replay' },

  // --- on-court detection HUD (phase trail short forms, TH primary) ---
  'hud.phase.idle': { th: 'พร้อม', en: 'Idle' },
  'hud.phase.prep': { th: 'เตรียม', en: 'Prep' },
  'hud.phase.back': { th: 'ง้าง', en: 'Back' },
  'hud.phase.fwd': { th: 'สวิง', en: 'Fwd' },
  'hud.phase.contact': { th: 'กระทบ', en: 'Hit' },
  'hud.phase.follow': { th: 'ส่ง', en: 'Follow' },
  'hud.speed': { th: 'สปีด', en: 'spd' },
  'hud.fps': { th: 'เฟรม/วิ', en: 'fps' },
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
  'hud.discard.cooldown': {
    th: 'พักระหว่างช็อต (คูลดาวน์)',
    en: 'resting between shots (cooldown)',
  },
  'hud.discard.coachSpeaking': {
    th: 'รอโค้ชพูดจบก่อน…',
    en: 'waiting for the coach to finish…',
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
  'history.title': { th: 'ประวัติการฝึก', en: 'Training History' },
  'history.empty': {
    th: 'ยังไม่มีประวัติใน 3 วันที่ผ่านมา',
    en: 'No sessions in the last 3 days',
  },
  'history.expiryNote': {
    th: 'ประวัติเก็บไว้ 3 วัน แล้วลบอัตโนมัติ',
    en: 'History is kept for 3 days, then auto-deleted',
  },
  'history.shots': { th: 'ลูก', en: 'shots' },
  'history.loading': { th: 'กำลังโหลดประวัติ…', en: 'Loading history…' },
  'history.offlineNote': {
    th: 'โหมดออฟไลน์ — แสดงสถิติที่บันทึกในเครื่องเท่านั้น',
    en: 'Offline — showing device-only stats',
  },
  'history.avgScore': { th: 'คะแนนเฉลี่ย', en: 'Avg score' },
  'history.summaryTitle': { th: 'สรุปท้ายเซสชัน', en: 'Session summary' },
  'history.topFaults': { th: 'จุดที่ควรแก้บ่อยที่สุด', en: 'Most frequent faults' },
  'history.trendUp': { th: 'ฟอร์มดีขึ้นระหว่างเซสชัน', en: 'Form improved during the session' },
  'history.trendDown': { th: 'ฟอร์มตกช่วงท้าย', en: 'Form declined late in the session' },
  'history.trendFlat': { th: 'ฟอร์มคงที่ทั้งเซสชัน', en: 'Form held steady' },
  'history.perShotScores': { th: 'คะแนนรายลูก', en: 'Per-shot scores' },
  'history.noClip': { th: 'ไม่มีคลิปสำหรับลูกนี้', en: 'No clip for this shot' },
  'history.delete': { th: 'ลบเซสชัน', en: 'Delete session' },
  'history.deleteConfirm': {
    th: 'ลบเซสชันนี้และคลิปทั้งหมด?',
    en: 'Delete this session and all its clips?',
  },
  'history.deleteFailed': { th: 'ลบไม่สำเร็จ ลองใหม่อีกครั้ง', en: 'Delete failed — try again' },
  'history.loadFailed': { th: 'โหลดข้อมูลไม่สำเร็จ', en: 'Failed to load' },
  'history.retry': { th: 'ลองใหม่', en: 'Retry' },
  'history.radarTitle': { th: 'มุมข้อต่อเทียบเป้าหมาย', en: 'Joints vs target' },
  // --- history: export one swing as a 9:16 share video. {name} = player. ---
  'history.byPlayer': { th: 'ประวัติของ {name}', en: "{name}'s history" },
  'history.export.save': { th: 'บันทึกวิดีโอ', en: 'Save video' },
  'history.export.share': { th: 'แชร์', en: 'Share' },
  'history.export.rendering': { th: 'กำลังสร้างวิดีโอ…', en: 'Rendering…' },
  'history.export.ready': {
    th: 'พร้อมแล้ว — แตะอีกครั้งเพื่อบันทึกหรือแชร์',
    en: 'Ready — tap again to save or share',
  },
  'history.export.failed': { th: 'สร้างวิดีโอไม่สำเร็จ ลองใหม่อีกครั้ง', en: 'Export failed — try again' },

  // --- compare screen (user clip vs reference video) ---
  'compare.title': { th: 'เปรียบเทียบวงสวิง', en: 'Swing Compare' },
  'compare.yourSwing': { th: 'วงสวิงของคุณ', en: 'Your swing' },
  'compare.reference': { th: 'ท่าต้นแบบ', en: 'Reference' },
  'compare.urlPlaceholder': {
    th: 'วางลิงก์ YouTube หรือลิงก์วิดีโอ…',
    en: 'Paste a YouTube or video URL…',
  },
  'compare.apply': { th: 'ใช้ลิงก์นี้', en: 'Use link' },
  'compare.badUrl': {
    th: 'ลิงก์ไม่ถูกต้อง — ใช้ลิงก์ YouTube หรือไฟล์วิดีโอ',
    en: 'Invalid link — use a YouTube or direct video URL',
  },
  'compare.noClips': {
    th: 'ยังไม่มีคลิป — เริ่มฝึกซ้อมเพื่อบันทึกวงสวิง',
    en: 'No clips yet — start a session to record swings',
  },
  'compare.cloudOffline': {
    th: 'คลิปย้อนหลังใช้ไม่ได้ (ออฟไลน์) — ใช้คลิปจากรอบนี้ได้',
    en: "Cloud clips unavailable (offline) — this session's clips still work",
  },
  'compare.pickClip': { th: 'เลือกคลิป', en: 'Pick a clip' },
  'compare.shotType': { th: 'ประเภทลูก', en: 'Shot type' },

  // --- token modality labels ---
  'token.textIn': { th: 'ข้อความเข้า', en: 'Text In' },
  'token.audioIn': { th: 'เสียงเข้า', en: 'Audio In' },
  'token.videoIn': { th: 'วิดีโอเข้า', en: 'Video In' },
  'token.textOut': { th: 'ข้อความออก', en: 'Text Out' },
  'token.audioOut': { th: 'เสียงออก', en: 'Audio Out' },
  'token.thoughts': { th: 'การคิด', en: 'Thoughts' },

  // --- settings ---
  'settings.title': { th: 'ตั้งค่า', en: 'Settings' },
  'settings.account': { th: 'บัญชีผู้ใช้', en: 'Account' },
  'settings.logout': { th: 'ออกจากระบบ', en: 'Log out' },
  'settings.pricing': { th: 'ราคา (USD ต่อ 1M โทเคน)', en: 'Pricing (USD per 1M tokens)' },
  'settings.textIn': { th: 'ข้อความเข้า', en: 'Text In' },
  'settings.audioIn': { th: 'เสียงเข้า', en: 'Audio In' },
  'settings.videoIn': { th: 'วิดีโอเข้า', en: 'Video In' },
  'settings.textOut': { th: 'ข้อความออก', en: 'Text Out' },
  'settings.audioOut': { th: 'เสียงออก', en: 'Audio Out' },
  'settings.usdToThb': { th: 'อัตราแลกเปลี่ยน USD→THB', en: 'USD→THB Rate' },
  'settings.sendFrame': { th: 'ส่งภาพจังหวะสัมผัสลูก', en: 'Send contact frame' },
  'settings.coachVoice': { th: 'เปิดเสียงโค้ช', en: 'Coach voice' },
  'settings.playerHeight': { th: 'ส่วนสูง (ซม.)', en: 'Height (cm)' },
  'speed.label': { th: 'สปีด', en: 'speed' },
  'settings.dominantHand': { th: 'มือถนัด', en: 'Dominant hand' },
  'settings.handLeft': { th: 'ซ้าย', en: 'Left' },
  'settings.handRight': { th: 'ขวา', en: 'Right' },
  'settings.camera': { th: 'กล้อง', en: 'Camera' },
  'settings.cameraUser': { th: 'กล้องหน้า', en: 'Front' },
  'settings.cameraEnv': { th: 'กล้องหลัง', en: 'Rear' },
  'settings.session': { th: 'การฝึกซ้อม', en: 'Session' },
  // (settings.token* keys removed 2026-07-20 — the manual token field is gone;
  // the coach key is auto-provisioned server-side.)

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

  // --- dev plan v0.8: miss clips + clear guidance + story share ---
  'devplan.missTitle': { th: 'จุดที่พลาด', en: 'Missed Moments' },
  'devplan.missSubtitle': {
    th: 'ช็อตที่คะแนนต่ำสุดในเซสชันนี้ กดดูวิดีโอแล้วดูวิธีแก้ด้านล่าง',
    en: 'Your lowest-scoring shots this session — watch them, then see how to fix them below.',
  },
  'devplan.missPhase': { th: 'พลาดช่วง', en: 'Missed during' },
  'devplan.missScore': { th: 'คะแนน', en: 'Score' },
  'devplan.noClips': {
    th: 'เซสชันนี้ยังไม่มีวิดีโอสวิง (วิดีโอจะบันทึกอัตโนมัติเมื่อกล้องจับสวิงได้ครบจังหวะ) — ดูแนวทางพัฒนาด้านล่างได้เลย',
    en: 'No swing videos this session yet (clips record automatically once a full swing is detected) — see your guidance below.',
  },
  'devplan.noMiss': {
    th: 'ไม่มีจุดพลาดชัด ๆ วันนี้ ฟอร์มนิ่งมาก 👍',
    en: "No clear misses today — your form is rock solid 👍",
  },

  // structured guidance block labels
  'devplan.guideTitle': { th: 'แนวทางพัฒนา', en: 'How to Improve' },
  'devplan.symptom': { th: 'อาการ', en: "What's happening" },
  'devplan.why': { th: 'เพราะอะไร', en: 'Why it matters' },
  'devplan.drill': { th: 'วิธีซ้อม', en: 'How to practice' },
  'devplan.cue': { th: 'cue สั้น', en: 'Quick cue' },

  // share
  'devplan.share': { th: 'แชร์', en: 'Share' },
  'devplan.shareStory': { th: 'แชร์เป็นสตอรี่', en: 'Share as story' },
  'devplan.shareSummary': { th: 'แชร์สรุปวันนี้', en: "Share today's highlight" },
  'devplan.sharing': { th: 'กำลังสร้างสตอรี่…', en: 'Creating story…' },
  'devplan.savedToast': {
    th: 'บันทึกไฟล์ลงเครื่องแล้ว เปิดแอป IG / Facebook / TikTok แล้วเลือกไฟล์นี้เพื่อลงสตอรี่ได้เลย',
    en: 'Saved to your device — open IG / Facebook / TikTok and pick this file to post your story.',
  },
  'devplan.shareError': {
    th: 'สร้างสตอรี่ไม่สำเร็จ ลองใหม่อีกครั้ง',
    en: "Couldn't create the story — please try again.",
  },

  // story headlines (rendered onto the 9:16 image; both langs always provided)
  'devplan.storyMissTitle': { th: 'จุดที่ตั้งใจพัฒนา', en: 'Working on this' },
  'devplan.storyBestTitle': { th: 'ฟอร์มวันนี้', en: "Today's form" },
  'devplan.bestFix': {
    th: 'รักษาฟอร์มนี้ไว้ ตีให้สม่ำเสมอทุกลูก',
    en: 'Keep this form — repeat it every ball.',
  },
  'devplan.bestCue': { th: 'จบสวิงให้สุด', en: 'Finish the swing fully' },

  // per-area guidance (TH coach speech first) — ids match areaForIssue()
  'devplan.area.contact-extension.title': {
    th: 'จุดกระทบและการเหยียดแขน',
    en: 'Contact point & arm extension',
  },
  'devplan.area.contact-extension.symptom': {
    th: 'ศอกยังงอตอนโดนลูก แขนไม่เหยียดออกไปข้างหน้า',
    en: "Your elbow stays bent at contact — the arm doesn't extend out front.",
  },
  'devplan.area.contact-extension.why': {
    th: 'แขนงอทำให้จุดกระทบชิดตัวเกินไป เสียทั้งพลังและการคุมทิศทาง',
    en: 'A bent arm brings contact too close to your body, costing power and control.',
  },
  'devplan.area.contact-extension.drill': {
    th: 'เงาสวิง 10 ครั้ง เน้นเหยียดศอกให้ถึง ~140° และโดนลูกด้านหน้าลำตัว',
    en: '10 shadow swings extending the elbow to ~140°, meeting the ball out in front.',
  },
  'devplan.area.contact-extension.cue': { th: 'เหยียดแขนหาลูก', en: 'Reach out to the ball' },

  'devplan.area.knee-load.title': {
    th: 'การย่อเข่าและการโหลดพลัง',
    en: 'Knee bend & loading',
  },
  'devplan.area.knee-load.symptom': {
    th: 'ยืนขาตรง ไม่ได้ย่อเข่าก่อนตี',
    en: 'You hit with straight legs, without loading the knees.',
  },
  'devplan.area.knee-load.why': {
    th: 'ไม่ย่อเข่า = ไม่มีสปริงส่งพลังจากพื้นขึ้นมา ลูกเลยเบาและตื้น',
    en: 'No knee bend means no spring from the ground — the ball comes out light and shallow.',
  },
  'devplan.area.knee-load.drill': {
    th: 'สปลิตสเต็ปแล้วย่อเข่าค้าง 2 วินาทีก่อนตี 15 ลูก ให้เข่าอยู่ ~130–150°',
    en: 'Split-step then hold a 2-second knee bend before each of 15 balls, knees ~130–150°.',
  },
  'devplan.area.knee-load.cue': { th: 'ย่อเข่าก่อนตี', en: 'Load the knees first' },

  'devplan.area.balance.title': { th: 'การทรงตัวและลำตัว', en: 'Balance & trunk' },
  'devplan.area.balance.symptom': {
    th: 'ลำตัวเอียงตอนสวิง เสียการทรงตัวตอนจบ',
    en: 'Your trunk tilts during the swing and you lose balance at the finish.',
  },
  'devplan.area.balance.why': {
    th: 'ตัวเอียงทำให้จุดกระทบไม่นิ่ง คุมทิศทางและความลึกของลูกได้ยาก',
    en: 'Leaning makes contact unstable, so direction and depth get hard to control.',
  },
  'devplan.area.balance.drill': {
    th: 'ตีโดยตั้งลำตัวตรง ค้างท่า follow-through 2 วินาทีทุกลูก เช็กว่าไม่เสียหลัก',
    en: 'Hit with an upright trunk and hold the follow-through 2 seconds each ball, checking you stay balanced.',
  },
  'devplan.area.balance.cue': { th: 'ตั้งตัวตรง จบให้นิ่ง', en: 'Stay tall, finish still' },

  'devplan.area.racket-prep.title': {
    th: 'การเตรียมไม้และหัวไหล่',
    en: 'Racket prep & shoulder',
  },
  'devplan.area.racket-prep.symptom': {
    th: 'เตรียมไม้ช้า มุมหัวไหล่ตอนกระทบยังไม่เข้าที่',
    en: "You prepare the racket late, so the shoulder isn't set at contact.",
  },
  'devplan.area.racket-prep.why': {
    th: 'เตรียมช้าทำให้ตีไม่ทันจังหวะ แรงและความแม่นลดลง',
    en: "Late prep means you're rushed at contact, dropping both power and accuracy.",
  },
  'devplan.area.racket-prep.drill': {
    th: 'เน้น unit turn หมุนตัวเตรียมไม้ทันทีที่เห็นลูก ตั้งหัวไหล่ ~80–100° ตอนกระทบ 15 ลูก',
    en: 'Emphasize an early unit turn — set the racket the moment you see the ball, shoulder ~80–100° at contact, 15 balls.',
  },
  'devplan.area.racket-prep.cue': { th: 'หมุนตัวเตรียมไม้เร็ว', en: 'Turn and prepare early' },

  'devplan.area.swing-speed.title': {
    th: 'ความเร็วและการเร่งสวิง',
    en: 'Swing speed & acceleration',
  },
  'devplan.area.swing-speed.symptom': {
    th: 'สวิงช้า ไม่เร่งความเร็วช่วงเข้าหาลูก',
    en: "Your swing is slow — you don't accelerate into the ball.",
  },
  'devplan.area.swing-speed.why': {
    th: 'หัวไม้ช้าตอนกระทบ = ลูกไม่มีสปินและความลึก คู่แข่งตีสวนง่าย',
    en: 'A slow racket head at contact means no spin or depth — easy for opponents to attack.',
  },
  'devplan.area.swing-speed.drill': {
    th: 'ดริลล์ low-to-high เร่งหัวไม้ช่วงเข้าหาลูก ตี 15 ลูกให้ได้ยินเสียงวืดดังขึ้น',
    en: 'Low-to-high drill: accelerate the racket head through the ball — 15 balls chasing a louder "whoosh".',
  },
  'devplan.area.swing-speed.cue': { th: 'เร่งหัวไม้ตอนโดนลูก', en: 'Accelerate through contact' },
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

# HANDOFF.md — สถานะงาน + สิ่งที่ต้องทำต่อ

> อัปเดตล่าสุด: 2026-07-07 (release v0.9) · สำหรับ Claude session ถัดไป (หรือคนที่มารับช่วง) อ่านคู่กับ `CLAUDE.md`

## TL;DR

แอป deploy อยู่ที่ https://ton-phet-tennis-862607193158.asia-southeast1.run.app (**revision `00012`**, image `…/ton-phet/app:v9`, git tag **v0.9**). ล่าสุด: **แก้บั๊กแยกโฟร์แฮนด์/แบ็คแฮนด์ (ยึดมือที่ user เลือก) + คูลดาวน์ 2.5 วิ/ครบวงเท่านั้นถึงส่งโค้ช + โค้ชพูด 8 สไตล์ไม่ซ้ำ** (Fable verdict: ship, 173/173 tests). เหลือ blocker เดียวเหมือนเดิม: **ยังไม่มี `GEMINI_API_KEY` (AIza…)** — เสียง/โค้ชสดยังใช้ได้เฉพาะผ่าน AQ. token ชั่วคราวที่ paste ใน Settings

## v0.9 (2026-07-07) — มือถนัด + จังหวะแคป + โค้ชหลายสไตล์ (ล่าสุด, revision `00012`, tag v0.9)

- **แก้บั๊กแยกท่า:** ตัวเก่าอ่าน `sign(ไหล่ข้างถนัด − กึ่งกลางสะโพก)` → ตอนบิดลำตัว contact ไหล่ข้ามกลางลำ เครื่องหมายพลิก = ทายผิด · ตัวใหม่ยึด**เส้นฐานไหล่คู่** เทียบตำแหน่งข้อมือข้างถนัด — **mirror-invariant โดยโครงสร้าง** · ก้ำกึ่ง/ยืน side-on/มองไม่ชัด → `unknown` ไม่เดามั่ว · Home มีการ์ดเลือก "ถนัดขวา/ซ้าย" เด่น ๆ ก่อนเริ่ม + บรรทัดยืนยันใต้ปุ่ม Start
- **จังหวะแคป:** `cooldownMs` 800→2500 (บล็อกเฉพาะ re-arm จาก idle — ไม่แตะ speed gates v0.3 ที่จูนมาแพง) + HUD ขึ้น "พักระหว่างช็อต (คูลดาวน์)" · `followThroughReached`: ต้องครบวงจริง (contact + follow-through + ระยะเวลา valid) ถึงจะไปถึง Gemini/cloud — วงค้างกลางทางโดนทิ้งพร้อมเหตุผล ไม่ส่งหลังบ้าน
- **โค้ช 8 เสียง:** `selectCoachingStyle(score,index)` 4 band × 2 โทน — ≥85 เชียร์+อวยล้วนไม่จี้จุดแก้ · 70-84 ชมแล้วขัดเงา · 55-69 สายเทคนิค · <55 ปลอบก่อนค่อยแนะ ง่ายสุดอันเดียว จบ upbeat · ห้ามซ้ำ variant ติดกัน + system prompt สั่ง "ห้ามใช้ pattern ประโยคเดิมของ reply ก่อนหน้า" หมุน opener (โอ้โห/เยี่ยม/สู้ ๆ/มาแล้ว/สวยมาก…)
- **เทสสนาม:** (1) เครื่องยิงลูกถี่กว่า ~3 วิ/ลูกไหม — ถ้าโดนคูลดาวน์กินวงจริง บอกเลข feed rate มา เดี๋ยวจูน `cooldownMs` ลง (2) ป้ายโฟร์/แบ็คตรงจริงไหมทั้งมุมกล้องหน้า-หลัง (3) ฟัง 10+ ช็อต โค้ชเสียงหลากจริงไหม

## v0.8 (2026-07-07) — แผนพัฒนา + แชร์ Story (ล่าสุด, revision `00011`, tag v0.8)

- **จุดที่พลาด:** 3 วงคะแนนต่ำสุดที่มีคลิป (แย่สุดขึ้นก่อน) เล่นคลิปในการ์ด แตะเปิด lightbox + ป้ายคะแนน + ข้อผิดหลักภาษาคน + พลาดเฟสไหน · คลิป decode ไม่ได้ → ภาพนิ่ง skeleton แทน
- **แนวทางพัฒนา:** จัดกลุ่ม issue เป็น 5 พื้นที่โค้ช (contact-extension / knee-load / balance / racket-prep / swing-speed) การ์ดละ อาการ → เพราะอะไร → วิธีซ้อม (drill จริง มีจำนวนครั้ง) → cue สั้น · copy ไทยธรรมชาติใน i18n
- **แชร์ Story:** `src/share/storyRenderer.ts` การ์ด 1080×1920 (หัวแบรนด์ 🎾, เฟรม skeleton, คะแนนสีใหญ่, "จุดที่ต้องแก้"/"ท่องไว้ตอนตี", footer วันที่) — วิดีโอ ≤8 วิ (canvas.captureStream + MediaRecorder, chain เดียวกับ swingRecorder) หรือ PNG · `shareStory`: navigator.share files (เด้ง share sheet IG/FB/TikTok) → โหลดไฟล์ fallback · มี **watchdog 10 วิ** กัน share() ค้าง (พบจริงใน headless)
- **แก้หลัง review (major):** การ์ด EN ข้อความ fix 3 บรรทัดเคยดัน cue หลุด clamp หายเงียบ → cue ปัก y ตายตัวเหนือ footer (label 1716/body 1772) + fix โดนตัดด้วย "…" เมื่อยาวเกิน
- **Trade-off ที่รู้ (minor):** แชร์แบบวิดีโอ เรนเดอร์เกิน ~5 วิ อาจเสีย user activation → browser ปฏิเสธ share sheet แล้วกลายเป็นดาวน์โหลด+toast แทน (ภาพเปิด sheet ได้ปกติ) — **เทสบนมือถือจริง**; ถ้าน่ารำคาญค่อยเปลี่ยนเป็น 2 จังหวะ (เรนเดอร์เสร็จ → กดแชร์อีกที)
- **เทสสนาม:** แชร์ story ทั้งแบบภาพและวิดีโอจากมือถือจริง ดูว่า share sheet เปิด + วิดีโอเล่นใน IG story ได้

## v0.7 (2026-07-07) — โค้ชขานช็อต + จังหวะไม่รัว (ล่าสุด, revision `00010`, tag v0.7)

- **ขานชื่อช็อต:** ทุกคำวิจารณ์เปิดด้วย "ช็อตที่ {N} โฟร์แฮนด์/แบ็คแฮนด์" (ไม่รู้ท่า → เลขอย่างเดียว) — บังคับทั้งใน system prompt (step 1, ห้ามข้าม) และแนบ opener string ต่อ turn (`shotOpener()` ใน liveClient + i18n 3 keys)
- **Pacing gate:** ช็อตใหม่จะถูกส่งให้โค้ชก็ต่อเมื่อ (ก) ไม่มี turn ค้าง (ข) `audioPlayer.isSpeaking()` = false — ผูกกับ**เสียงเล่นจบจริง** ไม่ใช่แค่ข้อความจบ · `onPlaybackDone` (ยิงเฉพาะเสียง drain ธรรมชาติ ไม่ยิงตอน stop/barge-in) → `flushQueue()` · คิว 1 ช่อง freshest-wins (สวิงใหม่แทนที่อันเก่า — คะแนน/คลิปยังเก็บครบทุกวง แค่เสียงวิจารณ์ได้เฉพาะวงล่าสุด)
- **Hardening หลัง review:** `lastDispatchedIndex` stale-guard (requeue จาก error path ไม่มีทางเล่นย้อนลำดับ; index เท่ากัน = retry ที่ถูกต้อง ปล่อยผ่าน) + **wedge watchdog** ใน audioPlayer (กำหนดเวลาจบ+5วิ — iOS พับแอป/สายเข้าแล้ว AudioContext ค้าง จะปลดล็อก gate เองแทนที่จะแช่ทั้งระบบโค้ช)
- **เทสสนาม:** ตีรัว 3-4 ลูกติดระหว่างโค้ชพูด → เสียงต้องไม่ซ้อน, วงที่วิจารณ์ถัดไปคือวงล่าสุด · พับแอปกลางประโยคแล้วกลับมา → โค้ชต้องกลับมาทำงานต่อ ไม่เงียบค้าง

## v0.6 (2026-07-07) — ตัดไมค์ + โค้ชอ่านทั้งวงสวิง (ล่าสุด, revision `00009`, tag v0.6)

- **ตัด voice input หมด** (คำสั่ง user): ไม่ start mic, ไม่ส่ง audio เข้า Gemini, ไม่ขอ mic permission เลย (Playwright ยืนยัน permission ยังเป็น "prompt" หลังใช้งานเต็ม session) · **เสียงโค้ชพูดออกยังอยู่ครบ** · `mic.ts`/`MicControl.tsx` เก็บไฟล์ไว้ (dead, ไม่มี import) เผื่อ release หน้าเอาเสียงถามตอบกลับมา · `setMicEnabled` เป็น no-op, `micOn` default false
- **โค้ชอ่านทั้งวง**: `dispatchShot` ส่งคีย์เฟรมทุกเฟสเรียงตามลำดับวงสวิง (ง้าง→สวิง→กระทบ→ส่ง ผ่าน `orderedCaptures()`) + text ที่ "Frame N = เฟส" ตรงกับภาพหนึ่งต่อหนึ่ง (มุมรายเฟส + จุดที่หลุดเป้า) · prompt ใหม่บังคับโครงโค้ช: ชมเจาะจงสั้น → จุดแก้หลัก 1 ระบุเฟส → cue จำง่ายไว้ลูกถัดไป, ภาษาพูดไทย, องศาเป็นหมายเหตุท้าย · critique ยัง pin กับภาพ contact เหมือนเดิม (+13 tests ใหม่)
- **ดูในสนาม:** ค่า THB ต่อช็อต (ตอนนี้ส่งหลายภาพ/วง) + ความเร็วตอบของโค้ช · เช็คว่าเบราว์เซอร์ขอแค่กล้อง ไม่ขอไมค์

## v0.5 (2026-07-05) — Cloud + Compare + History (ล่าสุด, revision `00008`, tag v0.5)

- **สถาปัตยกรรม:** คลิป → GCS bucket `ton-phet-clips` (**ลบอัตโนมัติ 3 วันที่ระดับ bucket** — server ห้ามลบ object เอง) · metadata → **Supabase Postgres** ผ่าน `DATABASE_URL` · client อัปโหลดแบบ fire-and-forget ไม่บล็อก pose loop · env หาย → 503 สองภาษา + fallback localStorage (แอปไม่พังไม่ว่ากรณีไหน)
- **⚠️ Supabase gotcha (จ่ายบทเรียนแล้ว):** host ตรง `db.*.supabase.co` เป็น IPv6-only (ENOTFOUND) — ต้องใช้ pooler IPv4 `aws-0-ap-northeast-1.pooler.supabase.com:5432` user `postgres.<ref>` + password URL-encode (`@`→`%40`). ค่าจริงอยู่ใน `.env.local` (gitignored)
- **Deploy env:** SA ใช้ Secret Manager ไม่ได้ → ส่งเป็น env vars: `gcloud run deploy … --update-env-vars "^|^GCS_BUCKET=ton-phet-clips|DATABASE_URL=<จาก .env.local>"` (delimiter `^|^` กันอักขระพิเศษ)
- **ไฟล์ใหม่:** `server/db.mjs` (pg Pool + auto-migrate + purge 3 วัน) · `server/gcs.mjs` (proxy-stream พร้อม **Range/206** เพื่อ iOS Safari + offline latch 60 วิ) · `server/routes.mjs` · `server/lib.mjs` (+tests) · `src/data/api.ts`+`cloudSync.ts` · `src/screens/CompareScreen.tsx` (เทียบคลิปเรากับ YouTube/URL ต้นแบบ — default refs ตรวจ oEmbed แล้วว่า embed ได้จริง) · `src/screens/HistoryScreen.tsx` + `src/history/derive.ts` + SVG `RadarChart`/`BarChart` (วาดเอง ไม่มี lib)
- **Fable findings ที่แก้แล้ว:** default YouTube ตาย 2 ตัว → แทนด้วยของจริง (verified) · GCS latch ถาวร → time-box 60 วิ · streamClip ไม่รองรับ Range → 206/Content-Range (เทสจริงแล้วทั้ง local+prod) · Compare preselect เอาคลิปเก่าสุด → ใหม่สุด · doc comment เรื่องลบคลิป
- **Minor ที่รับสภาพ:** `ssl.rejectUnauthorized:false` ใน db.mjs (convenience ของ pooler) · ลบ session ทิ้ง orphan clip ใน GCS ได้สูงสุด 3 วัน (lifecycle เก็บกวาดเอง — by design)
- **humanTestNeeded:** เล่นคลิป cloud บน iPhone Safari จริงผ่าน LTE ที่สนาม · ดู 3-day purge ทำงานจริงหลัง 3 วัน
- **ค้าง:** rotate รหัส Supabase + sb_ keys ที่เคยแชร์ในแชท · rotate AQ. tokens เก่า · `GEMINI_API_KEY` ถาวร

## v0.4 (2026-07-05) — วิดีโอคลิปวงสวิง (ล่าสุด, revision `00007`, tag v0.4)

- feedback สนาม: ภาพนิ่ง "ไม่เนียน ดูยาก" → เปลี่ยนเป็น**คลิปวิดีโอทั้งวงสวิง** โครงกระดูกสีฝังในคลิป (composite canvas ~480px + MediaRecorder ต่อวง; mp4 บน iOS / webm บน Android; ไม่รองรับ → fallback ภาพนิ่งเดิม)
- เริ่มอัดตอนเข้า preparation, เก็บเมื่อ shot สำเร็จ, ทิ้งเมื่อ discard, cap 6s; จำกัด 20 คลิป/เซสชัน + revoke URL ตอนจบเซสชัน; localStorage/Gemini ไม่แตะ (คลิปเป็น session-only)
- ไฟล์หลักใหม่: `src/analysis/swingRecorder.ts` (+tests) · hooks ใหม่ใน shotDetector: `onSwingStarted`/`onSwingFinalized`
- 47/47 tests · Fable verdict: ship · minor findings คงเหลือ: recorder ยัง composite ต่อหลัง 6s cap จน finalize (เสีย draw เปล่า), durationMs เกินจริงเล็กน้อย
- v0.3.1: ปรับ wording โค้ชให้พูดเหมือนคน (คำง่ายนำ ตัวเลของศาเป็นหมายเหตุ) · v0.3.2: **half-duplex** — ตัด mic chunk ระหว่างโค้ชพูด → โค้ชพูดจบเสมอ (ลบ RMS duck แล้ว) + แกลเลอรีกลับ strip ล่าง (rail ขวาเล็กเกิน อ่านไม่ออก — โค้ดยังอยู่แต่ไม่ใช้)

## v0.3 (2026-07-04) — สิ่งที่แก้

- **Shot detection จูนสำหรับสวิงจริง**: backswing 0.8→0.5, forward 1.2→0.7, contact peak 2.0→1.1, rising frames 2→1 + `forwardBypass` (speed>1.0 ×2 เฟรม) สำหรับวงสวิงแนวดิ่ง/แกนกล้องที่ velX ไม่พลิกเครื่องหมาย. Idle/เดิน/เก็บลูกไม่ false-trigger (มีเทสยืนยัน)
- **การันตี capture**: retry getJpeg ทุกเฟรมช่วง contact/follow-through + finalize fallback; getJpeg ล้มเรื่องวิดีโอ → วาด skeleton บนพื้นเข้มแทนการคืน undefined
- **Detection HUD** (`src/components/DetectionHud.tsx`): phase trail (เตรียม/ง้าง/สวิง/กระทบ/ส่ง), มาตรวัดสปีดข้อมือเทียบ gate 1.1, ตัวนับช็อต/ทิ้ง, เหตุผลที่ทิ้งสวิง (พร้อมค่า peak ที่วัดได้จริง — **ใช้ค่านี้จูน threshold ในสนาม**), แฟลชภาพเมื่อ capture ลง
- CaptureGallery มี empty-state (ไม่หายเงียบ)
- minor ที่แก้แล้ว: `detector.reset()` เรียก `resetDetection()` (HUD ไม่ค้างค่าเก่า)
- minor ที่ยังไม่แก้ (จาก review): HUD อ่าน gate จาก `SHOT_THRESHOLDS` static — จะ desync ถ้าวันหน้าใช้ per-instance overrides; shot 0-capture (แทบเป็นไปไม่ได้) เห็นได้จากการไม่มีแฟลชเท่านั้น

## วิธีจูนในสนาม (สำคัญ!)

ดู HUD ตอนตีจริง: ถ้าสวิงแล้ว**ตัวนับไม่ขึ้นแต่มีบรรทัด "ทิ้ง — พีค X.X"** แปลว่า peak จริงต่ำกว่า gate 1.1 → ลด `contactMinPeakSpeed` ใน `src/analysis/shotDetector.ts` ให้ต่ำกว่าค่า X.X ที่เห็น แล้ว build+deploy ใหม่

## ผลเทสสนามจริง → การวินิจฉัย

| # | อาการที่ user รายงาน | สาเหตุ | สถานะ |
|---|---|---|---|
| 1 | ไม่เห็นจับภาพวงสวิงเลย | บั๊กจริงในเครื่อง (ไม่เกี่ยวคีย์): shot detection thresholds จูนกับข้อมูลสังเคราะห์ → การตีจริงบนมือถือไม่ทริกเกอร์ "จบวงสวิง" → ไม่มี shot = ไม่มี capture | 🔄 workflow `tonped-capture-fix` กำลังแก้ |
| 2 | ไม่ได้ยินเสียงโค้ช ทั้งที่พูดแล้ว | Gemini Live ต่อไม่ได้ — server ไม่มี `GEMINI_API_KEY` → `/api/token` ตอบ 503 (ตรวจยืนยันแล้ว) | ⛔ บล็อกที่คีย์ — แก้โค้ดไม่ได้ |
| 3 | ไม่โค้ช realtime ตอนขยับมือผิด | เหมือนข้อ 2 + เป็นคำถาม design (ดีไซน์ปัจจุบัน = โค้ชหลังตีจบวง ไม่ใช่เตือนสดระหว่างขยับ) | ⛔ คีย์ + รอ user เลือกรูปแบบ |

**ข้อเท็จจริงที่ตรวจแล้ว:** pose loop / ShotDetector / capture ทำงานแยกจาก Gemini connection โดยสิ้นเชิง (`coachLive.connect()` เป็น fire-and-forget ที่ `src/screens/LiveScreen.tsx:123`) — ฉะนั้นข้อ 1 ไม่ใช่เพราะไม่มีคีย์

## ✅ Workflow `tonped-capture-fix` เสร็จแล้ว (verdict: ship)

Run `wf_f7da6a33-0ea` — journal อยู่ที่ `.../subagents/workflows/wf_f7da6a33-0ea/journal.jsonl` (มี diagnosis เต็ม + humanTestNeeded checklist). Deploy รอบใหม่ทำครบแล้ว (revision `00004`, tag v0.3)

**ขั้นตอน deploy มาตรฐาน (ใช้ซ้ำทุกรอบ):**
1. `npm run typecheck && npm run test && npm run build` ต้องเขียวหมด
2. Rebuild + push image: `docker buildx build --platform linux/amd64 -t asia-southeast1-docker.pkg.dev/ton-team/ton-phet/app:vN --push .` (colima ต้องรันอยู่: `colima start`)
3. Deploy: `gcloud run deploy ton-phet-tennis --image asia-southeast1-docker.pkg.dev/ton-team/ton-phet/app:vN --region asia-southeast1 --allow-unauthenticated --project ton-team`
4. Smoke: `curl -s -o /dev/null -w "%{http_code}" <URL>/` ต้อง 200
5. **Audit secret ก่อน commit ทุกครั้ง**: `git diff --cached | grep -nE 'AQ\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}'` ต้อง CLEAN
6. Commit + push (+tag ถ้าเป็น release) → https://github.com/Piyaphan-P/tennis-tonped

## ⛔ Blocker ที่รอ user (ถามไปแล้ว ยังไม่ตอบ)

1. **Gemini API key** — ต้องมี `AIza…` ตั้งเป็น secret จึงจะมีเสียงโค้ช:
   ```bash
   echo -n "AIza..." | gcloud secrets create gemini-api-key --data-file=- --project ton-team
   gcloud run services update ton-phet-tennis --region asia-southeast1 --project ton-team \
     --update-secrets GEMINI_API_KEY=gemini-api-key:latest
   ```
   (ถ้า secret มีอยู่แล้ว: `gcloud secrets versions add gemini-api-key --data-file=-`)
   ทางเลือกชั่วคราว: paste `AQ.` ephemeral token ในหน้า Settings ของแอป (หมดอายุ ~30 นาที)
2. **รูปแบบโค้ช** — (ก) หลังตีจบวง (ปัจจุบัน, แม่น+ประหยัด) (ข) เตือนสดตอนฟอร์มผิดระหว่างขยับ ใช้มุมจาก pose ในเครื่อง (ไม่ต้องรอ Gemini) (ค) ทั้งคู่ — ข้อ (ข) ทำได้โดยไม่ใช้คีย์ด้วยซ้ำ (local rule-based alert) ถ้า user เลือก

## สถานะ code / งานที่เสร็จแล้ว (v3, commit `4551689`)

- ✅ ไมค์ always-on (ลบ push-to-talk), MicControl toggle + level meter, barge-in, iOS suspended-context fail-loud
- ✅ Swing capture: synthesize contact capture ใน `finalize()` ถ้า grab สดพลาด + CaptureLightbox + skeleton overlay ใน Summary
- ✅ แก้ major turn-attribution (turnInterrupted flag ใน liveClient)
- ✅ CLAUDE.md ประจำ repo, 36/36 tests, deploy revision 00003, push git แล้ว
- ⚠️ แต่เทสสนามจริงพิสูจน์ว่า capture ยังไม่ทำงานกับวงสวิงจริง → จึงเกิด workflow ปัจจุบัน

## Fable review findings ที่ยังไม่ได้แก้ (minor, จาก v3)

- `src/analysis/shotDetector.ts` — fallback contact capture ใช้เฟรมภาพ ณ เวลา finalize (~0.5-1s หลัง contact จริง) ทับด้วย skeleton ของ contact → ภาพ/เส้นอาจไม่ตรงกัน ควรติด badge ใน UI ถ้าดูขัดตา
- เช็คลิสต์ humanTestNeeded เต็ม ๆ อยู่ใน journal ของ `wf_aeb623d0-f0b`

## ความจริงที่ห้ามลืม (จ่ายบทเรียนมาแล้ว)

- Model ที่ใช้ได้: `gemini-2.5-flash-native-audio-preview-09-2025` + `apiVersion:'v1beta'` (backend minter ใช้ `v1alpha`)
- ห้าม send ใน `onopen` — assign session จาก awaited promise เท่านั้น
- Docker build บนเครื่องเท่านั้น (SA ใช้ Cloud Build ไม่ได้), background build เคยล้มเงียบ → build foreground
- เคยมี token หลุดใน demo files มาแล้ว → audit ทุกครั้งก่อน push
- Brand = "ต้นและเพชร Tennis Club" ห้ามเขียน "ต้นเป็ด"/"TonPed"
- Rotate AQ. token เก่าที่เคยแชร์ (`AQ.Ab8RN6L-...`) — ยังไม่ได้ทำ

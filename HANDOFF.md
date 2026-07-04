# HANDOFF.md — สถานะงาน + สิ่งที่ต้องทำต่อ

> อัปเดตล่าสุด: 2026-07-04 (release v0.3) · สำหรับ Claude session ถัดไป (หรือคนที่มารับช่วง) อ่านคู่กับ `CLAUDE.md`

## TL;DR

แอป deploy อยู่ที่ https://ton-phet-tennis-862607193158.asia-southeast1.run.app (**revision `00004`**, image `…/ton-phet/app:v3`, git tag **v0.3**). บั๊ก "จับภาพวงสวิงไม่ขึ้น" **แก้แล้ว** (Fable verdict: ship, 39/39 tests) — ต้นตอคือ threshold จับ contact ตั้งไว้ ~2 เท่าของความเร็วสวิงจริงบนกล้องมือถือ 15fps. เพิ่ม Detection HUD บนจอ Live ไว้จูนในสนาม. เหลือ blocker เดียว: **ยังไม่มี `GEMINI_API_KEY` (AIza…)** — เสียง/โค้ชสดยังใช้ได้เฉพาะผ่าน AQ. token ชั่วคราวที่ paste ใน Settings (user ยืนยัน token ล่าสุดใช้ได้จริง เทสผ่าน Live API แล้ว)

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

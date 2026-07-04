# HANDOFF.md — สถานะงาน + สิ่งที่ต้องทำต่อ

> อัปเดตล่าสุด: 2026-07-04 · สำหรับ Claude session ถัดไป (หรือคนที่มารับช่วง) อ่านคู่กับ `CLAUDE.md`

## TL;DR

แอป deploy อยู่ที่ https://ton-phet-tennis-862607193158.asia-southeast1.run.app (revision `00003`, image `asia-southeast1-docker.pkg.dev/ton-team/ton-phet/app:v1`). ผลเทสสนามจริง (2026-07-04) เจอ 3 ปัญหา — 2 ใน 3 ติดที่ **ยังไม่มี `GEMINI_API_KEY`**, อีก 1 เป็นบั๊กจริงที่**กำลังแก้อยู่ใน workflow ที่ยังรันไม่จบ**

## ผลเทสสนามจริง → การวินิจฉัย

| # | อาการที่ user รายงาน | สาเหตุ | สถานะ |
|---|---|---|---|
| 1 | ไม่เห็นจับภาพวงสวิงเลย | บั๊กจริงในเครื่อง (ไม่เกี่ยวคีย์): shot detection thresholds จูนกับข้อมูลสังเคราะห์ → การตีจริงบนมือถือไม่ทริกเกอร์ "จบวงสวิง" → ไม่มี shot = ไม่มี capture | 🔄 workflow `tonped-capture-fix` กำลังแก้ |
| 2 | ไม่ได้ยินเสียงโค้ช ทั้งที่พูดแล้ว | Gemini Live ต่อไม่ได้ — server ไม่มี `GEMINI_API_KEY` → `/api/token` ตอบ 503 (ตรวจยืนยันแล้ว) | ⛔ บล็อกที่คีย์ — แก้โค้ดไม่ได้ |
| 3 | ไม่โค้ช realtime ตอนขยับมือผิด | เหมือนข้อ 2 + เป็นคำถาม design (ดีไซน์ปัจจุบัน = โค้ชหลังตีจบวง ไม่ใช่เตือนสดระหว่างขยับ) | ⛔ คีย์ + รอ user เลือกรูปแบบ |

**ข้อเท็จจริงที่ตรวจแล้ว:** pose loop / ShotDetector / capture ทำงานแยกจาก Gemini connection โดยสิ้นเชิง (`coachLive.connect()` เป็น fire-and-forget ที่ `src/screens/LiveScreen.tsx:123`) — ฉะนั้นข้อ 1 ไม่ใช่เพราะไม่มีคีย์

## 🔄 งานที่กำลังรัน (ต้องตามต่อ!)

**Workflow `tonped-capture-fix`** — Task ID `wdaggp2et`, run `wf_f7da6a33-0ea`
- Script: `~/.claude/projects/-Users-h522140-Documents-Claude-Projects-tennis-project01/01445457-e1d6-4fb6-bf39-055b0c61f49d/workflows/scripts/tonped-capture-fix-wf_f7da6a33-0ea.js`
- Journal: `.../subagents/workflows/wf_f7da6a33-0ea/journal.jsonl` (อ่านนี่เพื่อดู progress/ผลลัพธ์แต่ละ agent)
- แผน: Fable Plan (วินิจฉัย) → Contracts (store/types) → Build ขนาน (detect=Sonnet: จูน SHOT_THRESHOLDS + การันตี capture ไม่ว่างทุก shot; hud=Opus: HUD บนจอโชว์ phase/จำนวนวงที่จับได้/แฟลชตอน capture ลง + empty-state ใน CaptureGallery) → Integrate (typecheck+test+build+Playwright) → Fable Review (schema: captureGuaranteed / hudShows / detectionLoosened)
- ถ้า workflow ตาย/หลุด: resume ด้วย `Workflow({scriptPath: <ข้างบน>, resumeFromRunId: "wf_f7da6a33-0ea"})`

**เมื่อ workflow เสร็จ (verdict ship/ship-with-fixes):**
1. แก้ findings ระดับ major (ถ้ามี) → `npm run typecheck && npm run test && npm run build` ต้องเขียวหมด
2. Rebuild + push image: `docker buildx build --platform linux/amd64 -t asia-southeast1-docker.pkg.dev/ton-team/ton-phet/app:v1 --push .` (colima ต้องรันอยู่: `colima start`)
3. Deploy: `gcloud run deploy ton-phet-tennis --image asia-southeast1-docker.pkg.dev/ton-team/ton-phet/app:v1 --region asia-southeast1 --allow-unauthenticated --project ton-team`
4. Smoke: `curl -s -o /dev/null -w "%{http_code}" <URL>/` ต้อง 200
5. **Audit secret ก่อน commit ทุกครั้ง**: `git diff --cached | grep -nE 'AQ\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}'` ต้อง CLEAN
6. Commit + push → https://github.com/Piyaphan-P/tennis-tonped

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

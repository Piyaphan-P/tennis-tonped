# 🎾 ADGE Tennis (SIT) — AI Realtime Tennis Coach

> **SIT (non-production) build.** Brand: **ADGE Tennis**, coach **โค้ช ADGE**, DB isolation via `DB_SCHEMA=sit`. The `main` branch is production (**ต้นและเพชร Tennis Club**).

แอปวิเคราะห์การตีเทนนิสแบบ **realtime** ด้วยกล้องมือถือ: จับโครงกระดูก (pose) วาดเส้นวิเคราะห์ลงบนตัวผู้เล่น วัดมุมแขน–ขา–ลำตัว ให้คะแนนรายช็อต และมี **โค้ช AI (Gemini Live) พูดโต้ตอบเป็นเสียง** คอยบอกว่าควรปรับอะไรหลังตีจบแต่ละวง พร้อม **มอนิเตอร์ค่าใช้จ่าย token เป็นเงินบาท** ต่อเซสชัน

> **An AI realtime tennis coach.** Open your phone camera → live skeleton overlay + joint angles + per-shot score → a spoken Gemini Live coach that tells you the one thing to fix after each swing → per-session cost tracking in THB.

Phase 1 = **mobile-first web app** (เล่นกับเครื่องยิงลูกในคอร์ท) · ภาษา **ไทย/อังกฤษ** สลับได้

---

## ✨ ฟีเจอร์หลัก / Features

- **📷 Realtime pose overlay** — MediaPipe PoseLandmarker ทำงานในเครื่อง (ฟรี, ไว, เป็นส่วนตัว) วาดโครงกระดูก 33 จุด
  - 🩶 เส้น**เทา** = การเคลื่อนไหวปกติ · 💚 เส้น**เขียว** = ฟอร์มดี (มุมอยู่ในเป้า) · ❤️ เส้น**แดง** = จุดที่ต้อง improve
- **🎾 Coach-first** — คำแนะนำตัวใหญ่เด่นชัด โค้ช**ดูจนตีจบวงแล้วค่อยพูด** (ไม่กวนตอนกำลังตี) และ**พูดออกเสียงจริง**
- **🗣️ โต้ตอบด้วยเสียง** — กดปุ่ม "ถามโค้ช" (push-to-talk) คุยถาม-ตอบกับโค้ชได้
- **🙋 เรียกชื่อผู้เล่น** — กรอกชื่อ โค้ชจะเรียกชื่อตอนพูดให้เป็นกันเอง
- **📸 Swing capture + วิจารณ์รายภาพ** — เก็บภาพช่วงตี (โดยเฉพาะจังหวะกระทบ) แสดงพร้อมโครงกระดูกสี และโค้ชชี้จุดที่แย่ในภาพนั้น
- **📊 สถิติ + สรุปพัฒนาการ** — คะแนนเฉลี่ย, จำนวนช็อต, %ฟอร์มดี, ความเร็วสูงสุด, เทรนด์ข้ามเซสชัน และสรุป "ควร improve อะไร" รายเซสชัน
- **🕒 History 3 วัน** — เก็บประวัติใน localStorage แล้วลบอัตโนมัติเมื่อเกิน 3 วัน
- **💰 Cost monitor (บาท)** — อ่าน token จริงจาก `usageMetadata` แยกตาม modality (text/audio/video) → คูณเรตที่ตั้งค่าได้ → รวมเป็นบาทต่อเซสชัน + ประมาณต่อช็อต (ปุ่ม ฿ เล็ก ๆ มุมจอ)

---

## 🏗️ สถาปัตยกรรม / Architecture

```
Browser (mobile)                          Backend (Cloud Run, holds the real key)
┌─────────────────────────────┐           ┌───────────────────────────────┐
│ Camera ─▶ MediaPipe Pose      │           │ GET /api/token                │
│   • skeleton overlay (local)  │           │   mints a fresh ephemeral     │
│   • joint angles (local)      │  fetch    │   token (AQ.…) from a          │
│   • shot detect + score(local)│ ────────▶ │   long-lived GEMINI_API_KEY   │
│                               │  token    │   (Secret Manager)            │
│ per completed shot ──────────────────────────▶ Gemini Live (native audio) │
│   send angles+score+1 jpeg    │           │   ▲ spoken coaching + usage    │
│ ◀─ spoken coaching + transcript + usageMetadata                            │
│ cost engine ─▶ THB per shot / per session                                  │
└─────────────────────────────┘           └───────────────────────────────┘
```

**Hybrid coaching model:** pose detection, angle math, shot segmentation และ score ทำ**ในเครื่องทั้งหมด** (ไม่มีค่าใช้จ่าย, ตอบทันที) — ส่งข้อมูลไป Gemini **เฉพาะตอนตีจบแต่ละช็อต** (ข้อความมุม+คะแนน + รูปจังหวะกระทบ 1 รูป) ไม่สตรีมวิดีโอต่อเนื่อง → ประหยัด token และโค้ชได้ตรงจุดกว่า

**Tech stack:** Vite + React 18 + TypeScript · Zustand · plain CSS tokens · `@mediapipe/tasks-vision` · `@google/genai` v2 (Gemini Live) · Node/Express backend

---

## 🚀 เริ่มใช้งาน (Local dev)

```bash
# 1) frontend
npm install
cp .env.example .env.local     # แล้วกรอกค่า (ดูหัวข้อ Auth ด้านล่าง)
npm run dev                    # http://localhost:5173

# 2) (ทางเลือก) backend token endpoint — สำหรับ token ที่ต่ออายุอัตโนมัติ
cd server && npm install
GEMINI_API_KEY=AIza... node index.mjs   # http://localhost:8080
# แล้วตั้ง VITE_TOKEN_ENDPOINT=http://localhost:8080/api/token ใน .env.local
```

เปิดบนมือถือ (กล้องต้องใช้ **https** หรือ `localhost`) → กรอกชื่อ → เลือกช็อต → **เริ่มซ้อม** → อนุญาตกล้อง

### สคริปต์
| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | typecheck + production build → `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | unit tests (vitest) — cost/angle/history math |

---

## 🔑 Auth — สำคัญมาก (ephemeral token หมดอายุ ~30 นาที)

Gemini Live ฝั่ง browser ใช้ **ephemeral token** (ขึ้นต้น `AQ.`) ที่หมดอายุใน ~30 นาที มี 2 วิธี:

1. **Paste token (เทสเร็ว):** ใส่ `VITE_GEMINI_TOKEN=AQ.…` ใน `.env.local` หรือแปะในหน้า Settings ของแอป — เหมาะทดสอบสั้น ๆ เท่านั้น เพราะจะหมดอายุกลางเซสชัน
2. **Backend token-minting (แนะนำ / production):** ตั้ง `VITE_TOKEN_ENDPOINT=/api/token` แอปจะ **ขอ token ใหม่อัตโนมัติทุกครั้งที่ต่อ/ต่อใหม่** → เล่นได้ทั้งเซสชันไม่ตัด backend ถือ **long-lived key (`AIza…`)** ไว้ฝั่งเดียว (Secret Manager) — key ตัวจริงไม่มีทางถึง browser

> 🔐 **ห้าม**ใส่ `AIza…` (long-lived key) ใน frontend/`VITE_*` เด็ดขาด เพราะจะถูก bundle ไปโผล่ในเบราว์เซอร์ ให้ใส่เฉพาะฝั่ง backend เท่านั้น

---

## ☁️ Deploy ขึ้น Google Cloud Run

Build เป็น container เดียว (Node serve `dist/` + `/api/token`) — ดู `Dockerfile`

```bash
# โปรเจค GCP: adge-tennis-nonprd (SIT) / adge-tennis-prod (production)
gcloud config set project adge-tennis-nonprd

# เก็บ key ตัวจริงเป็น secret (ครั้งเดียว)
echo -n "AIzaYOUR_REAL_KEY" | gcloud secrets create gemini-api-key --data-file=-

# build image ในเครื่อง (colima ต้องรันอยู่) แล้ว push + deploy
docker buildx build --platform linux/amd64 \
  -t asia-southeast1-docker.pkg.dev/adge-tennis-nonprd/adge/app:sit-vN --push .

gcloud run deploy adge-tennis-sit \
  --image asia-southeast1-docker.pkg.dev/adge-tennis-nonprd/adge/app:sit-vN \
  --region asia-southeast1 --allow-unauthenticated \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

จากนั้นเปิด URL ที่ Cloud Run ให้มาบนมือถือได้เลย

---

## 💰 Cost model (บาท)

อ่าน token จริงจาก Gemini `usageMetadata` ทุกข้อความ แยก modality แล้วคูณเรต:

```
THB = tokens × (USD_per_1M × VITE_USD_TO_THB) / 1,000,000
```

เรตเริ่มต้น (แก้ได้ในหน้า Settings) — Gemini 2.5 Flash native-audio Live:

| Modality | USD / 1M tokens |
|---|---|
| text in | $0.50 |
| audio in / video in | $3.00 |
| text out | $2.00 |
| audio out | $12.00 |

- **ยอดต่อเซสชัน** = เชื่อถือได้ (รวม token จริงทั้งหมด)
- **ต่อช็อต** = ประมาณการ (แบ่งตามช่วงเวลาของแต่ละช็อต) — ในแอปจะติดป้าย "≈/โดยประมาณ"

> เสียงถูกกว่า text มาก และ audio out แพงสุด — จึงออกแบบให้โค้ชพูดสั้น กระชับ ต่อช็อต

---

## 🔒 Security

- `.env.local`, service-account `*.json`, key ทุกชนิด **ถูก gitignore** และไม่มีใน repo (ตรวจด้วย `grep` ก่อน commit ทุกครั้ง)
- Frontend เห็นได้แค่ **ephemeral token** เท่านั้น — รั่วแล้วเสียหายจำกัด (30 นาที)
- Long-lived `AIza…` อยู่ใน **Secret Manager / backend** เท่านั้น
- 🔁 ถ้าเคยแชร์ token/key ที่ไหน ให้ **rotate** ทันที

---

## 📁 โครงสร้างโปรเจกต์

```
src/
  pose/        poseLandmarker · angles          (MediaPipe + มุมข้อต่อ)
  analysis/    shotDetector · scoring · captureRenderer  (จับช็อต + คะแนน + วาดภาพแคป)
  coach/       liveClient · audioPlayer · mic    (Gemini Live + เสียงเข้า/ออก)
  cost/        pricing · costMonitor (+tests)    (คำนวณบาท)
  components/  PoseCanvas · CoachBubble · CaptureGallery · CostFab · StatsCard · HistoryList …
  screens/     Home · Live · Summary · DevPlan
  store.ts · types.ts · i18n.ts · theme.css
server/        index.mjs · package.json          (token-minting + static server)
Dockerfile                                        (Cloud Run single container)
```

---

## ⚠️ ขอบเขต Phase 1 & สิ่งที่ต้องเทสในสนามจริง

- **เครื่องยิงลูกยังไม่ต่อ** ในเฟสนี้ (ตัด UI ออกแล้ว)
- ความแม่นของ pose ขึ้นกับมุมกล้อง/แสง — ต้องจูน `SHOT_THRESHOLDS` กับการตีจริง
- คุณภาพ "ฟีลโค้ช" และ latency เสียง ต้องทดสอบบนคอร์ทจริงด้วย token สด
- ต้องมี `GEMINI_API_KEY` (AIza…) ใส่เป็น secret จึงจะโค้ชสดได้ต่อเนื่อง

## 🗺️ Roadmap ถัดไป
เชื่อมเครื่องยิงลูก · reference ฟอร์มโปร · วัดความเร็ว/ทิศทางลูก · ระบบสมาชิก/หลายคอร์ท · dashboard เจ้าของคอร์ท

---

*Phase 1 built with a Fable-led multi-agent workflow (Fable = Product Owner; Opus/Sonnet = implementation). Pose/score/cost are real; coaching quality pending on-court human testing.*

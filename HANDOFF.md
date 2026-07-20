# HANDOFF.md — สถานะงาน + สิ่งที่ต้องทำต่อ (branch `SIT`)

> อัปเดตล่าสุด: **2026-07-20** (GCP migration → `adge-tennis-nonprd`) · อ่านคู่กับ `CLAUDE.md` (session log เต็ม) + `tasksYYYYMMDD.md` ของแต่ละวัน
> **กฎเหล็ก:** ทุกวันทำงานต้องมี `tasksYYYYMMDD.md` และอัพเดทไฟล์นี้ + CLAUDE.md + git ทุกครั้ง

## TL;DR

**ADGE Tennis (SIT)** deploy อยู่ที่ https://adge-tennis-sit-441370880467.asia-southeast1.run.app (โปรเจค GCP **`adge-tennis-nonprd`**, image `app:sit-v7`, code = **SIT v1.4** commit `b698f37`) + เว็บ Ranking https://adge-ranking-sit-441370880467.asia-southeast1.run.app · backend = **Firestore** DB `nonprd` (platform TTL 3 วัน) + GCS `adge-tennis-nonprd-clips` · `GEMINI_API_KEY` มาจาก Secret Manager (`gemini-api-key`) — **ไม่มี blocker เรื่องคีย์แล้ว** · login gate `admin`/`adge`

## โครงสร้าง GCP ปัจจุบัน (ตั้งแต่ 2026-07-20)

| | SIT | Production |
|---|---|---|
| โปรเจค | `adge-tennis-nonprd` | `adge-tennis-prod` |
| Cloud Run | `adge-tennis-sit` + `adge-ranking-sit` | **ยังว่าง — APIs ยังไม่ enable** |
| Bucket | `adge-tennis-nonprd-clips` (lifecycle 3 วัน) | — |
| Artifact Registry | `asia-southeast1-docker.pkg.dev/adge-tennis-nonprd/adge/` | — |
| Metadata | Firestore `nonprd` (index `shots.id` COLLECTION_GROUP = **READY**) | — |
| Secret | `gemini-api-key` (wired บน service แล้ว) | — |
| Runtime SA | `sa-adge-tennis-non-prd@adge-tennis-nonprd.iam.gserviceaccount.com` | — |

โปรเจคเก่า `ton-team` **ถูกลบแล้ว** — code/docs replace หมดแล้ว (งาน 2026-07-20, ดู `tasks20260720.md`) · gcloud auth = `piyaphan.po@gmail.com`

**ขั้นตอน deploy มาตรฐาน:**
1. `npm run typecheck && npm run test && npm run build` เขียวหมด
2. `docker buildx build --platform linux/amd64 -t asia-southeast1-docker.pkg.dev/adge-tennis-nonprd/adge/app:sit-vN --push .` (colima ต้องรัน)
3. `gcloud run deploy adge-tennis-sit --image <อันเดิม> --region asia-southeast1 --project adge-tennis-nonprd --allow-unauthenticated`
4. Smoke: `curl -s -o /dev/null -w "%{http_code}" https://adge-tennis-sit-441370880467.asia-southeast1.run.app/` = 200
5. **Secret audit ก่อน commit:** `git diff --cached | grep -nE 'AQ\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}'` ต้อง CLEAN
6. Commit + push → https://github.com/Piyaphan-P/tennis-tonped

## งานล่าสุดที่เสร็จ

- **2026-07-20 — GCP migration:** replace `ton-team`/`ton-phet` ทั้ง repo → `adge-tennis-nonprd` (code defaults, package names, README, CLAUDE.md, HANDOFF.md) · ยืนยัน Firestore index READY · ตั้ง gcloud project ใหม่ · **ยังไม่ได้ build/deploy image ใหม่** (โค้ดที่เปลี่ยนเป็น default fallback — service จริงตั้ง env ครบอยู่แล้ว จึงไม่กระทบ runtime)
- **SIT v1.4 (2026-07-16, `b698f37`):** แก้บั๊กคะแนน 2 ตัว (stale speed penalty −15 คะแนนถาวร + มุมไหล่เพี้ยนจาก 2D → `angleDeg3D`) ⚠️ คะแนนใหม่สูงขึ้น ~7.5–15 แต้มเทียบยุคเก่า · โค้ช 14→30 เสียง (no-repeat window 5, ยาว 2–4 ประโยค) · ความเร็วสวิง ≈km/h จากส่วนสูงผู้เล่น (Settings, default 170cm) · 286/286 tests
- ก่อนหน้า (v1.1–v1.3.1): FIFO coach queue · login gate · camera 720p + flip + fps HUD · turn watchdog 20s (แก้ freeze v1.3) · Gemini Live 3 (`gemini-3.1-flash-live-preview`) · เสียงโค้ชหญิงแบบ prod — ดู session log ใน CLAUDE.md

## สิ่งที่ต้องทำต่อ / รอเทสสนาม

0. **UAM v1.5 (แผนพร้อมแล้ว — `plan-uam-v15.md`, รอ user อนุมัติ):** email เป็น key หลัก · role admin (เห็น/แก้/ลบทุก session + จัดการ player) / player (เห็นเฉพาะของตัวเอง) · `users/{email}` ใน Firestore (scrypt hash) · cookie ต่อคน (`AUTH_SECRET` + bootstrap `ADMIN_EMAIL`/`ADMIN_PASS`) · AdminScreen เพิ่ม/ลบ player · กรอง history/detail/clips ตาม `ownerEmail` · 3 ข้อตัดสินใจค้างในไฟล์แผน (leaderboard, Postgres depth, self-service password)
1. **เทสสนาม v1.4:** ชิปมุมไหล่กะพริบจาก z noise ไหม · ตัวเลข km/h ต่ำกว่าจริงไหม (ถ้าใช่ → ตัดสินใจ correction factor = PO decision)
2. **Deploy รอบหน้า** ใช้ image tag `sit-v8` ขึ้นไป (v1.4 code ยังไม่ได้ deploy — service รัน `sit-v7`) — ตรวจว่า v1.4 อยู่ใน sit-v7 หรือยังก่อน build ซ้ำ
3. **Prod migration (`adge-tennis-prod`):** enable APIs (run/artifactregistry/secretmanager/firestore/storage) → สร้าง bucket + AR repo + secret + Firestore (อย่าลืม index `shots.id` COLLECTION_GROUP + TTL `expireAt`) → deploy จาก branch `main` (แบรนด์ ต้นและเพชร)
4. **Repo `../tennis_ranking01`:** ยังอ้าง `ton-team` อยู่ — ต้อง replace แบบเดียวกัน (นอก scope งาน 2026-07-20)
5. **ค้างเก่า:** rotate รหัส Supabase + AQ. tokens เก่าที่เคยแชร์ในแชท (path Postgres ไม่ได้ deploy แล้ว แต่ credential hygiene ยังควรทำ)

## ความจริงที่ห้ามลืม (จ่ายบทเรียนมาแล้ว)

- Live model (SIT): `gemini-3.1-flash-live-preview` (Dockerfile `LIVE_MODEL`) · rollback = `gemini-2.5-flash-native-audio-preview-09-2025` · `apiVersion:'v1beta'` · ห้าม send ใน `onopen`
- Docker build ในเครื่องเท่านั้น (foreground) — colima ต้องรัน
- Audit secret ทุกครั้งก่อน push — เคยมี token หลุดใน demo files มาแล้ว
- แบรนด์ branch นี้ = **ADGE Tennis / โค้ช ADGE** ห้ามปน "ต้นและเพชร" (นั่นของ `main`)
- Firestore path ไม่มี purge job — platform TTL จัดการเอง ห้ามเพิ่ม
- Scoring era break ที่ v1.4: leaderboard ปนคะแนนสองยุค (ก่อน/หลังแก้บั๊ก)

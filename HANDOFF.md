# HANDOFF.md — สถานะงาน + สิ่งที่ต้องทำต่อ (branch `SIT`)

> อัปเดตล่าสุด: **2026-07-21** (SIT v1.9 — แยกประวัติรายผู้เล่น + admin daily overview) · อ่านคู่กับ `CLAUDE.md` (session log เต็ม) + `tasksYYYYMMDD.md` ของแต่ละวัน
> **กฎเหล็ก:** ทุกวันทำงานต้องมี `tasksYYYYMMDD.md` และอัพเดทไฟล์นี้ + CLAUDE.md + git ทุกครั้ง

## TL;DR

**ADGE Tennis (SIT)** deploy อยู่ที่ https://adge-tennis-sit-441370880467.asia-southeast1.run.app (โปรเจค GCP **`adge-tennis-nonprd`**, image `app:sit-v15`, code = **SIT v1.9** — ประวัติ/สถิติแยกรายผู้เล่นด้วย `userName`, admin เห็นสถิติรวมรายวันแทน) + เว็บ Ranking https://adge-ranking-sit-441370880467.asia-southeast1.run.app (repo `../tennis_ranking01` migrate off ton-team แล้ว) · backend = **Firestore** DB `nonprd` + GCS `adge-tennis-nonprd-clips` · `GEMINI_API_KEY` (Secret Manager, เติมเครดิตแล้ว) · **login email/password ต่อคน** role admin/player (bootstrap `piyaphan.po@gmail.com`) · code-review 8/8 แก้แล้ว (revocation TTL 1 ชม.) · **v1.6** เลือกเสียง 4 × สไตล์โค้ช 4 · **v1.4-mit** shoulder EMA + km/h knob · **v1.8** stats widget บนหน้า Summary (นาที/total shots/avg speed/kcal/spin%) + share canvas · **v1.9** ประวัติหน้า Home แยกนับรายคน (playerKey = userName) + AdminDailyStats (ผู้เล่นกี่คน/ชั่วโมงไหน ต่อวัน) · **403 tests**
> **ถัดไป: ไม่มีงานค้างที่รอ build** — เหลือแต่ที่ต้อง user ทำเอง (rotate credential, เทสสนามจริง v1.4/v1.6/v1.8) + prod migration ไป adge-tennis-prod

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

- **2026-07-20 — UAM v1.5 SHIPPED (image `app:sit-v8`, revision `00003`, 310/310 tests, E2E ครบบน service จริง):** email = key หลัก · login ต่อคน (`users/{email}` Firestore, scrypt hash, cookie HMAC ต่อคน 90 วัน ผ่าน env `AUTH_SECRET`) · role **admin** (เห็น/แก้/ลบทุก session + จัดการ player ผ่านหน้า Admin + `/api/users*`) / **player** (เห็นเฉพาะของตัวเอง — ของคนอื่นตอบ 404 ไม่ leak) · bootstrap admin ผ่าน env `ADMIN_EMAIL`(=piyaphan.po@gmail.com)+`ADMIN_PASS` ตอน boot (fire-and-forget — login ทันทีหลัง cold start อาจ 401 หนึ่งครั้ง = race ปกติ retry ได้) · `GATE_USER/PASS` ถอดออกแล้ว · AdminScreen (เพิ่ม/ลบ/disable/reset password, กันลบ/disable ตัวเอง) + logout ใน Settings · session ประทับ `ownerEmail` ฝั่ง server · leaderboard เห็นรวมทุกคน (ตามคำสั่ง user) · Postgres path = stub 503 (prod จะย้ายมา Firestore) · **สำคัญ:** listHistory กรอง owner ด้วย equality-only + sort ใน memory — ห้ามใส่ orderBy ควบ where (composite index ไม่มี จะ 503) · หลัง deploy ทุกเครื่องต้อง login ใหม่ (ตั้งใจ) · แผนเต็ม `plan-uam-v15.md`
- **2026-07-20 — GCP migration:** replace `ton-team`/`ton-phet` ทั้ง repo → `adge-tennis-nonprd` (code defaults, package names, README, CLAUDE.md, HANDOFF.md) · ยืนยัน Firestore index READY · ตั้ง gcloud project ใหม่ · **ยังไม่ได้ build/deploy image ใหม่** (โค้ดที่เปลี่ยนเป็น default fallback — service จริงตั้ง env ครบอยู่แล้ว จึงไม่กระทบ runtime)
- **SIT v1.4 (2026-07-16, `b698f37`):** แก้บั๊กคะแนน 2 ตัว (stale speed penalty −15 คะแนนถาวร + มุมไหล่เพี้ยนจาก 2D → `angleDeg3D`) ⚠️ คะแนนใหม่สูงขึ้น ~7.5–15 แต้มเทียบยุคเก่า · โค้ช 14→30 เสียง (no-repeat window 5, ยาว 2–4 ประโยค) · ความเร็วสวิง ≈km/h จากส่วนสูงผู้เล่น (Settings, default 170cm) · 286/286 tests
- ก่อนหน้า (v1.1–v1.3.1): FIFO coach queue · login gate · camera 720p + flip + fps HUD · turn watchdog 20s (แก้ freeze v1.3) · Gemini Live 3 (`gemini-3.1-flash-live-preview`) · เสียงโค้ชหญิงแบบ prod — ดู session log ใน CLAUDE.md

## สิ่งที่ต้องทำต่อ / รอเทสสนาม

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

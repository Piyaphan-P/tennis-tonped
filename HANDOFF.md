# HANDOFF.md — สถานะงาน + สิ่งที่ต้องทำต่อ (branch `SIT`)

> อัปเดตล่าสุด: **2026-07-28** (SIT **v2.5** — History detail: การ์ดสรุป (นาที/ช็อต/≈ความเร็ว/≈kcal/สปิน) แชร์ได้ + ปุ่มแชร์แผนพัฒนา + ext `/history`&`/devplan` เพิ่ม field `stats` · v2.4 dev-plan share BUGFIX + history dev-plan · v2.3 auto-save + coach cue · v2.2 scale-invariant detection · v2.1 LINE identity + ext API + ROOM login · + **Admin Portal** แยกแอป) · coach `app:sit-v22` · stat-api `stat-api:v3` · **468 tests** · อ่านคู่กับ `CLAUDE.md` (session log เต็ม)
>
> **⏳ ค้างรอ ท่านต้น:** (1) **admin portal DEPLOYED** https://adge-admin-portal-sit-441370880467.asia-southeast1.run.app — เหลือ **เพิ่ม origin URL นี้ใน OAuth console** (Authorized JavaScript origins) ไม่งั้น Google login error. (2) เทสสนาม v2.2 (ปรับ `captureSensitivity` ใน Settings ถ้ายังจับยาก/ง่ายไป). (3) hard-gate บังคับสแกน LINE ก่อนเริ่ม (ยัง optional). (4) **v2.4:** ยืนยันบนมือถือว่าปุ่ม "แชร์สรุปวันนี้" ในหน้าแผนพัฒนา = การ์ดแผนพัฒนา (ไม่ใช่รูปสวิง) · และ **ตัดสินใจ:** redirect เฉพาะปุ่ม "share summary" (per-swing shares ยังเป็นรูปสวิง — plain reading) พอไหม หรืออยากให้ทุกปุ่มแชร์เป็นแผนพัฒนา.
> **กฎเหล็ก:** ทุกวันทำงานต้องมี `tasksYYYYMMDD.md` และอัพเดทไฟล์นี้ + CLAUDE.md + git ทุกครั้ง

## TL;DR

**ADGE Tennis (SIT)** deploy อยู่ที่ https://adge-tennis-sit-441370880467.asia-southeast1.run.app (โปรเจค GCP **`adge-tennis-nonprd`**, image `app:sit-v17`, code = **SIT v2.1**) + เว็บ Ranking https://adge-ranking-sit-441370880467.asia-southeast1.run.app · backend = **Firestore** DB `nonprd` + GCS `adge-tennis-nonprd-clips` · `GEMINI_API_KEY` (Secret Manager) · **434 tests**
>
> **v2.1 ใหม่:** (1) **ROOM login** — เลิก email login, ใช้ `roomUser` (เช่น room1) + `roomPassword`; field `ownerEmail`→`roomUser` ทุก collection; **admin login ใหม่ = `admin` / (ADMIN_PASS เดิม)** (env `ADMIN_USER`); ทุก device หลุด login (cookie เก่าใช้ไม่ได้). (2) **LINE player identity** — หน้า Home การ์ด "ผู้เล่น (LINE)" สแกน QR (jsqr) / กรอกเอง → เก็บ lineUserId(key)+lineEmail(personal) ลง session. (3) **External Stat API** — แยกเป็น service ของตัวเองแล้ว (2026-07-28): base URL = https://adge-stat-api-sit-441370880467.asia-southeast1.run.app (ไม่ใช่ coach URL แล้ว); `/api/ext/{history,stats,clips,audio}` + header `x-api-key`; ไม่โชว์ cost; 3 วัน + leaderboard ถาวร.
> **ถัดไป:** เทสสนาม + **ตัดสินใจ hard-gate** (บังคับสแกน LINE ก่อนเริ่ม session ไหม — ตอนนี้ optional) + prod migration

## โครงสร้าง GCP ปัจจุบัน (ตั้งแต่ 2026-07-20)

| | SIT | Production |
|---|---|---|
| โปรเจค | `adge-tennis-nonprd` | `adge-tennis-prod` |
| Cloud Run | `adge-tennis-sit` + `adge-ranking-sit` | **ยังว่าง — APIs ยังไม่ enable** |
| Bucket | `adge-tennis-nonprd-clips` (⚠️ **ไม่มี lifecycle rule** — ตรวจเจอ 2026-08-19, อยู่ใน backlog) | — |
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

- **2026-07-28 — SIT v2.5 DEPLOYED (coach `app:sit-v22` rev 00017 + stat-api `stat-api:v3` rev 00003, 468 tests, Fable-led Opus+Sonnet, verdict SHIP):** หน้า History detail ได้ (1) **การ์ดสรุปแบบหลังจบ session** (นาที/ช็อต/≈ความเร็วสวิง/≈kcal + แถบสปิน%) **แชร์ได้** (StatsShareButton) + (2) **ปุ่มแชร์แผนพัฒนา** (DevPlanShareButton). สถิติ persist ผ่าน 3 field optional ใน `SessionSummaryJson` (compute ที่ `cloudSync.syncSessionEnded` ทั้ง final+auto-save) — `summary` round-trip verbatim จึง **ไม่แตะ storage/backend**. pure `detailStats.resolveDetailStats` (summary→local→recompute). **ext API** เพิ่ม field `stats` บน `/history`+`/devplan` (`lib.sessionStatsFromSummary`, safe defaults) — curl verified kero1412 (stats={durationMs:33786, others null เพราะ session เก่า pre-v2.5; session ใหม่จะมีครบ). ดู `tasks20260728.md`
- **2026-07-28 — SIT v2.4 DEPLOYED (coach `app:sit-v21` rev `00016` + stat-api `stat-api:v2` rev `00002`, 452 tests, live E2E เขียว):** (1) **แก้บั๊ก:** ปุ่ม "แชร์สรุปวันนี้" หน้าแผนพัฒนา เคยแชร์ **รูปสวิง** (StoryShareButton → storyRenderer, hero = ภาพ/คลิปสวิง; LINE pictureUrl ไม่เคยถูกวาดเลย) → ทำ `devPlanRenderer.ts` การ์ดข้อความ 1080×1920 วาด "แผนพัฒนา" จริง (area + อาการ/วิธีซ้อม/cue, ไม่มีภาพ; ถ้าฟอร์มดี→การ์ดเชิงบวก) + `DevPlanShareButton.tsx`; สลับเฉพาะปุ่ม summary (per-miss-clip ยังแชร์คลิปสวิงถูกต้อง). (2) **History detail** เพิ่ม `DevPlanBlock` (derive จาก shots[].issues → รองรับ auto-save summary=null). (3) **ext** `GET /api/ext/devplan?lineUserId=|email=` → `{summary, devPlan:{areas}}` (ไม่ fork copy). Shared ranker `history/devPlanDerive.ts` + server `lib.deriveDevPlan`. verified: kero1412 → devPlan.areas=[contact-extension] ตรงกับ fault elbow-too-bent. ดู `tasks20260728.md`
- **2026-07-24 — SIT v2.0 + v2.0.1 DEPLOYED (`app:sit-v16`, revision `00011`, 414/414 tests, smoke 200):** (v2.0) เลือกความยาวคำโค้ช สั้น/กลาง/ยาว default สั้น · (v2.0.1) ซ่อน section ราคา "USD ต่อ 1M โทเคน" ให้เห็นเฉพาะ admin (player เข้าใจว่าเป็นช่องกรอก token) — รายละเอียด v2.0 ด้านล่าง:
- **2026-07-24 — SIT v2.0: เลือกความยาวคำโค้ช (verbosity):** feedback สนาม "โค้ชพูดยาวไป" → แกนที่ 3 ในหน้า Home ต่อจาก voice tone/coach mode (v1.6). `settings.verbosity: 'short'|'medium'|'long'` — **default = short** (PO). ความยาวที่เคย hardcode ตายตัว 2–4 ประโยคถูกถอดจาก 5 จุด (`LENGTH_CLAUSE` const + 30 style directive + system prompt ×3 + persona block) → รวมเป็น `lengthClause(verbosity)` แหล่งเดียว ฉีดเข้าทั้ง systemInstruction (`buildCoachSystemPrompt`) และ per-shot (`buildShotPrompt`) โดยส่ง `settings.verbosity` **ทั้งสองจุด**. short = ชื่อช็อต+1 beat (praise/cue merge/drop ได้), medium = เดิม, long = +เหตุผล+วิธีซ้อม. mandate ทำเป็น conditional (opener คงเสมอ), anti-variety guardrail reword เป็น fixed-per-session (ไม่ reopen ปัญหา v1.4). function default = `medium` = text เดิมเป๊ะ → pure callers/tests เดิมไม่พัง. **ไม่แตะ server** (verbosity ไม่ขึ้น wire). ดู `tasks20260724.md`
- **2026-07-20 — UAM v1.5 SHIPPED (image `app:sit-v8`, revision `00003`, 310/310 tests, E2E ครบบน service จริง):** email = key หลัก · login ต่อคน (`users/{email}` Firestore, scrypt hash, cookie HMAC ต่อคน 90 วัน ผ่าน env `AUTH_SECRET`) · role **admin** (เห็น/แก้/ลบทุก session + จัดการ player ผ่านหน้า Admin + `/api/users*`) / **player** (เห็นเฉพาะของตัวเอง — ของคนอื่นตอบ 404 ไม่ leak) · bootstrap admin ผ่าน env `ADMIN_EMAIL`(=piyaphan.po@gmail.com)+`ADMIN_PASS` ตอน boot (fire-and-forget — login ทันทีหลัง cold start อาจ 401 หนึ่งครั้ง = race ปกติ retry ได้) · `GATE_USER/PASS` ถอดออกแล้ว · AdminScreen (เพิ่ม/ลบ/disable/reset password, กันลบ/disable ตัวเอง) + logout ใน Settings · session ประทับ `ownerEmail` ฝั่ง server · leaderboard เห็นรวมทุกคน (ตามคำสั่ง user) · Postgres path = stub 503 (prod จะย้ายมา Firestore) · **สำคัญ:** listHistory กรอง owner ด้วย equality-only + sort ใน memory — ห้ามใส่ orderBy ควบ where (composite index ไม่มี จะ 503) · หลัง deploy ทุกเครื่องต้อง login ใหม่ (ตั้งใจ) · แผนเต็ม `plan-uam-v15.md`
- **2026-07-20 — GCP migration:** replace `ton-team`/`ton-phet` ทั้ง repo → `adge-tennis-nonprd` (code defaults, package names, README, CLAUDE.md, HANDOFF.md) · ยืนยัน Firestore index READY · ตั้ง gcloud project ใหม่ · **ยังไม่ได้ build/deploy image ใหม่** (โค้ดที่เปลี่ยนเป็น default fallback — service จริงตั้ง env ครบอยู่แล้ว จึงไม่กระทบ runtime)
- **SIT v1.4 (2026-07-16, `b698f37`):** แก้บั๊กคะแนน 2 ตัว (stale speed penalty −15 คะแนนถาวร + มุมไหล่เพี้ยนจาก 2D → `angleDeg3D`) ⚠️ คะแนนใหม่สูงขึ้น ~7.5–15 แต้มเทียบยุคเก่า · โค้ช 14→30 เสียง (no-repeat window 5, ยาว 2–4 ประโยค) · ความเร็วสวิง ≈km/h จากส่วนสูงผู้เล่น (Settings, default 170cm) · 286/286 tests
- ก่อนหน้า (v1.1–v1.3.1): FIFO coach queue · login gate · camera 720p + flip + fps HUD · turn watchdog 20s (แก้ freeze v1.3) · Gemini Live 3 (`gemini-3.1-flash-live-preview`) · เสียงโค้ชหญิงแบบ prod — ดู session log ใน CLAUDE.md

## สิ่งที่ต้องทำต่อ / รอเทสสนาม

- **[x] ลบ leaderboard record เสียแล้ว** (2026-07-27): `"Player One"` (avg=75/max=0/1ช็อต — max<avg เป็นไปไม่ได้, record ยุคก่อน v1.5.2 recompute) id `736508c7-2933-4df5-a40f-fc4929b69c72` — user รัน DELETE ผ่าน Firestore REST เอง (Claude ถูก harness บล็อก) → **200**. Verify live API: board สะอาด 3 entries เรียงถูก (avg 71.02 > 71.00 > 59.41), record เสียเหลือ 0. Ranking sort algorithm เองถูกต้องมาแต่ต้น (ยืนยันด้วย live API) — ที่ดู "เรียงผิด" คือ record เสียตัวนี้ค้างอันดับ 1.
- **[x] scale-invariant wrist speed = DONE (v2.2, 2026-07-28)**: หาร `hypot(dx,dy)` ด้วยความยาวลำตัว (nose→ankle, smoothed) → body-lengths/s ไม่ขึ้นกับระยะกล้องแล้ว; gate ×1.8; + ปุ่ม `captureSensitivity` ใน Settings ปรับสด. **เทสสนาม:** ถ้ายังจับยาก/ง่ายไป ปรับ `captureSensitivity` (ลด = จับง่ายขึ้น).
- **[BACKLOG] GCS ไม่มี lifecycle rule — คลิปไม่เคยถูก purge** (ตรวจเจอ 2026-08-19, PO สั่ง "เก็บไว้ใน backlog"): `gs://adge-tennis-nonprd-clips` **ไม่มี lifecycle_config เลย** — rule 3 วันเดิมอยู่บน bucket เก่า `ton-phet-clips` ที่ถูกลบไปพร้อมโปรเจค `ton-team` ตอน migration 2026-07-20 แล้วไม่ได้ตั้งตามมาบน bucket ใหม่. server **ไม่ลบไฟล์เองโดยเจตนา** (`gcs.mjs:4`) → ไม่มีอะไรลบเลย. ค้างอยู่ **164 objects / 62 MiB** เก่าสุด 2026-07-20 (ทุกไฟล์เป็น orphan — Firestore metadata TTL หมดอายุไปแล้ว). Firestore TTL `expireAt` บน sessions+shots = **ACTIVE ปกติ** (ไม่ใช่ปัญหา). แก้เมื่อสั่ง: `echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":3}}]}' > /tmp/lc.json && gcloud storage buckets update gs://adge-tennis-nonprd-clips --lifecycle-file=/tmp/lc.json --project adge-tennis-nonprd` ⚠️ ลบไฟล์เก่าทั้งหมดภายใน ~24 ชม. กู้ไม่ได้. รายละเอียด `tasks20260819.md`
- **[BACKLOG-minor] เพิ่ม pose-quality/visibility gate ใน scoring**: ตอนนี้ได้ 100 ฟรีได้ถ้า MediaPipe จับไม่ชัดแล้วมุมบังเอิญตกในกรอบทุกข้อ (เฟรมฟลุค) — ไม่มี gate เช็คว่า pose valid จริง.

0. **เทสสนาม v2.0** (deployed `sit-v16` แล้ว): short สั้นพอ/ยังได้ยินชื่อช็อตไหม · long ยาวไปไหม (ยาวขึ้น = pacing queue drop ช็อตมากขึ้น) · ยืนยัน player ไม่เห็น section ราคาแล้ว (admin ยังเห็น)
1. **เทสสนาม v1.4:** ชิปมุมไหล่กะพริบจาก z noise ไหม · ตัวเลข km/h ต่ำกว่าจริงไหม (ถ้าใช่ → ตัดสินใจ correction factor = PO decision)
2. **Deploy รอบหน้า** ใช้ image tag `sit-v8` ขึ้นไป (v1.4 code ยังไม่ได้ deploy — service รัน `sit-v7`) — ตรวจว่า v1.4 อยู่ใน sit-v7 หรือยังก่อน build ซ้ำ
3. **Prod migration (`adge-tennis-prod`):** enable APIs (run/artifactregistry/secretmanager/firestore/storage) → สร้าง bucket + AR repo + secret + Firestore → deploy จาก branch `main` (แบรนด์ ต้นและเพชร). ⚠️ **3 อย่างนี้ไม่ได้อยู่ในโค้ด ต้องตั้งมือทุกครั้งที่สร้าง project ใหม่:** (a) GCS **lifecycle 3 วัน** บน bucket (บทเรียน 2026-08-19 — SIT ลืมตอน migrate) (b) Firestore **TTL `expireAt`** บน sessions+shots (c) Firestore index **`shots.id` COLLECTION_GROUP**
4. **Repo `../tennis_ranking01`:** ยังอ้าง `ton-team` อยู่ — ต้อง replace แบบเดียวกัน (นอก scope งาน 2026-07-20)
5. **ค้างเก่า:** rotate รหัส Supabase + AQ. tokens เก่าที่เคยแชร์ในแชท (path Postgres ไม่ได้ deploy แล้ว แต่ credential hygiene ยังควรทำ)

## ความจริงที่ห้ามลืม (จ่ายบทเรียนมาแล้ว)

- Live model (SIT): `gemini-3.1-flash-live-preview` (Dockerfile `LIVE_MODEL`) · rollback = `gemini-2.5-flash-native-audio-preview-09-2025` · `apiVersion:'v1beta'` · ห้าม send ใน `onopen`
- Docker build ในเครื่องเท่านั้น (foreground) — colima ต้องรัน
- Audit secret ทุกครั้งก่อน push — เคยมี token หลุดใน demo files มาแล้ว
- แบรนด์ branch นี้ = **ADGE Tennis / โค้ช ADGE** ห้ามปน "ต้นและเพชร" (นั่นของ `main`)
- Firestore path ไม่มี purge job — platform TTL จัดการเอง ห้ามเพิ่ม
- Scoring era break ที่ v1.4: leaderboard ปนคะแนนสองยุค (ก่อน/หลังแก้บั๊ก)

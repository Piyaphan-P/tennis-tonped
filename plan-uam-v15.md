# แผนงาน SIT v1.5 — UAM (User Access Management): email เป็น key หลัก + role admin/player

> สถานะ: **แผน — รอ user อนุมัติก่อนลงมือ** · เขียน 2026-07-20 · อ่านคู่กับ `CLAUDE.md` (SIT env) + `HANDOFF.md`

## เป้าหมาย (คำสั่ง user)

1. **email = key หลัก** ของการเข้าใช้งาน (แทน login กลาง `admin`/`adge` ตัวเดียวที่ใช้ร่วมกันทุกคน)
2. **role `admin`** — เห็นข้อมูลทุกคน + แก้ไข/ลบ session ได้ + จัดการ player
3. **role `player`** — key หลักคือ email, เห็นเฉพาะข้อมูลตัวเอง
4. **หน้า Admin** — เพิ่ม/ลบ player ด้วย email + password
5. **player ต้องไม่เห็นข้อมูลของกันและกัน** (history / session detail / clips / audio)

## ของเดิมที่ต้องรื้อ (ตรวจโค้ดแล้ว 2026-07-20)

| จุด | ปัจจุบัน | ปัญหา |
|---|---|---|
| `server/authGate.mjs` | login กลาง 1 ชุด (`GATE_USER`/`GATE_PASS`), cookie = HMAC ของ creds ร่วม | ไม่มี identity — แยกคนไม่ได้ |
| `POST /api/sessions` | client ส่ง `userName` (ข้อความอิสระจาก Settings) | ปลอมชื่อใครก็ได้ ไม่ใช่ identity |
| `GET /api/history` | คืน **ทุก session ของทุกคน** (`backend.listHistory(days)` ไม่กรอง) | player เห็นของกันหมด |
| `GET/DELETE /api/sessions/:id`, `GET /api/clips|audio/:shotId` | ไม่เช็คเจ้าของ | รู้ id = เปิด/ลบของคนอื่นได้ |
| Firestore | `sessions/{id}` ไม่มี field เจ้าของ · ไม่มี collection `users` | ไม่มีอะไรให้กรอง |

## สถาปัตยกรรมที่เสนอ

### 1) Data model (Firestore `nonprd` — DB_BACKEND=firestore ที่ deploy จริง)

- **ใหม่ `users/{email}`** — doc ID = email ตัวพิมพ์เล็ก (= primary key ตามโจทย์), **ไม่มี `expireAt`** (ถาวร):
  ```
  { email, passHash, passSalt, role: 'admin'|'player', displayName, createdAt:Ts, disabled:false }
  ```
  password → **scrypt** (per-user random salt, timingSafeEqual) — ไม่เก็บ plaintext เด็ดขาด
- **`sessions/{id}` เพิ่ม `ownerEmail`** (stamp จาก cookie ฝั่ง server — ไม่รับจาก client) · shots ไม่ต้องแก้ (เข้าถึงผ่าน session อยู่แล้ว → เช็คเจ้าของที่ session)
- **`leaderboard_records` เพิ่ม `ownerEmail`** (ใช้ลบ/กรองในอนาคต) — ตัวบอร์ดยังแสดงชื่อ+คะแนนรวมทุกคน *(ดู "ข้อตัดสินใจ" ข้อ 1)*

### 2) Auth ใหม่ (`server/authGate.mjs` เขียนทับ)

- Cookie ต่อคน (stateless, รอดข้าม Cloud Run instance เหมือนเดิม):
  `payload = email|role|exp` + `HMAC-SHA256(AUTH_SECRET, payload)` → httpOnly, SameSite=Lax, Secure, อายุ 90 วันเท่าเดิม
- env ใหม่: **`AUTH_SECRET`** (บังคับตั้งบน Cloud Run; dev ไม่ตั้ง = คีย์ dev คงที่ + เตือนใน log)
- **Bootstrap admin กันล็อกตัวเองออก:** env `ADMIN_EMAIL` + `ADMIN_PASS` → upsert user role=admin ตอน boot (ครั้งเดียวต่อ boot, idempotent) — admin คนแรกไม่ต้องพึ่ง UI
- `POST /api/login` → `{ email, password }` · `GET /api/gate` → `{ ok, email, role }` (frontend ใช้ตัดสิน UI)
- `GATE_USER`/`GATE_PASS` เกษียณ (ลบออกจาก service หลัง migrate)
- WS `/api/live` ใช้ cookie เดียวกัน (โครง `isGateAuthorized` เดิม แค่เปลี่ยน verifier)

### 3) Authorization ต่อ route (`server/routes.mjs` + middleware ใหม่)

| Route | player | admin |
|---|---|---|
| `POST /api/sessions` | สร้างได้ — server stamp `ownerEmail` จาก cookie | เหมือนกัน |
| `GET /api/history` | **กรอง `ownerEmail == ตัวเอง`** | เห็นทุกคน + `?email=` filter ได้ |
| `GET /api/sessions/:id` + clips/audio | เฉพาะของตัวเอง (404 ถ้าไม่ใช่ — ไม่ leak ว่ามีอยู่) | ทุก session |
| `PATCH /api/sessions/:id` (จบเซสชัน/แก้) | เฉพาะของตัวเอง | ทุก session (= "edit ข้อมูล session ได้") |
| `DELETE /api/sessions/:id` | เฉพาะของตัวเอง | ทุก session |
| `GET/POST/DELETE/PATCH /api/users*` | 403 | จัดการ player (เพิ่ม/ลบ/reset password/disable) |

- Firestore query เพิ่ม `where('ownerEmail','==',…)` บน `sessions` (COLLECTION scope — **auto-index ได้ ไม่ต้องสร้าง index มือ** ต่างจากบทเรียน `shots.id`; ถ้า listHistory ใช้ orderBy(startedAt)+where อาจต้อง composite index — จุดเสี่ยงเดียวที่ต้องเทสจริงก่อน deploy)
- ข้อมูลเก่าที่ไม่มี `ownerEmail` → เห็นเฉพาะ admin (TTL 3 วันเคลียร์ตัวเองอยู่แล้ว — ไม่ทำ backfill)

### 4) Frontend

- **`LoginGate.tsx`** → ฟอร์ม email + password · เก็บ `{ email, role }` จาก `/api/gate` ลง store (state ใหม่ `auth`)
- **ใหม่ `AdminScreen.tsx`** (แท็บโผล่เฉพาะ role=admin):
  - ตาราง player: email · displayName · สถานะ · ปุ่มลบ/disable/reset password
  - ฟอร์มเพิ่ม player: email + password (+displayName)
  - มุมมองข้อมูล: history รวมทุกคน (กรองรายคนได้) → เข้า detail เดิม + ปุ่มแก้/ลบ session
- **HistoryScreen** ไม่ต้องแก้ logic — server กรองให้เอง
- `settings.userName` **คงไว้เป็น display name** (โค้ชเรียกชื่อ / export card) — default = displayName ของ user ที่ login; ไม่ใช่ identity อีกต่อไป

### 5) Postgres path (`server/db.mjs`)

Interface `backend.*` ต้องมี method users/owner ครบเพื่อไม่ให้ boot พัง แต่ SIT deploy จริงเป็น Firestore → ทำ **โครง SQL แบบเรียบง่าย** (ตาราง `users` + คอลัมน์ `owner_email` ผ่าน `ALTER TABLE IF NOT EXISTS` ตามแบบ `audio_path`) ให้เทสผ่าน — ความเนี้ยบระดับ prod ไปเก็บตอน merge ขึ้น `main` *(ข้อตัดสินใจ 2)*

## แผนลงมือ (Fable-led workflow ตามธรรมเนียม repo — 3 เฟส)

| เฟส | งาน | ไฟล์หลัก | ประมาณ |
|---|---|---|---|
| **A. Contracts + Server** (Opus) | users store + scrypt + cookie ใหม่ + bootstrap admin + ownership middleware + `/api/users*` + กรอง history + เทส | `authGate.mjs` (rewrite), `routes.mjs`, `dbFirestore.mjs`, `db.mjs`, `lib.mjs`, `types.ts` | งานก้อนใหญ่สุด |
| **B. Frontend** (Opus/Sonnet, ขนานกับ A หลัง contract นิ่ง) | LoginGate email/password + store.auth + AdminScreen + แท็บ admin + i18n TH/EN | `LoginGate.tsx`, `AdminScreen.tsx` (ใหม่), `store.ts`, `i18n.ts`, `App` routing | กลาง |
| **C. Integrate + E2E + Deploy** (Fable review) | เทสสด: admin เพิ่ม player → player login เห็นเฉพาะของตัวเอง → admin ลบ/แก้ session → player โดน 404 ข้าม account · deploy `app:sit-v8` + env `AUTH_SECRET`/`ADMIN_EMAIL`/`ADMIN_PASS`, ถอด `GATE_USER/PASS` | Dockerfile/env เท่านั้น | เล็ก |

**Definition of done:** typecheck+test+build เขียว · E2E ครบ 4 เคสข้างบนบน service จริง · secret audit clean · อัพเดท tasks/HANDOFF/CLAUDE.md + push (กฎเหล็ก)

## ⚠️ ข้อตัดสินใจที่ต้องการคำตอบ user (มี default แล้ว)

1. **Leaderboard/เว็บ Ranking:** โดยธรรมชาติโชว์ชื่อ+คะแนนของทุกคน — ขัดกับ "ไม่เห็นข้อมูลกันและกัน" ไหม? **เสนอ: คงไว้** (เป็น aggregate เพื่อการแข่งขัน ไม่ใช่ข้อมูลส่วนตัว เช่น คลิป/มุมข้อต่อ) — ถ้าจะซ่อนต้องแก้ repo ranking ด้วย
2. **Postgres path:** ทำโครงให้เทสผ่านพอ (เสนอ) หรือทำเต็มระดับ prod เลย?
3. **Player แก้ password ตัวเองได้ไหม?** โจทย์ให้ admin ตั้งให้ — **เสนอ: v1.5 admin reset ให้อย่างเดียว** (หน้า self-service ไว้ทีหลัง)

## ความเสี่ยง

- **Login ค้าง 90 วันของเครื่องเดิม:** cookie เก่า (HMAC creds ร่วม) จะ verify ไม่ผ่านหลัง deploy → โดนเด้งไปหน้า login ใหม่ทุกเครื่อง — ตั้งใจ แจ้งผู้ใช้ล่วงหน้า
- **Composite index บน Firestore** ถ้า `where(ownerEmail)+orderBy(startedAt)` — ต้องเทสบน `nonprd` ก่อน deploy จริง (บทเรียน `shots.id` เคย 503 เงียบ)
- **อย่าลืม WS upgrade path** — เคยเป็นช่องที่ guard หลุดง่ายสุด (v1.1 อุดไว้แล้ว แค่เปลี่ยน verifier ให้ครบทั้งสองจุด)
- Brute-force login → ใส่ rate-limit ง่าย ๆ ต่อ IP+email (in-memory, 10 ครั้ง/นาที) พอสำหรับ SIT

# HANDOFF — Login / access gate สำหรับ ADGE Tennis

> สถานะ: **ทำแล้ว (2026-07-10)** — ผู้ใช้เปลี่ยนใจสั่งลุยวันเดียวกัน: รหัสกลาง `admin`/`adge` (override ได้ทาง env `GATE_USER`/`GATE_PASS`) ตามแนวทางข้อ 1 ด้านล่าง — `server/authGate.mjs` (POST /api/login → HMAC httpOnly cookie 90 วัน, guard ทุก /api/* + WS /api/live) + `src/components/LoginGate.tsx` (probe /api/gate, fail-open เมื่อไม่มี backend สำหรับ dev) ครอบ App ทั้งแอป เอกสารเดิมคงไว้เป็นบริบท/ทางอัพเกรด (ต่อคน PIN / Google Sign-In)
> ที่มา: `/api/token` เป็น public endpoint บน Cloud Run แบบ allow-unauthenticated — ใครที่รู้ URL ก็ mint ephemeral token ไปคุยกับ Gemini ด้วยโควตา/เงินของเราได้ (token TTL 30 นาที, 10 uses ต่อ token, ขอใหม่ได้เรื่อยๆ) นี่คือช่องโหว่หลักที่ login ต้องปิด

## เป้าหมาย

กัน endpoint ที่มีต้นทุน (`/api/token` เป็นหลัก, รองลงมา `/api/sessions|shots|clips|audio` กันคนเขียน/อ่าน DB มั่ว) ให้เฉพาะคนในคลับ โดย**ไม่เพิ่มขั้นตอนบนคอร์ทเกิน 1 ครั้งต่อเครื่อง**

## แนวทางที่คุยกันไว้ (ตัวเลือก ณ 2026-07-10 — ผู้ใช้ยังไม่เลือก)

1. **รหัสผ่านกลาง (แนะนำตอนที่เสนอ):** รหัสเดียวทั้งคลับ กรอกครั้งเดียว → server ตรวจ → set **httpOnly signed cookie** (เช่น HMAC ด้วย secret ใหม่ `APP_GATE_SECRET` ใน Secret Manager) → middleware เช็ค cookie ก่อนทุก `/api/*` (ยกเว้น `/healthz`) → frontend เจอ 401 = โชว์หน้ากรอกรหัส
2. **ชื่อ + PIN ต่อคน:** ผูกกับ userName ที่ใช้ใน leaderboard อยู่แล้ว — กันสวมชื่อกันได้ แต่ต้องมีที่เก็บ user (Firestore collection ใหม่) + จัดการลืม PIN
3. **Google Sign-In:** มาตรฐานสุด แต่เพิ่ม friction บนมือถือ + ต้องตั้ง OAuth client ใน GCP

## ข้อควรระวังตอน implement

- รหัส/secret เก็บใน **Secret Manager** เท่านั้น (สร้าง secret ใหม่ mount เป็น env) — ห้าม hardcode/ห้ามลง VITE_*
- Static assets (หน้าเว็บเอง) เปิด public ได้ — เกตเฉพาะ `/api/*` ก็พอ ป้องกันของแพงครบแล้ว
- WS relay `/api/live` (ถ้าเปิดใช้ transport=relay) ต้องเกตด้วย — เช็ค cookie ตอน upgrade handshake ใน `server/liveRelay.mjs` (มี Origin check อยู่แล้ว แต่ Origin ปลอมได้จากนอก browser)
- Cookie: `Secure; HttpOnly; SameSite=Lax; Max-Age` ยาวๆ (เช่น 90 วัน) จะได้กรอกครั้งเดียวต่อเครื่อง
- ทำบน SIT ก่อน แล้ว port ไป main (ห้ามพา brand string ข้าม branch ตาม CLAUDE.md)
- อัพเดท `handoff-camera-fix.md` แบบแผนนี้: เขียน Definition of done + secret audit ก่อน push

## ระหว่างที่ยังไม่มี login (ความเสี่ยงที่ยอมรับไว้)

- URL ของ `at-ton-nonprd` ยังไม่ได้แปะสาธารณะที่ไหน = security by obscurity ชั่วคราว
- เพดานความเสียหายจำกัดด้วย token TTL 30 นาที + โควตา API key ฝั่ง Google (ตั้ง quota cap ใน AI Studio ได้ถ้าอยากลดเพดานเงิน)
- ถ้าเจอ traffic แปลกใน Cloud Run logs: rotate secret `gemini-api-key` (เพิ่ม version ใหม่ ไม่ต้อง redeploy) แล้วรีบทำ login ข้อ 1

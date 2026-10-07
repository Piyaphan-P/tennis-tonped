# Plan — LINE profile capture (QR/manual) + external history API

Branch `SIT` · ADGE Tennis (non-prod) · target: **SIT v2.1**

## เป้าหมาย (จาก user)
1. **เก็บ LINE profile** ในแอป coaching: `lineUserId`, `displayName`, `pictureUrl`, `email` — ปุ่ม **สแกน QR** (payload = JSON) + **tab กรอกเอง (manual)**
2. **External API** ดึงประวัติการตี + stats + ลิงก์วิดีโอ (แบบเดียวกับหน้า history) query ด้วย `lineUserId` หรือ `email` + ต้องใส่ **API auth key** ถึงจะยิงได้

QR JSON format (คีย์ casing ไม่สม่ำเสมอ — parser ต้อง tolerant):
```json
{ "LineuserId": "U4af4980629...", "displayName": "Ton",
  "pictureUrl": "https://profile.line-scdn.net/...", "email": "Hello@gmail.com" }
```

## PO decisions (ยืนยันแล้ว)
- **A1** LINE profile อยู่หน้า **Home ก่อนเริ่ม session** (per-player picker) — ไม่แตะ login/account
- **A2** API key = **1 ตัว shared ผ่าน env** (`HISTORY_API_KEY`), header `x-api-key`, constant-time
- **A3** ลิงก์วิดีโอ = **proxy URL ที่ต้องใช้ API key** (`/api/ext/clips/:id`) — ไม่หลุด raw GCS path
- **A4** ช่วงเวลา = **เท่าที่มีจริง** — session/vdo TTL 3 วัน + leaderboard/usage stats ถาวร (ไม่แตะ TTL)

## ⚠️ Identity model (advisor จับ — critical)
- คลับ **แชร์ login เดียว** → `ownerEmail` = บัญชีคลับ **เหมือนกันทุกผู้เล่น ไม่ใช่ตัวผู้เล่น** (นี่คือเหตุผลที่ v1.9 แยกประวัติด้วย free-text `userName`)
- LINE `email` จาก QR = **email ส่วนตัวของผู้เล่น** คนละอันกับ `ownerEmail`
- → เพิ่ม field **ใหม่** `lineUserId` + `lineEmail` (lowercased) ห้าม reuse `ownerEmail` เด็ดขาด
- → ตอน capture ตั้ง `userName = displayName` ด้วย เพื่อให้ประวัติ per-player บนเครื่อง (v1.9) ทำงานต่อ
- **ไม่มี backfill:** API เห็นเฉพาะ session ที่ tag *หลัง* capture profile — สำหรับ lineUserId หนึ่ง API จะว่างจนกว่าจะเล่น session แรกหลังผูก profile (บอก consumer ชัด ๆ)

## Stats ที่ persist จริง (advisor จับ — อย่าสัญญาเกิน)
- radar/มุม/score/peakWristSpeed → **มีใน shot doc** ✅ derivable
- `speedKmh` → **ถูก drop บน wire** (history UI ใช้ same-session localMatch) ✗ ไม่ persist
- spin%/kcal/avgSpeedKmh → อยู่ใน client `StoredSession` เท่านั้น; server มีแค่ `summary` obj (เท่าที่ client ส่งตอน end)
- **การตัดสิน:** API คืน **raw sessions + shots + summary(ตามที่มี)** ให้ consumer derive เอง = "ข้อมูลชุดเดียวกับหน้า history" จริง ๆ — **ไม่ port `derive.ts` ไป server** (กันโค้ด 2 ก๊อป divergent)

---

## API contract (ล็อกก่อนสร้าง — ทั้ง 2 ฟีเจอร์ + consumer แขวนกับอันนี้)

ทุก route ใต้ `/api/ext/*` ต้องมี header `x-api-key: <HISTORY_API_KEY>` (constant-time; ผิด/ขาด → 401)

### `GET /api/ext/history?lineUserId=U...`  (หรือ `?email=hello@gmail.com`)
ประวัติ live (≤3 วัน) sessions + shots ของผู้เล่นนั้น:
```json
{
  "query": { "lineUserId": "U4af...", "email": null },
  "count": 2,
  "sessions": [{
    "id": "...", "userName": "Ton", "lineUserId": "U4af...", "lineEmail": "hello@gmail.com",
    "startedAt": "...", "endedAt": "...", "avgScore": 71.2, "shotCount": 12, "summary": {},
    "shots": [{
      "id": "...", "idx": 0, "type": "forehand", "score": 78,
      "angles": {}, "statuses": {}, "issues": [], "peakWristSpeed": 1.6,
      "hasClip": true,  "clipUrl":  "/api/ext/clips/<id>",  "clipMime": "video/mp4",
      "hasAudio": true, "audioUrl": "/api/ext/audio/<id>", "audioMime": "audio/wav",
      "createdAt": "..."
    }]
  }]
}
```

### `GET /api/ext/stats?lineUserId=|email=`
Aggregate **ถาวร** (รอดเกิน 3 วัน) จาก leaderboard_records + usage_records:
```json
{
  "query": {...},
  "leaderboard": [{ "sessionId","userName","lineUserId","lineEmail","avgScore","maxScore","shotCount","playedAt" }],
  "totals": { "sessions": 8, "shots": 96, "avgScore": 69.4, "maxScore": 100, "bestSession": {...} }
}
```
(usage/THB = ข้อมูล cost ภายใน — **ไม่ใส่** ใน ext API by default; คุยเพิ่มถ้าต้องการ)

### `GET /api/ext/clips/:shotId` · `GET /api/ext/audio/:shotId`
stream (Range/206) reuse `streamClip`/`streamAudio`; x-api-key = full read (ไม่ per-user ownership เพราะ key คือ boundary)

---

## งานที่จะทำ

### Part A — LINE profile capture (frontend + session stamp)
1. **`src/types.ts`** — `LineProfile { lineUserId; displayName; pictureUrl; email }` (fields optional-safe); เพิ่ม `lineProfile?: LineProfile` ใน `Settings`; เพิ่ม `lineUserId?`/`lineEmail?` ใน `CloudSessionSummary`
2. **`src/line/parseQr.ts`** (ใหม่, pure, exported, **มี test**) — `parseLineQr(raw: string): LineProfile | null`: JSON.parse + normalize คีย์ case-insensitive (`LineuserId`/`lineUserId`/`lineuserid` → `lineUserId`), **lowercase email**, กัน payload พัง/ไม่ใช่ JSON → null
3. **`src/store.ts`** — LS `tp.lineProfile` (JSON), `setLineProfile(p)` setter (persist; เมื่อ set → seed `userName = displayName` แบบเดียวกับ `setAuth`); `clearLineProfile`
4. **`src/components/LineProfileSheet.tsx`** (ใหม่) — 2 tab: **สแกน QR** (getUserMedia + `jsQR` decode loop บน canvas → parse → preview การ์ด → ยืนยัน) | **กรอกเอง** (4 ช่อง). ปิด sheet → `track.stop()` ทุก track (กัน Live แย่งกล้อง). แสดง pictureUrl thumbnail ถ้ามี
5. **`src/screens/HomeScreen.tsx`** — การ์ด "ผู้เล่น (LINE)" แสดง displayName+รูปปัจจุบัน + ปุ่มเปิด `LineProfileSheet`; ถ้ายังไม่ผูก แสดง CTA
6. **`package.json`** — เพิ่ม dep `jsqr` (pure JS, iOS-safe; BarcodeDetector ไม่ชัวร์บน iOS Safari = กลุ่มเป้าหมายหลัก)
7. **`src/data/api.ts`** — `createSession` body เพิ่ม `lineUserId`, `lineEmail` (ส่งครั้งเดียวตอนสร้าง; end/leaderboard/usage ให้ server copy จาก session doc)
8. **`src/i18n.ts`** — คีย์ `line.*` (title/scan/manual/fields/hint/preview/confirm)

### Part B — session/leaderboard/usage stamp (backend persist)
9. **`server/dbFirestore.mjs`** — `createSession` เก็บ `lineUserId ?? null`, `lineEmail ?? null`; `leaderboard`/`usage` upsert **copy `lineUserId`/`lineEmail` จาก session doc** (ไม่เชื่อ client ซ้ำ); `listHistory` เพิ่ม filter `{ lineUserId }` = **equality-where + in-memory cutoff/sort** (ห้าม `orderBy` — บทเรียน composite-index/503)
10. **`server/routes.mjs`** — `POST /api/sessions` อ่าน `lineUserId`/`lineEmail` จาก body (lowercased email); end route ส่งค่าให้ upsert
11. **`server/lib.mjs`** — `sessionDocToJson` เพิ่ม `lineUserId`/`lineEmail`; helper `pickLineIdentity`

### Part C — external history API (new auth path)
12. **`server/extApi.mjs`** (ใหม่) — router + `requireApiKey` middleware (`x-api-key` vs `HISTORY_API_KEY`, `timingSafeEqual`, length-guard); routes: `/history`, `/stats`, `/clips/:id`, `/audio/:id` (reuse `streamClip`/`streamAudio`, `sessionDocToJson`/`shotDocToJson`)
13. **`server/store.mjs`** — interface เพิ่ม `listHistoryByLine`, `getStatsByIdentity` (leaderboard+usage query by lineUserId/lineEmail, equality-where)
14. **`server/dbFirestore.mjs`** — impl `getStatsByIdentity`; pg path = stub 503 (เหมือน user methods)
15. **`server/authGate.mjs`** — cookie guard **skip prefix `/ext`** (req.path เริ่ม `/ext` → OPEN) เพื่อให้ x-api-key เป็น auth เดียวใต้ ext; ยืนยัน **เฉพาะ `/ext`** ที่ bypass
16. **`server/index.mjs`** — mount ext router; อ่าน `HISTORY_API_KEY` (missing = ext routes ตอบ 503 bilingual แบบ token path)

### Part D — tests + docs + deploy
17. **tests** — `parseLineQr` (คีย์ casing/lowercase email/JSON พัง), `requireApiKey` (constant-time accept/reject/missing), `listHistoryByLine`/`getStatsByIdentity` filter, store `setLineProfile` (persist + seed userName + ไม่กวน voice/mode/verbosity), lib `sessionDocToJson` มี line fields
18. keep gate เขียว: `typecheck && test && build` + **secret audit** (`AQ.`/`AIza`/`.json`)
19. **Secret Manager** — `HISTORY_API_KEY` เป็น secret (แบบ `gemini-api-key`), wire ตอน deploy `--update-secrets`
20. docs: `tasks20260728.md`, `HANDOFF.md`, `CLAUDE.md` session log, dashboard artifact; commit+push

## Reuse (ไม่รื้อของเดิม)
`timingSafeEqual` · `streamClip`/`streamAudio` (Range/206) · `sessionDocToJson`/`shotDocToJson` · listHistory equality-where pattern · shareStory/store LS pattern · v1.6 pre-session card pattern

## ความเสี่ยง / ต้องระวัง
- QR บน iOS Safari: getUserMedia ต้อง user-gesture + https (Cloud Run = https ✓); jsQR decode ใน rAF loop, downscale canvas กัน jank
- กล้อง: `track.stop()` ตอนปิด sheet + ก่อนเข้า Live — กันแย่ง device
- `/ext` bypass: ต้องยืนยัน **เฉพาะ** prefix นี้ที่ข้าม cookie (test coverage)
- ไม่มี backfill (บอก consumer): lineUserId ใหม่ = API ว่างจนเล่น session แรกหลังผูก
- API key ห้ามหลุด git; provision ผ่าน Secret Manager

# HANDOFF — Camera quality fix + in-Live camera flip

> สถานะ: **ยังไม่ได้ทำ** — เอกสารนี้คือแผนพร้อมลงมือ อ่านจบแล้วทำได้เลย
> ที่มา (2026-07-10): ผู้ใช้ทดสอบบน iPhone Pro Max รุ่นล่าสุด พบว่า pose quality จากกล้องหน้า **แย่กว่า** webcam ของ MacBook Pro M1 ทั้งที่ฮาร์ดแวร์กล้อง iPhone ดีกว่ามาก

## Root cause (วินิจฉัยแล้ว ยืนยันจากโค้ด)

`src/screens/LiveScreen.tsx:159` ขอกล้องแบบไม่ระบุ resolution/framerate เลย:

```ts
stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: cameraFacing },
  audio: false,
});
```

- **iOS Safari** เมื่อไม่ใส่ constraint จะให้ default ต่ำ (มักเป็น **640×480**) ส่วน Chrome บน Mac ให้ 720p+ → Mac เลยดูดีกว่าทั้งที่กล้องแย่กว่า
- ซ้ำเติมด้วย **FOV กล้องหน้า iPhone แคบกว่า** webcam MacBook → ยืนระยะเดียวกัน ตัวคนเล็กกว่าในเฟรม ซึ่งสำหรับ MediaPipe "คนกินพื้นที่เฟรมเท่าไหร่" สำคัญกว่าความละเอียดกล้อง (โมเดลย่อภาพเหลือ ~256px ก่อน infer)
- สเปคขั้นต่ำที่ pose ต้องการจริง: **720p @ 30fps ก็เกินพอ** ถ้าตัวผู้เล่นสูง ~60–80% ของเฟรม — ปัญหาคือเราไม่ได้ใช้ศักยภาพกล้อง ไม่ใช่กล้องไม่ถึงขั้นต่ำ

## งานที่ 1 — Resolution/framerate constraints

แก้ `LiveScreen.tsx:159` เป็น:

```ts
stream = await navigator.mediaDevices.getUserMedia({
  video: {
    facingMode: cameraFacing,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  },
  audio: false,
});
```

- ใช้ `ideal` เท่านั้น **ห้ามใช้ `exact`** — `exact` ทำให้ getUserMedia reject บนเครื่องที่ไม่รองรับ แล้วผู้ใช้จะเจอ camera-error overlay ทั้งที่กล้องใช้ได้
- อย่าลืมว่า downstream อ่าน `video.videoWidth` หลัง resolve อยู่แล้ว (`SwingRecorder` constructor, `LiveScreen.tsx:172`) — ไม่มี hardcoded 640/480 ที่ต้องตามแก้ แต่ **ตรวจอีกรอบ** ด้วย grep `videoWidth|640|480` ก่อน commit

### ความเสี่ยงที่ต้องเฝ้า (สำคัญ)

1. **fps ตกเพราะเฟรมใหญ่ขึ้น** — pose inference + `swingRecorder` composite canvas (~480px) ทำงานต่อ tick หนักขึ้น ถ้า fps บนเครื่องจริงตกต่ำกว่าเดิมมาก ให้ถอยเป็น `ideal: 960`
2. **SHOT_THRESHOLDS เคย tune ที่ ~15fps** (v0.3: contact gate 1.1, EMA-smoothed wrist speed) — wrist speed คำนวณเป็น units/s จึง *ควร* ทน fps เปลี่ยน แต่ EMA smoothing ขึ้นกับจำนวน sample ถ้า fps ขยับจาก ~15 → ~30 ค่า peak ที่วัดได้อาจสูงขึ้น → **ใช้ DetectionHud (phase trail + wrist-speed vs gate bar) ตรวจบนคอร์ทว่า swing จริงยัง trigger และ idle ยังไม่ false-positive**
3. แนะนำเพิ่ม **fps counter ใน DetectionHud** (ค่า measured เฟรม/วินาทีของ pose loop) — เป็นเครื่องมือ tune ตัวเดียวที่บอกได้ว่า regression มาจากกล้องหรือ inference

## งานที่ 2 — ปุ่มสลับกล้องหน้า/หลังบนหน้า Live

**ครึ่งหนึ่งมีอยู่แล้ว** — อย่าเขียนซ้ำ:

- Setting มีแล้ว: `settings.cameraFacing: 'user' | 'environment'` (`types.ts:501`, default `'user'` ที่ `store.ts:285`)
- UI มีแล้วใน `SettingsSheet.tsx:128-135` (segmented control) แต่ฝังลึก ต้องเปิด sheet
- `LiveScreen` re-open กล้องอัตโนมัติเมื่อค่าเปลี่ยนอยู่แล้ว (effect dep `[cameraFacing, retryKey]` ที่ `LiveScreen.tsx:213`) และ cleanup ปล่อย track เดิมถูกต้องแล้ว
- Mirroring จัดการแล้ว: `mirrored = cameraFacing === 'user'` (`LiveScreen.tsx:63`) — display-only, shot classifier ใช้ raw video coords (mirror-invariant, ดูคอมเมนต์ `shotDetector.ts:229`) → **สลับกล้องไม่กระทบ classifier**

**สิ่งที่ต้องทำจริง:** ปุ่ม flip 🔄 ลอยบนหน้า Live (มุมที่ไม่ชน DetectionHud / CostFab / MicControl) ที่ toggle `updateSettings({ cameraFacing: … })` — แค่นั้น effect เดิมจัดการที่เหลือทั้งหมด

- ใช้ i18n ทั้ง label/aria (TH primary): เช่น `สลับกล้อง` / `Flip camera`
- Disable ปุ่มชั่วคราวระหว่างกล้องกำลัง re-open (กันกดรัว → getUserMedia ซ้อน) — ดู pattern `cancelled` flag ในตัว effect เดิม
- **ระวังบน iPad/desktop ที่ไม่มีกล้องหลัง:** `facingMode: 'environment'` แบบไม่ exact จะ fallback เป็นกล้องที่มี → ไม่ crash แต่ mirror จะผิด (ภาพจากกล้องหน้าแต่ไม่ mirror) — ยอมรับได้เป็น known-minor หรือเช็ค `stream.getVideoTracks()[0].getSettings().facingMode` แล้ว sync กลับเข้า store ถ้าจะทำให้ถูกจริง

## Definition of done

1. `npm run typecheck && npm run test && npm run build` เขียวทั้งสาม
2. บน iPhone จริง: `stream.getVideoTracks()[0].getSettings()` รายงาน ≥1280×720 (log ชั่วคราวหรือดูผ่าน HUD)
3. skeleton overlay บน iPhone นิ่งขึ้นเทียบก่อนแก้ (เกณฑ์จากผู้ใช้: ต้องไม่แพ้ MacBook M1 อีก)
4. ปุ่ม flip สลับได้ไปกลับหลายรอบโดย pose loop ไม่ค้าง / ไม่มี track leak (เช็คไฟกล้องดับเมื่อออกจาก Live)
5. บนคอร์ท: swing จริงยัง trigger capture, idle ไม่ false-positive (DetectionHud)
6. Secret audit ก่อน push ตามกติกา repo

## ไฟล์ที่แตะ

| ไฟล์ | งาน |
|---|---|
| `src/screens/LiveScreen.tsx` | constraints (บรรทัด ~159) + ปุ่ม flip + disable ระหว่าง re-open |
| `src/components/DetectionHud.tsx` | (แนะนำ) fps counter |
| `src/i18n.ts` | key ปุ่มสลับกล้อง TH/EN |
| `src/store.ts` / `types.ts` | ไม่ต้องแก้ (setting มีแล้ว) |

## บริบทเพิ่มเติม

- Branch นี้คือ `SIT` (ADGE Tennis) — งานนี้เป็น bug fix ที่ **ควร port ไป `main` (prod)** ด้วย เพราะ LiveScreen เหมือนกันทั้งสอง branch; ห้ามพา brand string ข้าม branch ตาม CLAUDE.md
- คำแนะนำการใช้งานให้ผู้ใช้ (ไม่ใช่โค้ด): ตอนซ้อมจริงใช้ **กล้องหลัง** ดีกว่า — เลนส์ดีกว่า, low-light ดีกว่า, FOV เลือกได้ (ปุ่ม flip ที่เพิ่มนี่แหละทำให้ทำได้สะดวก)

# ADGE Tennis — UI Design Brief for Google Stitch

> Paste any screen section below into **Google Stitch** (stitch.withgoogle.com) to
> generate matching mobile UI. This describes the ACTUAL app (dark "court-night"
> theme, exact tokens pulled from `src/theme.css`). Real Thai UI labels are kept in
> parentheses next to the English so Stitch names things correctly. **Design for
> mobile portrait first** (a phone propped up courtside). TH is the primary
> language; EN is a toggle.

---

## 1. Product one-liner + brand

**ADGE Tennis** is a mobile-first web app that coaches tennis in realtime. The
player props their phone in portrait, points the camera at themselves, and the app
draws a live pose skeleton with joint angles over the video, scores every swing
0–100, and a spoken AI coach — **โค้ช ADGE (Coach ADGE)** — says the one thing to fix
after each shot. Sessions track minutes, shots, swing speed (km/h), calories, and
spin. Players share 9:16 highlight cards and appear on a club leaderboard.

- **Brand name:** ADGE Tennis (always this exact spelling)
- **Coach persona:** โค้ช ADGE / Coach ADGE (a friendly, punchy, encouraging courtside coach)
- **Language:** Thai primary, English switchable via a small toggle (ไทย / อังกฤษ)
- **Platform:** mobile web, portrait, phone-sized (content max-width ~520px, centered on desktop)
- **Mood:** premium sports broadcast — think an ATP TV graphics package at night, dark and confident, optic-yellow tennis-ball accent.

---

## 2. Visual language (exact tokens)

### Color palette (dark theme only — there is no light mode)

| Role | Hex | Use |
|---|---|---|
| Background (`--bg`) | `#0a1113` | app background, near-black teal |
| Surface (`--surface`) | `#0e181a` | cards, sheets, nav bar |
| Surface-2 (`--surface-2`) | `#12211f` | raised/inner surfaces, coach bubble |
| Hairline (`--line`) | `rgba(255,255,255,0.12)` | 1px card + divider borders |
| Strong line (`--line-strong`) | `rgba(255,255,255,0.22)` | emphasized borders |
| **Accent (`--accent`)** | `#d6f441` | **optic tennis-ball yellow** — primary buttons, active states, brand dot, score highlights |
| Accent ink (`--accent-ink`) | `#0a1113` | dark text ON the yellow accent |
| Court blue (`--court-blue`) | `#4fc0e6` | hardcourt blue — coach bubble border, coach name, "speaking" waveform |
| Good (`--good`) | `#39d08a` | green — good form, high score |
| Warn (`--warn`) | `#f1a24a` | amber — needs attention, mid score |
| Fault (`--fault`) | `#ff6a4d` | red — faults, low score, danger buttons |
| Text (`--text`) | `#f2f6f4` | primary text, near-white |
| Text dim (`--text-dim`) | `#9fb0ad` | secondary/muted text |
| Text faint (`--text-faint`) | `#63736f` | tertiary labels, indices |

### Typography

- **Display font** (headings, buttons, brand, coach text): system sans stack — `-apple-system, 'Segoe UI', system-ui, 'Noto Sans Thai'`. Headings are **weight 800**, letter-spacing `-0.02em`, tight line-height 1.1.
- **Body:** same system sans, weight 400, 16px base, line-height 1.45.
- **Mono / numbers:** `ui-monospace, 'SF Mono', 'JetBrains Mono', 'Roboto Mono'` with **tabular numerals** — used for ALL numbers (scores, km/h, THB, fps, telemetry). Numbers always feel like a scoreboard.
- Heading sizes: h1 = 2rem, h2 = 1.4rem, h3 = 1.1rem. Big score numerals = 2.4–3rem; hero export score = 150px.

### Spacing / radius / elevation

- Spacing scale: 4, 8, 12, 16, 24, 32, 48 px.
- Radii: small `8px`, default `14px`, large `22px`, pill `999px`.
- Cards: surface fill, 1px hairline border, 14px radius, 16px padding, soft shadow `0 1px 2px rgba(0,0,0,.4)`.
- Overlays/sheets: bigger shadow `0 8px 28px rgba(0,0,0,.5)`, translucent panels use **backdrop blur 6–12px** over `rgba(10,17,19,0.66–0.92)`.
- Respect safe-area insets (notch + home bar).

### Iconography & motion

- Minimal line/emoji icons in the bottom nav (home, history, summary, plan, settings, admin). Tennis-ball motif = the yellow **brand dot** (14px glowing circle, `box-shadow 0 0 12px accent`).
- Motion is subtle and sporty: buttons scale to 0.98 on press; the coach "speaking" state shows a 3-bar blue waveform animation; capture flashes glow green then fade (~1.6s); a soft pulse on "thinking".

---

## 3. Global patterns

- **Bottom tab nav** (fixed, translucent blurred bar, hairline top border, max-width 520px centered): tabs = **หน้าหลัก (Home) · ประวัติ (History) · สรุป (Summary) · พัฒนา (Plan) · ตั้งค่า (Settings)**, plus **ผู้ดูแล (Admin)** only for admin rooms. Active tab is optic-yellow; inactive is dim; icon above a 0.7rem label.
- **Bottom sheets** slide up from the bottom, rounded top corners (22px), surface fill, up to 85vh, scrollable — used for Settings and the LINE player picker.
- **Cards** are the core building block (see tokens). Group related controls in a card with an h3 title.
- **Segmented controls** = pill-shaped track (dark) with pill segments; the active segment is filled optic-yellow with dark text. Used for the pre-session pickers and tabs.
- **Chips / pills** = small rounded outlined tags; on video they get a translucent blurred dark background. Used for angle readouts, phase, fps, connection status.
- **Buttons:** primary = solid optic-yellow with dark text, pill-shaped, min 48px tall; ghost = transparent outlined; danger = red outline. Full-width for main actions.
- **Semantic score/form color meaning (memorize — used everywhere: skeleton, chips, scores, radar):**
  - **grey** = neutral / just tracking movement
  - **green (`#39d08a`)** = good form (joint angle in target) / score ≥ 80
  - **amber (`#f1a24a`)** = needs improvement / score 60–79
  - **red (`#ff6a4d`)** = fault / score < 60
- **Numbers are mono + tabular** everywhere. **≈ (approx.)** prefixes estimated values (speed, calories, per-shot cost).

---

## 4. Screen-by-screen specs

### 4.1 Login — Room login (เข้าสู่ระบบ)

**Purpose:** the club logs into a shared "room" (room1..room4); an admin room unlocks the Admin tab. This replaces the old email login.

**Layout (top → bottom), single centered card on the dark background:**
1. Brand lockup: glowing yellow brand dot + "ADGE Tennis" wordmark, centered.
2. Title "เข้าสู่ระบบ (Sign in)" + subtitle "เลือกห้องและกรอกรหัสผ่านเพื่อเริ่มใช้งาน (Choose your room and enter the password)".
3. **Room field (roomUser):** a labeled input or a segmented/dropdown selector of rooms — room1 / room2 / room3 / room4 / admin. Label "ห้อง (Room)".
4. **Room password field (roomPassword):** password input, label "รหัสผ่าน (Password)".
5. Primary full-width button "เข้าสู่ระบบ (Sign in)"; shows "กำลังตรวจสอบ… (Checking…)" while validating.
6. Inline error line in red for wrong credentials ("ห้องหรือรหัสผ่านไม่ถูกต้อง / Wrong room or password") or rate-limit.
7. Small language toggle (ไทย / อังกฤษ) top-right.

**Stitch prompt:** _A dark premium sports login screen for a tennis coaching app "ADGE Tennis". Near-black teal background (#0a1113). A single centered rounded card (#0e181a, 1px subtle white border) holds a glowing optic-yellow dot with the "ADGE Tennis" wordmark on top, a title, a room selector labeled "Room" (room1–room4, admin), a password input, and a full-width pill button in optic yellow (#d6f441) with dark text reading "Sign in". Mono tabular numerals, minimal, confident. Include a small Thai/English toggle top-right._

---

### 4.2 Home (หน้าหลัก) — player identity + pre-session setup

**Purpose:** identify who is playing (LINE profile) and pick session preferences, then start.

**Layout (top → bottom):**
1. **Header row:** brand dot + "ADGE Tennis" title, language toggle on the right.
2. Tagline "โค้ชเทนนิสส่วนตัว วิเคราะห์ฟอร์มเรียลไทม์ข้างคอร์ต (Your personal courtside coach — realtime form analysis)".
3. **CURRENT PLAYER card (LINE identity) — prominent, near the top.** When a player is bound it shows a circular **LINE avatar** (pictureUrl) + **displayName** big, with a small "กำลังเล่นเซสชันนี้ (playing this session)" caption and a "เปลี่ยน (Change)" link. When NOT bound it's a call-to-action card: an outlined avatar placeholder + "ระบุตัวผู้เล่นด้วย LINE (Identify player via LINE)" and a button that opens the LINE picker sheet (see §5).
4. **Racket Hand card (มือที่ถือแร็กเกต):** h3 title + two big toggle buttons "ถนัดขวา 🎾 (Right-handed)" / "ถนัดซ้าย 🎾 (Left-handed)"; the selected one is filled yellow. Small explainer "การแยกโฟร์แฮนด์/แบ็คแฮนด์ใช้มือที่เลือกนี้".
5. **Focus Shot (ลูกที่จะฝึก):** segmented control — โฟร์แฮนด์ (Forehand) / แบ็คแฮนด์ (Backhand) / ทั้งสอง (Both).
6. **Coach Voice (เสียงโค้ช):** segmented/2×2 cards — หญิงอ่อนโยน (Gentle female) / หญิงเข้ม (Firm female) / ชายเข้ม (Firm male) / ชายเป็นกันเอง (Friendly male).
7. **Coach Style (สไตล์โค้ช):** cards — ให้กำลังใจ (Encouraging) / ดุ hardcore (Hardcore) / สุภาพ·เทคนิค (Polite/technical) / เพื่อนซี้·ฮึกเหิม (Buddy/hype).
8. **Coach Length (ความยาวคำโค้ช):** segmented — สั้น (Short) / กลาง (Medium) / ยาว (Long) + hint line.
9. **START button** — big full-width optic-yellow pill "เริ่มฝึกซ้อม (Start Session)", with sub-caption "วางโทรศัพท์แนวตั้ง หันกล้องมาที่ตัวคุณ (Prop your phone in portrait, camera facing you)". Disabled until a player is identified.
10. **Your Stats card (สถิติของคุณ)** — small stat tiles: Sessions, Total Shots, Avg Score, Good Form %, Best Speed — filtered to the current player.
11. **History list (ประวัติ)** preview: recent sessions with per-player breakdown and a sparkline. _(For admin rooms, this area is replaced by a "Daily overview / สถิติรวมรายวัน" widget: per-day cards with distinct player counts, sessions, shots, and hour bars.)_

**Stitch prompt:** _A dark mobile Home screen for "ADGE Tennis". Top: brand + tagline. A prominent "current player" card showing a round LINE profile avatar and display name ("playing this session") with a Change link. Below, stacked setting cards each titled: Racket Hand (two big toggle buttons Right/Left), Focus Shot (segmented Forehand/Backhand/Both), Coach Voice (4 option cards), Coach Style (4 option cards), Coach Length (segmented Short/Medium/Long). A large optic-yellow pill "Start Session" button. Then a Your Stats tile row and a recent History list with tiny sparklines. Dark #0a1113, cards #0e181a, yellow #d6f441 for selected/primary, mono tabular numbers._

---

### 4.3 Live (กำลังฝึกซ้อม) — camera + pose + coach

**Purpose:** the working screen. Full-bleed camera fills the phone; everything else floats as translucent overlays. The coach message is the hero in the lower third.

**Layout (full-screen, 100dvh, video behind everything):**
- **Background:** live camera video, cover-filling, portrait 9:16.
- **Pose skeleton overlay (PoseCanvas):** a colored stick-figure skeleton drawn over the player — joints/limbs colored by the semantic palette (**grey** tracking, **green** good angle, **amber/red** off-target). Small angle-degree labels near key joints (elbow, shoulder, knee).
- **Top-left brand banner:** translucent blurred pill with brand dot + "ADGE Tennis" + a connection chip ("เชื่อมต่อแล้ว / Connected", or an amber "โค้ชออฟไลน์ / Coach offline" chip).
- **Detection HUD (compact diagnostic strip, top area):** a translucent chip row showing (a) a **phase trail** — small segments พร้อม→เตรียม→ง้าง→สวิง→กระทบ→ส่ง (Idle→Prep→Back→Fwd→Hit→Follow) that light up yellow as the swing progresses and flash green on a hit, (b) live **speed** value + a tiny bar filling toward the contact gate (amber→green when it crosses), (c) a **shots counter**, (d) an fps chip, (e) a last-event line.
- **Top-right:** a small round ฿ cost button (admin/testing), and a camera-flip button 🔄 (สลับกล้อง / Flip camera).
- **Right edge rail:** a vertical stack of small **swing capture thumbnails** (newest on top, 3:4 crop, phase tag + shot number) that never cover the player; tap opens a lightbox.
- **Score pill:** a compact pill showing the latest shot score (ช็อตล่าสุด / Last shot), colored by the semantic palette; "รอช็อตแรก… (Awaiting first shot…)" before the first.
- **THE HERO — Coach bubble (lower third, `coach-hero`):** a large translucent card with a **court-blue** border and gradient dark fill; header "โค้ช ADGE" in court blue + a 3-bar **speaking waveform** when talking; big bold coach message text (up to 4 lines, display font 1.35rem). States: "โค้ชกำลังคิด… (thinking)", "โค้ชกำลังพูด (speaking)", "โค้ชหลุด กำลังเชื่อมต่อใหม่… (reconnecting)".
- **Bottom controls:** a red-outlined "จบการฝึก (End Session)" button.

**Stitch prompt:** _A full-screen dark mobile "live coaching" screen over a portrait phone camera feed of a tennis player. A colored pose stick-figure skeleton is drawn over the player with small joint-angle degree labels; limbs are green when correct, amber/red when off, grey when neutral. Floating translucent blurred overlays: top-left a brand pill "ADGE Tennis" + a green "Connected" chip; a compact diagnostic HUD strip with a 6-step swing-phase trail (segments lighting yellow/green), a live speed value with a mini progress bar, a shots counter and fps; top-right a small round ฿ button and a camera-flip icon; a right-edge vertical stack of small swing thumbnail cards; a score pill. The hero element in the lower third is a large translucent card with a court-blue (#4fc0e6) border reading "Coach ADGE" with an animated 3-bar audio waveform and a big bold coaching sentence. A red-outline "End Session" button at the bottom. Colors: bg #0a1113, accent yellow #d6f441, good #39d08a, warn #f1a24a, fault #ff6a4d._

---

### 4.4 Summary (สรุปการฝึก)

**Purpose:** post-session recap with stats, swing captures, and a share card.

**Layout (top → bottom):**
1. Title "สรุปการฝึก (Session Summary)".
2. **Session Overview widget (ภาพรวมการฝึก)** — the headline stat block: tiles for **นาทีที่ตี (Minutes played)**, **ตีโดนลูก (Balls hit / shots)**, **ความเร็วสวิงเฉลี่ย ≈ (Avg swing speed, km/h)**, **เผาผลาญ ≈ (Burned kcal)**, plus a **Spin breakdown** — topspin / backspin / flat percentages (small caption "ประมาณจากวิถีวงสวิง / estimated from swing path"). A second toggle shows cumulative all-time (รวมทุกครั้ง).
3. **Average score + score trend** — a big mono score number colored by palette + a small sparkline (แนวโน้มคะแนน / Score Trend).
4. **Swing captures gallery** — horizontal swipe strip of large capture cards: each shows the skeleton-on-frame image (or a video clip with a "วิดีโอ / Video" badge), a phase tag, angle chips, and the coach's critique text; tap → full lightbox.
5. **Things to Improve (สิ่งที่ควรปรับปรุง)** — a short list of recurring issues, or a green "ฟอร์มโดยรวมดีมาก (Great overall form)" note.
6. **Shots list (รายการช็อต)** — rows: shot index, colored score, 2-line coach note.
7. Actions: **Share stats card** button (แชร์สรุป), "ดูแผนพัฒนา (View Dev Plan)", "กลับหน้าหลัก (Back to Home)".

**Stitch prompt:** _A dark mobile session-summary screen for a tennis app. Top card "Session Overview": a grid of stat tiles — Minutes played, Balls hit, Avg swing speed (≈ km/h), Burned (≈ kcal) — plus a spin breakdown bar (topspin/backspin/flat %). Below, a big colored average-score number with a sparkline trend. Then a horizontally swipeable strip of large swing-capture cards, each showing a photo of a player with a colored pose skeleton overlay, a phase tag, small angle chips, and a coach critique line. A "Things to Improve" list, a shots list with colored scores, and a full-width "Share" button. Dark #0a1113, mono tabular numbers, yellow/green/amber/red semantic colors._

---

### 4.5 History (ประวัติการฝึก)

**Purpose:** per-player training history over the last 3 days (auto-expires), with charts and video clips.

**Layout (top → bottom):**
1. Title "ประวัติการฝึก (Training History)" + player name header "ประวัติของ {name}". Note "ประวัติเก็บไว้ 3 วัน แล้วลบอัตโนมัติ (kept 3 days)".
2. **Overall summary card** — sessions, total shots, avg score, top faults.
3. **Radar chart (มุมข้อต่อเทียบเป้าหมาย / Joints vs target)** — a hand-drawn SVG radar comparing the player's joint angles against target, filled with a translucent accent.
4. **Bar / trend charts** — per-session avg score bars; per-shot improvement lines colored by the palette.
5. **Session list** — each session row: date/time, player name, shot count, avg score chip; tapping opens session detail with per-shot scores and **video clips** (tap → lightbox with a "ดูซ้ำ / Replay" button).
6. Per-session: **Export swing as 9:16 video** button (บันทึกวิดีโอ / แชร์) and **Delete session** (red, confirm "ลบเซสชันนี้และคลิปทั้งหมด?").
7. Offline note when cloud is unreachable ("โหมดออฟไลน์ — แสดงสถิติที่บันทึกในเครื่องเท่านั้น").

**Stitch prompt:** _A dark mobile training-history screen. A summary card with sessions/shots/avg-score. A radar/spider chart comparing joint angles to a target (translucent yellow fill on a dark grid). Bar charts of per-session average scores and a per-shot trend line in green/amber/red. A list of session rows (date, player name, shots, colored avg-score chip) that expand into per-shot scores with small video-clip thumbnails and a Replay button. Export-video and red Delete buttons per session. #0a1113 background, mono tabular numbers._

---

### 4.6 Admin (ผู้ดูแล) — rooms/players + costs

**Purpose:** admin-room-only management, split into two tabs.

**Layout:**
- **Header:** "จัดการผู้เล่น (Manage players)" + "เข้าสู่ระบบเป็น (Signed in as) <room>" + Log out (ออกจากระบบ).
- **Tabs (segmented):** **ผู้เล่น (Players)** | **ค่าใช้จ่าย (Costs)**.
- **Players tab:** an "Add" card (room/player + password + optional display name → เพิ่มผู้เล่น), and a list of players/rooms with role badge (แอดมิน / admin), disabled badge, created date, and row actions: ระงับ/เปิดใช้งาน (Disable/Enable), รีเซ็ตรหัสผ่าน (Reset password), ลบ (Delete). The current admin's own row is protected.
- **Costs tab:** total Gemini spend (≈ THB), a per-user table (email/name, THB ≈, tokens in/out, sessions, sorted by spend desc), plus a static **infra estimate card** (Cloud Run ≈ ฿0–20/mo, Artifact Registry ≈ ฿5/mo, GCS+Firestore free-tier ≈ ฿0, note "ประมาณการคงที่ ไม่ใช่บิลจริง").

**Stitch prompt:** _A dark mobile admin screen with a segmented tab control "Players | Costs". Players tab: an add-player card (inputs + a yellow Add button) and a list of player rows with role/disabled badges and per-row Disable / Reset-password / Delete actions. Costs tab: a big total spend number (≈ THB), a per-user cost table with tokens in/out and session counts, and a small "infra estimate" card. Dark #0a1113, mono tabular numbers, yellow accents, red for destructive actions._

---

## 5. The LINE player-identification flow (bottom sheet)

Triggered from the Home "current player" card. A bottom sheet with **two tabs**.

### Tab A — สแกน QR (Scan QR)
- A **live camera viewfinder** fills most of the sheet, with a bright **square scanning frame** (rounded corners, animated corner brackets or a sweeping scan line in optic-yellow) centered over it, and a caption "เล็ง QR โปรไฟล์ LINE ให้อยู่ในกรอบ (Point the LINE profile QR into the frame)".
- On a successful read (a LINE profile JSON: `lineUserId, displayName, pictureUrl, email`) it transitions to a **confirm card**: the player's round **LINE avatar** (pictureUrl), their **displayName** big, and email/id small below, with a green check, then two buttons — "ยืนยัน (Confirm)" (primary yellow) and "สแกนใหม่ (Rescan)".
- Error/empty states: "ไม่พบ QR (No QR found)", camera-denied fallback with a retry.

### Tab B — กรอกเอง (Manual)
- Four text fields stacked: **displayName (ชื่อที่แสดง)**, **lineUserId**, **pictureUrl**, **email** — with a primary "ยืนยัน (Confirm)" button. Optional avatar preview if a pictureUrl is entered.

### Bound state
- After Confirm, the sheet closes and the Home "current player" card shows the **LINE avatar + displayName** prominently as "who is playing this session", enabling the Start button.

**Stitch prompt:** _A dark mobile bottom sheet titled "Who's playing?" with two tabs "Scan QR | Manual". Scan QR tab: a live camera viewfinder with a centered rounded square scanning frame with glowing optic-yellow corner brackets and a scan line, caption "Point the LINE profile QR into the frame". A success state shows a confirm card: a large round profile avatar, a big display name, small email/id, a green checkmark, and Confirm / Rescan buttons. Manual tab: four stacked labeled text inputs (Display name, LINE user id, Picture URL, Email) with an avatar preview and a yellow Confirm button. Sheet slides up from the bottom, rounded top corners, #0e181a surface, #d6f441 accent._

---

## 6. Share / story cards (9:16 export)

A **1080×1920 portrait card** rendered for sharing to IG/TikTok/Facebook stories. Look:
- Dark gradient background (court-night, `#0a1113` → slightly lighter), full bleed.
- **Header:** flush-left brand — glowing yellow dot + "ADGE Tennis" (44px), and the player name (52px) below.
- **Hero frame:** the swing capture (player + colored pose skeleton) in a rounded framed box mid-card.
- **Big score:** the shot score as a huge 150px mono numeral, **colored by the semantic palette** (green ≥80 / amber 60–79 / red <60), with a small "คะแนน / SCORE" label and shot label ("#N · โฟร์แฮนด์").
- **FIX THIS / REMEMBER blocks:** the one coaching fix + a short memorable cue, court-blue accents.
- **Footer:** small brand/date line, dim.
- There are also stats-overview and per-swing-video variants (same layout language), the video one loops the swing clip with the coach voice mixed in.

**Stitch prompt:** _A 9:16 portrait shareable story card for "ADGE Tennis" on a dark court-night gradient. Top-left: a glowing optic-yellow dot + "ADGE Tennis" wordmark and the player's name below. Center: a framed action photo of a tennis player with a colored pose-skeleton overlay. Below it a huge mono score number (green/amber/red by value) with a small "SCORE" label and a "#3 · Forehand" tag. Then a court-blue "FIX THIS" line and a "REMEMBER" cue line. A small dim brand/date footer. Bold, premium ATP-broadcast look, optic yellow #d6f441 and court blue #4fc0e6 accents._

---

## Appendix — quick reference for Stitch

- **Always dark.** bg `#0a1113`, surface `#0e181a`, cards with 1px `rgba(255,255,255,0.12)` borders, 14px radius.
- **Primary accent** optic-yellow `#d6f441` (dark text on it). **Court blue** `#4fc0e6` for the coach. Semantic **green/amber/red** = `#39d08a` / `#f1a24a` / `#ff6a4d`.
- **All numbers** in a mono tabular font — scoreboard feel.
- **Mobile portrait**, max content width ~520px, big touch targets (≥48px), translucent blurred overlays on the camera screen, bottom tab nav, bottom sheets.
- **Bilingual**, Thai primary — keep a small ไทย/อังกฤษ toggle.

---

## Recent UI additions (v2.2–v2.3, 2026-07-28)

- **Live screen — controls pinned to the TOP:** the "End session" (จบ session, danger/red) and the "flip camera" 🔄 (สลับกล้อง) buttons now sit as a top control row (flip left, End right), NOT at the bottom — on a phone the growing swing-capture gallery used to cover bottom controls. Keep them reachable above the banner.
- **Settings — "ความไวจับช็อต / Capture sensitivity ×":** a numeric field (0.3–2.0, default 1.0) next to the km/h calibration field; hint "ลดลง = จับช็อตง่ายขึ้น". Tunes how easily the coach captures a swing.
- **History detail — "โค้ชแนะนำ / Coach said" cue block:** per shot, above the derived improvement bullets, a highlighted card (left accent-yellow border, faint yellow tint, small uppercase label) showing the coach's ACTUAL spoken cue text for that shot — so the advice persists past the session. Only shown when a cue was captured.
- **Auto-save (no visible UI):** sessions now appear in History/ranking even without tapping End — behavioural, no new screen.

## Recent UI additions (v2.4, 2026-07-28)

- **DevPlan "แชร์สรุปวันนี้" now shares the PLAN, not a swing photo (bugfix):** the share card (1080×1920) is the development plan itself — brand header + player name/date, then up to 3 ranked coaching areas, each with its title, "อาการ" (what's happening, red tag), "วิธีซ้อม" (how to practise, green tag) and a quoted "cue" in accent yellow. A clean session (no faults) renders a positive "ฟอร์มวันนี้" card instead of a blank. It NO LONGER shows the player's swing frame/clip. (The per-miss-clip "แชร์เป็นสตอรี่" buttons still share the individual swing clip — that is correct.) Two-step Save/Share like the stats card.
- **History detail — "แนวทางพัฒนา / How to Improve" block:** below the end-of-session summary card, the same structured guidance the live DevPlan screen shows — up to 3 ranked areas, each a card with rank dot + title + "พบใน N ช็อต", an อาการ row (red), a วิธีซ้อม row (green), and a quoted cue. Hidden when the session has no ranked faults. So the plan is now visible in past sessions, not only right after playing.

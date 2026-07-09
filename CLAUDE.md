# CLAUDE.md — ADGE Tennis (SIT)

Guidance for Claude Code working in this repo. These instructions override default behavior.

> **This is the `SIT` branch = non-production ("ADGE Tennis").** The `main` branch is production (**ต้นและเพชร Tennis Club** / Ton & Phet). See the "SIT environment" section below for what differs.

## Project

**ADGE Tennis** — a mobile-first web app that coaches tennis in realtime. Open the phone camera → local MediaPipe pose overlay (skeleton + joint angles) → per-shot score → a spoken **Gemini Live** coach that says the one thing to fix after each swing → per-session cost tracking in **THB**. Language TH/EN switchable (TH primary). Phase 1 = playing against a ball machine (no machine connectivity this phase).

Brand name (this branch) is **"ADGE Tennis"** and the coach persona is **"โค้ช ADGE" (Coach ADGE)**. All user-visible copy, HTML title/meta, canvas-rendered brand text, and download filenames use ADGE. Never write "ต้นเป็ด" / "TonPed".

## SIT environment

- **Branch/purpose:** `SIT` = non-production. `main` = production (**ต้นและเพชร Tennis Club**, coach "โค้ชต้นและเพชร"). Do not merge brand strings across branches.
- **Brand:** UI, `<title>`/meta, story/swing export canvases, and download filenames (`adge-*`) all read **ADGE Tennis**. Coach persona = **โค้ช ADGE**.
- **DB isolation (shared Supabase Postgres):** env **`DB_SCHEMA=sit`**. `server/db.mjs` sanitizes the value (`/^[a-z_][a-z0-9_]*$/`, else `public`), and when it is non-default pins `SET search_path TO <schema>` on every pooled connection (Supabase pooler :5432 is SESSION mode) and runs `CREATE SCHEMA IF NOT EXISTS <schema>` before the `CREATE TABLE`s. All SQL stays unqualified — the search_path does the isolation. `DB_SCHEMA=public` (default) is byte-identical to prod (no hook, no CREATE SCHEMA).
- **Cloud Run service (SIT):** `adge-tennis-sit` · clips/audio bucket `adge-tennis-sit-clips` (set via `GCS_BUCKET`). Image path / Artifact Registry (`ton-team/ton-phet/...`) and the git remote are shared infra — unchanged.
- **Deploy env vars (SIT):** `GCS_BUCKET=adge-tennis-sit-clips`, `DATABASE_URL=<shared>`, `DB_SCHEMA=sit`.

## Stack

Vite + React 18 + TypeScript · Zustand (`src/store.ts`) · plain CSS design tokens (`src/theme.css`, no Tailwind) · `@mediapipe/tasks-vision` PoseLandmarker · `@google/genai` v2 (Gemini Live, native audio) · Node/Express token-minting backend (`server/index.mjs`).

## Commands

| Command | What |
|---|---|
| `npm run dev` | dev server → http://localhost:5173 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | vitest (cost / angle / capture math) |
| `npm run build` | typecheck + production build → `dist/` |

**Always keep all three green** (`typecheck && test && build`) before committing or deploying.

## Architecture

Hybrid coaching, on purpose: pose detection, angle math, shot segmentation, and scoring run **entirely in the browser** (free, instant, private). Gemini is called **only per completed shot** (angles + score + one contact JPEG) plus on-demand voice Q&A — never continuous video streaming. This is cheaper and coaches better.

```
src/
  pose/        poseLandmarker · angles                     (MediaPipe + joint angles)
  analysis/    shotDetector · scoring · captureRenderer    (shot FSM + score + skeleton-on-frame render)
  coach/       liveClient · audioPlayer · mic              (Gemini Live + audio in/out)
  cost/        pricing · costMonitor (+tests)              (THB math from real usageMetadata)
  components/  PoseCanvas · CoachBubble · CaptureGallery · CaptureLightbox · MicControl · CostFab · StatsCard · HistoryList …
  screens/     Home · Live · Summary · DevPlan
  store.ts · types.ts · i18n.ts · theme.css
server/        index.mjs · package.json                     (mints ephemeral tokens + serves dist/)
Dockerfile                                                  (Cloud Run single container)
```

### Key runtime facts (hard-won — don't relearn)
- **Model:** `gemini-2.5-flash-native-audio-preview-09-2025` on `httpOptions.apiVersion='v1beta'`. Native-audio only: request `responseModalities:[AUDIO]` + `outputAudioTranscription:{}` to also get text back. (v1alpha is used only by the backend token minter.)
- **Gemini Live send pattern:** assign the session from the awaited `connect()` promise (in `.then()`), **never send inside `onopen`** — the session isn't ready there.
- **Auth:** the browser only ever gets an **ephemeral token** (`AQ.…`, ~30 min TTL). The long-lived `AIza…` key lives **only** server-side. In prod, `VITE_TOKEN_ENDPOINT=/api/token` mints fresh tokens on every (re)connect.
- **Mic:** always-on (no push-to-talk). Continuous PCM16k with echoCancellation + noiseSuppression; server-side VAD does turn-taking; barge-in via `serverContent.interrupted` + local RMS duck. `MicControl` is a default-ON toggle with a live level meter.
- **Turn attribution:** `liveClient.finalizeTurn()` attaches coaching to `pendingShotId`. Interrupted/mixed turns clear `turnText` and set `turnInterrupted` so a barge-in or interleaved voice turn never pins a stale critique onto a captured frame.
- **Swing capture:** `shotDetector` captures keyframes (backswing/contact/follow-through). `getJpeg()` can bail on transient pose/video hiccups, so a `finalize()` fallback synthesizes the contact `SwingCapture` from held contact landmarks/angles. Captures render with the colored skeleton via `captureRenderer` in `CaptureGallery` / `CaptureLightbox` / `SummaryScreen`.
- **Skeleton colors:** grey = normal movement · green = good form (angle in target) · amber/red = needs improvement.
- **Cost:** `costMonitor` reads real `usageMetadata` per message; `THB = tokens × (USD_per_1M × VITE_USD_TO_THB) / 1e6`, split by modality. Per-session total is reliable; per-shot is approximate (labeled ≈).

## Deploy (Cloud Run)

Single container (Node serves `dist/` + `/api/token`). SA can't use Cloud Build/serviceusage, so build the image **locally** and push, then deploy `--image`:

```bash
# colima must be running (local docker daemon)
docker buildx build --platform linux/amd64 \
  -t asia-southeast1-docker.pkg.dev/ton-team/ton-phet/app:v1 --push .

gcloud run deploy ton-phet-tennis \
  --image asia-southeast1-docker.pkg.dev/ton-team/ton-phet/app:v1 \
  --region asia-southeast1 --allow-unauthenticated
```

- Project `ton-team`, region `asia-southeast1`. SA `ton-team-f53923136f53.json` can deploy + set public IAM + push AR, but **cannot** list services / read IAM.
- **Live coaching needs** `GEMINI_API_KEY` (AIza…) as a secret: `gcloud run services update ton-phet-tennis --region asia-southeast1 --update-secrets GEMINI_API_KEY=gemini-api-key:latest`. Without it, `/api/token` returns a graceful bilingual 503 and everything except live voice still works.

## Security — non-negotiable

- **Never** let any key/token reach git. `.env.local`, `*-service-account*.json`, `ton-team-*.json`, `.claude/`, `.playwright-mcp/`, screenshots are gitignored.
- **Never** put `AIza…` in frontend / `VITE_*` — it gets bundled into the browser. Backend only.
- **Audit before every push:** grep the diff for `AQ.`, `AIza`, `.json` keys. Agents have hardcoded tokens in demo files before — deleted before push. Rotate any token that was ever shared.

## Workflow conventions

Refinements run as Fable-led multi-agent workflows: **Fable = Product Owner** (plans, diagnoses, reviews, signs off); Opus/Sonnet implement disjoint file sets (contracts-first, no parallel-write conflicts). Extend working modules, don't rewrite. Push to GitHub (https://github.com/Piyaphan-P/tennis-tonped) after each completed piece of work, with the secret audit clean.

## Git

Commit/push only when asked. Co-author trailer:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## Session log (what was actually done — read HANDOFF.md for what's next)

- **Phase 1 shipped (2026-07-04, commit `d931446`):** full app (pose overlay, per-shot scoring, Gemini Live coach, THB cost monitor, stats/history-3-days, TH/EN) + Cloud Run deploy + GitHub push. Fable verdict: ship. Caught & removed hardcoded tokens in demo files before push.
- **v3 shipped (2026-07-04, commit `4551689`):** always-on mic replacing push-to-talk (MicControl toggle + level meter, barge-in, iOS suspended-AudioContext fail-loud) + swing-capture hardening (finalize() fallback synthesis, CaptureLightbox, skeleton overlay in Summary) + major turn-attribution fix (`turnInterrupted` in liveClient). 36/36 tests. Redeployed revision `00003`.
- **On-court test feedback (2026-07-04):** (1) no swing captures on real swings → real local bug, SHOT_THRESHOLDS tuned on synthetic data never trigger; (2) no coach audio + (3) no realtime coaching → both blocked on missing `GEMINI_API_KEY` (`/api/token` 503, verified). **Status + resume instructions live in `HANDOFF.md` — always read it at session start and keep it updated.**
- **v0.3 shipped (2026-07-04, Fable verdict: ship, 39/39 tests):** workflow `tonped-capture-fix` fixed on-court capture. Root cause: contact gate 2.0 units/s ≈ 2× real EMA-smoothed phone-swing peaks (~0.8–1.6 at 15fps) — thresholds retuned (contact 2.0→1.1, +forwardBypass for camera-axis swings, idle-jitter tests prove no false positives); capture retried every tick + finalize synthesis from held peak data (guaranteed ≥1); new DetectionHud (phase trail, live wrist-speed vs gate bar, shot/discard counters with measured peak — the on-court tuning instrument), gallery empty-state. Deployed revision `00004` (image `:v3`), git tag `v0.3`. User's fresh AQ. token verified working against Gemini Live (spoken reply received). Still pending: permanent `AIza…` key → Secret Manager.
- **v0.3.1–v0.4 shipped (2026-07-05, tag `v0.4`, revision `00007`):** coach wording humanized (plain cue first, degrees as footnote) · half-duplex audio (mic chunks dropped while coach speaks — RMS duck removed, court noise was cutting advice mid-sentence) · gallery reverted to bottom strip (right rail unreadable) · **per-swing VIDEO clips** replace stills as primary display: `swingRecorder.ts` composites video+skeleton onto ~480px canvas per pose tick, one MediaRecorder per swing (mp4 iOS / webm Android, no-op → stills fallback), session-only URLs, max 20. 47/47 tests.
- **v0.5 shipped (2026-07-05, Fable verdict: ship-with-fixes → all fixed, 98/98 tests, revision `00008`, image `:v5`, tag `v0.5`):** workflow `tonped-cloud-compare-history` (7 agents: Fable plan → contracts → Opus backend + Opus history + Sonnet compare in parallel → integration → Fable review). **Cloud persistence:** clips → GCS `ton-phet-clips` (bucket-level 3-day lifecycle auto-delete; server never deletes objects), metadata → **Supabase Postgres** via `DATABASE_URL` (⚠️ direct `db.*.supabase.co` is IPv6-only — must use the IPv4 pooler `aws-0-ap-northeast-1.pooler.supabase.com:5432`, password URL-encoded). New: `server/db.mjs` (pg Pool, auto-migrate, 3-day purge on boot + 6h) · `server/gcs.mjs` (ADC, proxy-streaming with **HTTP Range/206** for iOS Safari, 60s time-boxed offline latch) · `server/routes.mjs` (sessions/shots/clips/history CRUD, bilingual 503 when env missing) · `src/data/api.ts` + `cloudSync.ts` (fire-and-forget upload, never blocks pose loop, 60s offline latch → localStorage fallback) · **CompareScreen** (user clip side-by-side vs YouTube/any-URL reference, per-shot-type defaults verified live via oEmbed, prefs in localStorage) · **HistoryScreen** (hand-rolled SVG radar + bar charts from `src/history/derive.ts`, session detail, per-shot improvement lines, overall summary, delete). Deploy needs env vars `GCS_BUCKET` + `DATABASE_URL` (Secret Manager unavailable — SA lacks perms; passed via `--update-env-vars` with `^|^` delimiter). Prod E2E verified: session→shot→clip upload→GCS object→Range 206 stream→history→delete, all against the live service. Pending: permanent `AIza…` GEMINI_API_KEY (user), rotate Supabase DB password + old AQ. tokens (shared in chat).
- **v0.6 shipped (2026-07-07, Fable verdict: ship, 111/111 tests, revision `00009`, image `:v6`, tag `v0.6`):** workflow `tonped-v06-clip-coach`. **Voice input cut entirely** (user request): mic never started, no audio sent to Gemini, no mic permission ever prompted (verified via `navigator.permissions.query` = "prompt" after full sessions); `mic.ts`/`MicControl.tsx` kept on disk as dead files for a future restore; `setMicEnabled` dead-gated; `micOn` defaults false. Coach **audio output unchanged**. **Coach reads the whole swing**: `dispatchShot` sends ALL captured keyframes in canonical phase order (backswing→forward→contact→follow-through, `orderedCaptures()`) with a text block whose "Frame N = phase" lines match the sent images one-to-one (per-phase angles + off-target joint flags); COACH_SYSTEM_PROMPT rewritten to strict coach shape: short specific praise → THE one fix tied to its phase → short memorable cue, spoken TH, degrees as footnote only. Critique still pins to the contact capture (`pendingContactCaptureId`), turn attribution intact. +13 liveClient tests. Watch on court: per-shot THB cost (multiple JPEGs/swing now) + coach latency.
- **v0.7 shipped (2026-07-07, Fable verdict: ship, 122/122 tests, revision `00010`, image `:v7`, tag `v0.7`):** workflow `tonped-v07-paced-coach`. (1) **Coach names the shot**: every critique opens "ช็อตที่ N โฟร์แฮนด์/แบ็คแฮนด์" (`shotOpener()` + i18n keys, enforced in COACH_SYSTEM_PROMPT step 1 + exact opener string per turn). (2) **Speak-to-completion pacing**: a new shot dispatches only when no turn is in flight AND `audioPlayer.isSpeaking()` is false; `audioPlayer.onPlaybackDone` (fires only on natural drain, never on stop/barge-in) re-drives `flushQueue()`; 1-slot latest-wins queue (`enqueueLatest`, newer swing replaces older — shots themselves still all scored/recorded). Post-review hardening: `lastDispatchedIndex` stale-guard (error-path requeue can't replay out of order; equal index allowed = legit retry) + audioPlayer **wedge watchdog** (scheduled-end+5s; force-releases the gate if iOS suspends the AudioContext mid-burst so coaching never freezes silently).
- **v0.8 shipped (2026-07-07, Fable verdict: ship-with-fixes → major fixed, 148/148 tests, revision `00011`, image `:v8`, tag `v0.8`):** workflow `tonped-v08-devplan-share` — DevPlan upgrade. (1) **Miss clips**: "จุดที่พลาด" section shows the 3 lowest-scoring shots WITH their video clips (tap→lightbox), worst joint issue in plain Thai + which phase. (2) **Structured guidance** per coaching area (5 areas mapped from scoring.ts issues): อาการ→เพราะอะไร→วิธีซ้อม→cue, bilingual i18n. (3) **9:16 story share** (`src/share/storyRenderer.ts`): 1080×1920 canvas card (brand header, skeleton hero frame, semantic-colored score, FIX THIS/REMEMBER blocks, footer) as PNG or ≤8s video (canvas.captureStream+MediaRecorder, swingRecorder mime chain); `shareStory` → navigator.canShare/share files (opens IG/FB/TikTok sheet) → anchor-download fallback + **10s share-hang watchdog** (headless/webviews where share() never settles). Fixed post-review major: cue block now FIXED-ANCHORED above footer (1716/1772) + fix text clamped with ellipsis — long EN fix copy can no longer silently drop the cue. Known trade-off (minor): video-path share may lose user activation after >5s render → degrades to download+toast; validate on device, consider two-step render-then-share UX if it annoys.
- **v0.9 shipped (2026-07-07, Fable verdict: ship, 173/173 tests, revision `00012`, image `:v9`, tag `v0.9`):** workflow `tonped-v09-handed-paced-varied`. (1) **Forehand/backhand bug fixed** — old classifier read `sign(domShoulder.x − hipCenterX)` which flips when the torso rotates at contact; new `classifyShotType` anchors on the shoulder-pair baseline `sign(domShoulder.x − nonDomShoulder.x)` vs dominant-wrist offset — **mirror-invariant by construction** (raw video coords; PoseCanvas mirroring is display-only); guards: low visibility / side-on stance (`typeShoulderMinSpanX 0.04`, gated before division) / near-center hysteresis (`typeMidlineMarginFrac 0.12`) → `unknown`, never a wrong guess. HomeScreen got a prominent ถนัดขวา/ซ้าย card + explainer bound to `settings.dominantHand`. (2) **Capture pacing** — `cooldownMs` 800→2500 (blocks re-arm from idle only; speed gates untouched), once-per-window `'cooldown'` discard reason on the HUD; `followThroughReached` flag → only FULL swings (contact + follow-through + valid duration) ever reach `onShotCompleted`/Gemini/cloud. (3) **Coach variety** — `selectCoachingStyle(score,index)`: 4 bands (hype ≥85 NO-fix pure อวย · praise-refine 70-84 · technical 55-69 · encourage <55) × 2 tonal variants = 8 voices, no consecutive repeat per index, directive injected per-turn after the v0.7 shot-name opener; COACH_SYSTEM_PROMPT gained style palette + "VARIETY — NON-NEGOTIABLE" (rotate openers, never reuse previous sentence pattern). Known minor: queue-dropped shots can make two HEARD critiques share a style (prompt variety mandate mitigates; stateful lastStyleId in v1.0). On-court watch: 2.5s cooldown vs real ball-machine feed rate — tune down if real swings get eaten.
- **v1.0 shipped (2026-07-08, Fable verdict: ship-with-fixes → all fixed, 220/220 tests, tag `v1.0`, image `:v10`):** workflow `tonped-v10-audio-export-variety` (3 parallel implementers → integrator → Fable review). (1) **Coach-audio persistence, zero extra tokens:** `src/coach/coachAudioTap.ts` taps the PCM chunks already streaming through handleMessage (only while a shot's turn is pending — stray turns can't pollute the next shot's recording), encodes WAV 24kHz/16-bit/mono (header unit-tested) → GCS `audio/<sess>/<shot>.wav` via `POST /api/shots/:id/audio` + Range/206 `GET /api/audio/:shotId`; interrupted turns discard; `getCoachAudioBlob()` serves same-session exports without the network; `shots.audio_path/audio_mime` via ALTER TABLE IF NOT EXISTS. (2) **History per-swing EXPORT VIDEO** (`src/share/swingExportRenderer.ts` + `SwingExportButton`): 1080×1920 canvas — brand header + player name, "#N · แบ็คแฮนด์" + big score, live-drawn clip, canvas radar, fix bullets — coach voice mixed in via AudioContext→MediaStreamDestination (clip loops when voice is longer, 20s cap); two-step activation-safe UX (render → "พร้อมแล้ว" → Save/Share on a fresh gesture, reuses shareStory watchdog). Post-review fixes: **MediaRecorder audio-track fallback chain** (mp4;codecs+mp4a.40.2 → picked → bare → strip-audio; iOS can throw NotSupportedError precisely on voiced exports), start(1000) timeslice + 8s stop-race, 8s video-ready timeout (LTE), audio-presence in the render-cache deps (no stale silent export). (3) **Coach variety v2:** 14 voices (hype 3 / praise-refine 4 incl a PRAISE-ONLY no-fix variant / technical 3 / encourage 4 with explicit "ไม่เป็นไร ลองใหม่อีกที"), stateful 3-window no-repeat committed at **heard-time** (finalizeTurn) so failed sends never evict actually-spoken styles. (4) **Player name** in History detail header (`history.byPlayer`). (5) **Durable leaderboard:** session-end PATCH upserts `leaderboard_records` (session_id PK; user_name/avg_score/max_score/shot_count/played_at) — NEVER purged (the 3-day purge deletes sessions/shots only); the separate ranking site reads only this table. On-court watch: voiced export on a real iPhone; Android loop-freeze on last frame; leaderboard row appears right after session end.
- **Ranking site shipped (2026-07-08):** separate sibling repo `../tennis_ranking01` (own CLAUDE.md/README) + separate Cloud Run service `ton-phet-ranking` (image `…/ton-phet/ranking:v1`) — day/week/month podium leaderboard (🏆🥈🥉, avg + max score per user, Bangkok day boundaries, ATP-broadcast dark theme reusing the app's tokens), reads `leaderboard_records` only, hourly backfill safety net from live sessions⋈shots (also backfills pre-v1.0 sessions). Needs `DATABASE_URL` env var on deploy.
- **v1.0.1–v1.0.3 (2026-07-08, on-device feedback rounds on the export card):** brand line flush-LEFT on the same edge as the left column (user's device rendered the centered brand off the right edge), roomier line gaps; left column "ผู้ใช้งาน : <name>" above "#N · stroke" at EQUAL 52px font; unknown stroke shows bare "#N" (no "ไม่ทราบชนิด") in both the history card and the export; radar title "มุมข้อต่อเทียบเป้าหมาย" removed and the radar/fix-bullet gap widened (radar cy 1300→1268, fixStartY 1512→1560 — clearances asserted in tests). 220/220 tests each round.

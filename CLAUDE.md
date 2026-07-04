# CLAUDE.md

Guidance for Claude Code working in this repo. These instructions override default behavior.

## Project

**ต้นและเพชร Tennis Club** — a mobile-first web app that coaches tennis in realtime. Open the phone camera → local MediaPipe pose overlay (skeleton + joint angles) → per-shot score → a spoken **Gemini Live** coach that says the one thing to fix after each swing → per-session cost tracking in **THB**. Language TH/EN switchable (TH primary). Phase 1 = playing against a ball machine (no machine connectivity this phase).

Brand name is **"ต้นและเพชร Tennis Club"** (Ton & Phet). Never write "ต้นเป็ด" / "TonPed" in UI copy — that was an early mistake.

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

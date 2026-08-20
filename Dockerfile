# ADGE Tennis (SIT) — single-container build for Cloud Run
# Stage 1: build the Vite frontend
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# In production the browser fetches a fresh ephemeral token from the backend,
# so we bake the endpoint (NOT any secret) at build time.
ENV VITE_TOKEN_ENDPOINT=/api/token
# Live transport is a BUILD-TIME choice (Vite env):
#   default        → AI-Studio native audio via /api/token (needs GEMINI_API_KEY)
#   relay + model  → Vertex WS relay, no API key (needs runtime SA roles/aiplatform.user):
#   docker buildx build --build-arg LIVE_TRANSPORT=relay \
#     --build-arg LIVE_MODEL=gemini-live-2.5-flash …
ARG LIVE_TRANSPORT=""
# SIT default (v1.3.1): Gemini Live 3. Verified 2026-07-14 by spike: Thai female
# default voice + reads swing JPEGs on the SAME sendRealtimeInput channel the
# app already uses (IMAGE tokens billed). Prod (main) stays on the 2.5 native-
# audio preview. Rollback = --build-arg LIVE_MODEL=gemini-2.5-flash-native-audio-preview-09-2025
ARG LIVE_MODEL=gemini-3.1-flash-live-preview
ENV VITE_LIVE_TRANSPORT=$LIVE_TRANSPORT
ENV VITE_GEMINI_LIVE_MODEL=$LIVE_MODEL
ENV VITE_USD_TO_THB=36.5
RUN npm run build

# Stage 2: runtime — Node serves dist/ and mints tokens
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/
RUN cd server && npm install --omit=dev
COPY server/ server/
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "server/index.mjs"]

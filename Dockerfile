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
ENV VITE_GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-09-2025
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

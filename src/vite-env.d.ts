/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_TOKEN?: string;
  readonly VITE_GEMINI_LIVE_MODEL?: string;
  readonly VITE_USD_TO_THB?: string;
  /** Production: backend endpoint that mints fresh ephemeral tokens (e.g. "/api/token"). */
  readonly VITE_TOKEN_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

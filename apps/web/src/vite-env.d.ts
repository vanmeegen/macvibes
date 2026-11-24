/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * `true`: eine Nachricht während eines laufenden Turns unterbricht ihn
   * (Mid-Turn-Steering). Default aus — s. ChatStore.
   */
  readonly VITE_MACVIBES_STEER_ON_SEND?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

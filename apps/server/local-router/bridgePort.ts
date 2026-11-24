/** Default-Port der LiteLLM-Bridge — derselbe wie im Default von MACVIBES_LITELLM_URL. */
export const DEFAULT_BRIDGE_PORT = '8787';

export interface BridgePortOptions {
  /** MACVIBES_LOCAL_ROUTER_PORT (ausdrücklich gewählter Port) oder undefined. */
  portEnv: string | undefined;
  /** MACVIBES_LITELLM_URL — die URL, unter der der Server die Bridge erwartet. */
  urlEnv: string | undefined;
}

/**
 * Auf welchem Port lauscht die Bridge? EINE Quelle mit dem Server: ohne
 * ausdrücklichen Port gilt der aus MACVIBES_LITELLM_URL — sonst prüfte der
 * Server nach einer URL-Änderung einen Port, auf dem die Bridge nie lauscht.
 */
export function resolveBridgePort(options: BridgePortOptions): string {
  if (options.portEnv !== undefined && options.portEnv !== '') return options.portEnv;
  if (options.urlEnv !== undefined && options.urlEnv !== '') {
    try {
      const port = new URL(options.urlEnv).port;
      if (port !== '') return port;
    } catch (error) {
      console.warn(
        `MACVIBES_LITELLM_URL="${options.urlEnv}" ist keine URL — Port-Default gilt.`,
        error,
      );
    }
  }
  return DEFAULT_BRIDGE_PORT;
}

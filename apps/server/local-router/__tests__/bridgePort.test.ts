import { describe, expect, test } from 'bun:test';
import { resolveBridgePort } from '../bridgePort';

/**
 * Der Port der LiteLLM-Bridge hatte zwei unabhängige Quellen: der Server
 * prüft MACVIBES_LITELLM_URL, die Bridge lauschte auf
 * MACVIBES_LOCAL_ROUTER_PORT. Wer nur die URL änderte, ließ den Server einen
 * Port prüfen, auf dem die Bridge nie lauschte.
 */
describe('resolveBridgePort (expliziter Port > Port der Bridge-URL > 8787)', () => {
  test('ohne Angaben gilt der Default 8787', () => {
    expect(resolveBridgePort({ portEnv: undefined, urlEnv: undefined })).toBe('8787');
  });

  test('der Port aus MACVIBES_LITELLM_URL gilt auch für die Bridge selbst', () => {
    expect(resolveBridgePort({ portEnv: undefined, urlEnv: 'http://localhost:8899' })).toBe('8899');
  });

  test('MACVIBES_LOCAL_ROUTER_PORT gewinnt, wenn ausdrücklich gesetzt', () => {
    expect(resolveBridgePort({ portEnv: '9001', urlEnv: 'http://localhost:8899' })).toBe('9001');
  });

  test('eine URL ohne Port oder eine unlesbare URL fällt auf den Default zurück', () => {
    expect(resolveBridgePort({ portEnv: '', urlEnv: 'http://bridge.lan' })).toBe('8787');
    expect(resolveBridgePort({ portEnv: undefined, urlEnv: 'kein url' })).toBe('8787');
  });
});

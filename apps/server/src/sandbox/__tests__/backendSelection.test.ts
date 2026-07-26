import { describe, expect, test } from 'bun:test';
import {
  UnsafeBackendError,
  selectBackends,
  type BackendSelectionInput,
} from '../backendSelection';

function input(overrides: Partial<BackendSelectionInput> = {}): BackendSelectionInput {
  return {
    configured: 'auto',
    agent: 'claude',
    msbAvailable: true,
    allowHostAgent: false,
    ...overrides,
  };
}

describe('selectBackends — regulärer Betrieb', () => {
  test('auto mit verfügbarem msb ergibt VM-Isolat und Daemon-Transport', () => {
    expect(selectBackends(input())).toEqual({ sandbox: 'microsandbox', agent: 'daemon' });
  });

  test('explizit microsandbox verhält sich wie auto mit msb', () => {
    expect(selectBackends(input({ configured: 'microsandbox' }))).toEqual({
      sandbox: 'microsandbox',
      agent: 'daemon',
    });
  });
});

/**
 * F9: Ohne microsandbox fiel der Server bisher still auf den Host-Agenten mit
 * `bypassPermissions` zurück — ein angemeldeter Nutzer bekam damit faktisch
 * Codeausführung auf dem Mac. Jetzt fail-closed.
 */
describe('selectBackends — fail-closed ohne Isolation (F9)', () => {
  test('auto ohne msb verweigert den Start', () => {
    expect(() => selectBackends(input({ msbAvailable: false }))).toThrow(UnsafeBackendError);
  });

  test('explizit microsandbox ohne msb verweigert den Start', () => {
    expect(() =>
      selectBackends(input({ configured: 'microsandbox', msbAvailable: false })),
    ).toThrow(UnsafeBackendError);
  });

  test('explizit process mit echtem Agenten verweigert den Start', () => {
    expect(() => selectBackends(input({ configured: 'process' }))).toThrow(UnsafeBackendError);
  });

  test('die Fehlermeldung nennt den Ausweg', () => {
    expect(() => selectBackends(input({ msbAvailable: false }))).toThrow(
      /MACVIBES_ALLOW_HOST_AGENT/,
    );
  });

  test('mit ausdrücklichem Opt-in läuft der Host-Agent weiterhin', () => {
    expect(selectBackends(input({ msbAvailable: false, allowHostAgent: true }))).toEqual({
      sandbox: 'process',
      agent: 'host',
    });
  });
});

/**
 * Der Fake-Agent führt keinen fremden Code aus — der Prozess-Provider ist dort
 * unbedenklich. Das ist genau der Pfad, den Playwright fährt
 * (MACVIBES_SANDBOX=process, MACVIBES_AGENT=fake); er muss grün bleiben.
 */
describe('selectBackends — Fake-Agent (Tests/E2E)', () => {
  test('process + fake bleibt erlaubt, auch ohne msb', () => {
    expect(
      selectBackends(input({ configured: 'process', agent: 'fake', msbAvailable: false })),
    ).toEqual({ sandbox: 'process', agent: 'fake' });
  });

  test('auto + fake ohne msb fällt auf den Prozess-Provider zurück', () => {
    expect(selectBackends(input({ agent: 'fake', msbAvailable: false }))).toEqual({
      sandbox: 'process',
      agent: 'fake',
    });
  });

  test('auto + fake mit msb nutzt trotzdem das VM-Isolat', () => {
    expect(selectBackends(input({ agent: 'fake' }))).toEqual({
      sandbox: 'microsandbox',
      agent: 'fake',
    });
  });
});

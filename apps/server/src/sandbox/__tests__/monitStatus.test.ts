import { describe, expect, test } from 'bun:test';
import {
  gateReadyWithProbe,
  previewStatusFromMonitText,
  statusWithProbeFallback,
} from '../monitStatus';

function monitText(devserverStatus: string): string {
  return [
    'Monit 5.34.0 uptime: 2m',
    '',
    "Process 'devserver'",
    `  status                       ${devserverStatus}`,
    '  monitoring status            Monitored',
    '  pid                          123',
    '',
    "Process 'agent-daemon'",
    '  status                       Running',
    '',
    "System 'localhost'",
    '  status                       Running',
    '',
  ].join('\n');
}

describe('previewStatusFromMonitText', () => {
  test('Running → ready', () => {
    expect(previewStatusFromMonitText(monitText('Running'))).toBe('ready');
    expect(previewStatusFromMonitText(monitText('OK'))).toBe('ready');
  });

  test('Initializing → starting', () => {
    expect(previewStatusFromMonitText(monitText('Initializing'))).toBe('starting');
  });

  test('Restart pending / Execution failed / Does not exist → restarting', () => {
    expect(previewStatusFromMonitText(monitText('Restart pending'))).toBe('restarting');
    expect(previewStatusFromMonitText(monitText('Execution failed | Does not exist'))).toBe(
      'restarting',
    );
    expect(previewStatusFromMonitText(monitText('Does not exist'))).toBe('restarting');
  });

  test('Not monitored → failed (Crash-Loop-Endzustand nach unmonitor)', () => {
    expect(previewStatusFromMonitText(monitText('Not monitored'))).toBe('failed');
  });

  test('unbekannter Status oder fehlender Service → starting (konservativ)', () => {
    expect(previewStatusFromMonitText(monitText('Irgendwas Neues'))).toBe('starting');
    expect(previewStatusFromMonitText('Monit 5.34.0\n')).toBe('starting');
    expect(previewStatusFromMonitText('')).toBe('starting');
  });

  test('liest den richtigen Service-Abschnitt (nicht den des Daemons)', () => {
    // devserver kaputt, agent-daemon läuft — es zählt devserver.
    expect(previewStatusFromMonitText(monitText('Not monitored'), 'devserver')).toBe('failed');
    expect(previewStatusFromMonitText(monitText('Not monitored'), 'agent-daemon')).toBe('ready');
  });

  test('gateReadyWithProbe: ready gilt erst, wenn der Dev-Server WIRKLICH HTTP beantwortet', async () => {
    // monit meldet "Running", sobald der PROZESS lebt — Vite/bun brauchen aber
    // noch Sekunden bis zur ersten HTTP-Antwort. Ohne Gate lädt das iframe zu
    // früh ins Leere und lädt nie nach (Härtetest-Befund 2026-07-07).
    expect(await gateReadyWithProbe('ready', () => Promise.resolve(true))).toBe('ready');
    await expect(gateReadyWithProbe('ready', () => Promise.resolve(false))).rejects.toThrow(
      /antwortet noch nicht/,
    );
  });

  test('gateReadyWithProbe: andere Status passieren ungeprobt (failed bleibt failed)', async () => {
    let probed = false;
    const probe = (): Promise<boolean> => {
      probed = true;
      return Promise.resolve(true);
    };
    expect(await gateReadyWithProbe('starting', probe)).toBe('starting');
    expect(await gateReadyWithProbe('failed', probe)).toBe('failed');
    expect(probed).toBe(false);
  });

  // Live-Befund 2026-07-16: msb verlor das Host-Port-Mapping der monit-API,
  // während der Dev-Server weiter einwandfrei antwortete. Ohne Fallback blieb
  // der Status für immer "restarting" — das Preview-Overlay kam nie zurück.
  test('statusWithProbeFallback: monit weg + Preview antwortet → ready', async () => {
    const status = await statusWithProbeFallback(
      () => Promise.reject(new Error('connect ECONNREFUSED')),
      () => Promise.resolve(true),
    );
    expect(status).toBe('ready');
  });

  test('statusWithProbeFallback: monit weg + Preview antwortet nicht → Fehler propagiert', async () => {
    await expect(
      statusWithProbeFallback(
        () => Promise.reject(new Error('connect ECONNREFUSED')),
        () => Promise.resolve(false),
      ),
    ).rejects.toThrow('ECONNREFUSED');
  });

  test('statusWithProbeFallback: monit erreichbar → dessen Status zählt, keine Extra-Probe', async () => {
    let probed = false;
    const status = await statusWithProbeFallback(
      () => Promise.resolve('failed'),
      () => {
        probed = true;
        return Promise.resolve(true);
      },
    );
    expect(status).toBe('failed');
    expect(probed).toBe(false);
  });

  test('echte monit-Ausgabe mit ANSI-Farbcodes wird geparst (Live-Befund 2026-07-06)', () => {
    // So sieht die _status-Antwort von monit 5.34 wirklich aus: Farbcodes um
    // Abschnittstitel und Statuswerte — ohne Strippen matcht gar nichts.
    const colored = [
      'Monit 5.34.3 uptime: 0m',
      '',
      "[1;36mProcess 'devserver'[0m",
      '  status                       [0;92mOK[0m',
      '  monitoring status            Monitored',
      '  pid                          [0;39m385[0m',
      '',
    ].join('\n');
    expect(previewStatusFromMonitText(colored)).toBe('ready');
  });
});

import { describe, expect, test } from 'bun:test';
import { previewStatusFromMonitText } from '../monitStatus';

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
});

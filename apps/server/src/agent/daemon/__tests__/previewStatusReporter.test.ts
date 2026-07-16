import { describe, expect, test } from 'bun:test';
import type { PreviewStatus } from '../../../sandbox/provider';
import { PreviewStatusReporter } from '../previewStatusReporter';

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('Bedingung nicht erreicht');
    await Bun.sleep(5);
  }
}

function monitText(devserverStatus: string): string {
  return [
    'Monit 5.34.0 uptime: 2m',
    '',
    "Process 'devserver'",
    `  status                       ${devserverStatus}`,
    '',
  ].join('\n');
}

describe('PreviewStatusReporter (ADR 0001: Status-Push über die Daemon-Verbindung)', () => {
  test('pusht den Status bei Änderung: OK + Probe → ready', async () => {
    const sent: PreviewStatus[] = [];
    const reporter = new PreviewStatusReporter({
      fetchMonitText: () => Promise.resolve(monitText('OK')),
      probe: () => Promise.resolve(true),
      send: (status) => sent.push(status),
      intervalMs: 5,
      keepaliveMs: 10_000,
    });
    reporter.start();
    await until(() => sent.includes('ready'));
    reporter.stop();
    expect(sent[0]).toBe('ready');
  });

  test('gleicher Status wird nicht gespammt, aber als Keepalive wiederholt', async () => {
    const sent: PreviewStatus[] = [];
    const reporter = new PreviewStatusReporter({
      fetchMonitText: () => Promise.resolve(monitText('OK')),
      probe: () => Promise.resolve(true),
      send: (status) => sent.push(status),
      intervalMs: 5,
      keepaliveMs: 40,
    });
    reporter.start();
    await until(() => sent.length >= 2, 2000);
    reporter.stop();
    // Mindestens 2 Sends (Initial + Keepalive), aber deutlich weniger als
    // die Anzahl der Poll-Zyklen — kein Push pro Poll.
    expect(sent.every((s) => s === 'ready')).toBe(true);
    expect(sent.length).toBeLessThan(6);
  });

  test('Statuswechsel wird sofort gepusht (Restart pending → restarting)', async () => {
    const sent: PreviewStatus[] = [];
    let text = monitText('OK');
    const reporter = new PreviewStatusReporter({
      fetchMonitText: () => Promise.resolve(text),
      probe: () => Promise.resolve(true),
      send: (status) => sent.push(status),
      intervalMs: 5,
      keepaliveMs: 10_000,
    });
    reporter.start();
    await until(() => sent.includes('ready'));
    text = monitText('Restart pending');
    await until(() => sent.includes('restarting'));
    reporter.stop();
    expect(sent).toEqual(['ready', 'restarting']);
  });

  test('monit meldet OK, aber Preview antwortet nicht auf HTTP → kein ready-Push', async () => {
    const sent: PreviewStatus[] = [];
    const reporter = new PreviewStatusReporter({
      fetchMonitText: () => Promise.resolve(monitText('OK')),
      probe: () => Promise.resolve(false),
      send: (status) => sent.push(status),
      intervalMs: 5,
      keepaliveMs: 10_000,
    });
    reporter.start();
    await Bun.sleep(40);
    reporter.stop();
    expect(sent).toEqual([]);
  });

  test('monit nicht erreichbar → kein Push (Host fällt auf Probe zurück)', async () => {
    const sent: PreviewStatus[] = [];
    const reporter = new PreviewStatusReporter({
      fetchMonitText: () => Promise.reject(new Error('connect ECONNREFUSED')),
      probe: () => Promise.resolve(true),
      send: (status) => sent.push(status),
      intervalMs: 5,
      keepaliveMs: 10_000,
    });
    reporter.start();
    await Bun.sleep(40);
    reporter.stop();
    expect(sent).toEqual([]);
  });

  test('stop() beendet das Polling', async () => {
    let calls = 0;
    const reporter = new PreviewStatusReporter({
      fetchMonitText: () => {
        calls += 1;
        return Promise.resolve(monitText('OK'));
      },
      probe: () => Promise.resolve(true),
      send: () => undefined,
      intervalMs: 5,
      keepaliveMs: 10_000,
    });
    reporter.start();
    await until(() => calls > 0);
    reporter.stop();
    const after = calls;
    await Bun.sleep(30);
    expect(calls).toBe(after);
  });
});

import { describe, expect, test } from 'bun:test';
import { PreviewStatusPoller } from '../previewStatusPoller';
import type { PreviewStatus } from '../provider';

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('Bedingung nicht erreicht');
    await Bun.sleep(5);
  }
}

describe('PreviewStatusPoller', () => {
  test('startet als starting und übernimmt den gepollten Status', async () => {
    let status: PreviewStatus = 'starting';
    const poller = new PreviewStatusPoller({
      fetchStatus: () => Promise.resolve(status),
      intervalMs: 5,
    });
    expect(poller.getStatus()).toBe('starting');

    poller.start();
    status = 'ready';
    await until(() => poller.getStatus() === 'ready');

    status = 'failed';
    await until(() => poller.getStatus() === 'failed');
    poller.stop();
  });

  test('Fetch-Fehler vor dem ersten ready bleiben starting (VM bootet noch)', async () => {
    const poller = new PreviewStatusPoller({
      fetchStatus: () => Promise.reject(new Error('noch nicht erreichbar')),
      intervalMs: 5,
    });
    poller.start();
    await Bun.sleep(30);
    expect(poller.getStatus()).toBe('starting');
    poller.stop();
  });

  test('Fetch-Fehler NACH ready gelten als restarting (Status-Quelle weg)', async () => {
    let fail = false;
    const poller = new PreviewStatusPoller({
      fetchStatus: () =>
        fail ? Promise.reject(new Error('weg')) : Promise.resolve('ready' as PreviewStatus),
      intervalMs: 5,
    });
    poller.start();
    await until(() => poller.getStatus() === 'ready');
    fail = true;
    await until(() => poller.getStatus() === 'restarting');
    poller.stop();
  });

  test('stop() setzt den Status auf stopped und beendet das Polling', async () => {
    let calls = 0;
    const poller = new PreviewStatusPoller({
      fetchStatus: () => {
        calls += 1;
        return Promise.resolve('ready' as PreviewStatus);
      },
      intervalMs: 5,
    });
    poller.start();
    await until(() => poller.getStatus() === 'ready');
    poller.stop();
    expect(poller.getStatus()).toBe('stopped');
    const after = calls;
    await Bun.sleep(30);
    expect(calls).toBe(after);
  });

  test('meldet Statuswechsel über onStatusChange', async () => {
    const changes: PreviewStatus[] = [];
    let status: PreviewStatus = 'starting';
    const poller = new PreviewStatusPoller({
      fetchStatus: () => Promise.resolve(status),
      intervalMs: 5,
      onStatusChange: (s) => changes.push(s),
    });
    poller.start();
    status = 'ready';
    await until(() => changes.includes('ready'));
    poller.stop();
    expect(changes).toContain('ready');
  });
});

import { describe, expect, test } from 'bun:test';
import { PreviewStatusPoller } from '../previewStatusPoller';
import type { PreviewStatus } from '../provider';
import { waitFor } from '../../testing/testUtils';

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
    await waitFor(() => poller.getStatus() === 'ready');

    status = 'failed';
    await waitFor(() => poller.getStatus() === 'failed');
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
    await waitFor(() => poller.getStatus() === 'ready');
    fail = true;
    await waitFor(() => poller.getStatus() === 'restarting');
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
    await waitFor(() => poller.getStatus() === 'ready');
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
    await waitFor(() => changes.includes('ready'));
    poller.stop();
    expect(changes).toContain('ready');
  });
});

describe('Poll-Takt: eng beim Start, ruhig danach', () => {
  test('pollt vor dem ersten ready deutlich häufiger', async () => {
    let aufrufe = 0;
    let status: PreviewStatus = 'starting';
    const poller = new PreviewStatusPoller({
      fetchStatus: async () => {
        aufrufe += 1;
        return status;
      },
      startupIntervalMs: 20,
      intervalMs: 10_000,
    });
    poller.start();
    await Bun.sleep(150);
    const beimStart = aufrufe;
    expect(beimStart).toBeGreaterThan(3);

    // Sobald ready erreicht ist, fällt der Takt auf das ruhige Intervall.
    status = 'ready';
    await Bun.sleep(60);
    const nachReady = aufrufe;
    await Bun.sleep(150);
    expect(aufrufe - nachReady).toBeLessThanOrEqual(1);
    poller.stop();
  });
});

describe('notify: Push löst den Statuswechsel sofort aus', () => {
  test('der Zustand wechselt ohne auf den nächsten Poll zu warten', async () => {
    const gesehen: PreviewStatus[] = [];
    const poller = new PreviewStatusPoller({
      fetchStatus: async () => 'starting',
      startupIntervalMs: 10_000,
      intervalMs: 10_000,
      onStatusChange: (s) => gesehen.push(s),
    });
    poller.start();
    await Bun.sleep(20);
    expect(poller.getStatus()).toBe('starting');

    poller.notify('ready');

    expect(poller.getStatus()).toBe('ready');
    expect(gesehen).toContain('ready');
    poller.stop();
  });

  test('nach einem Push per notify gilt die Preview als schon einmal bereit', async () => {
    const poller = new PreviewStatusPoller({
      fetchStatus: async () => {
        throw new Error('Quelle weg');
      },
      startupIntervalMs: 15,
      intervalMs: 15,
    });
    poller.notify('ready');
    poller.start();
    await Bun.sleep(60);
    // everReady ist gesetzt → Ausfall heißt jetzt "restarting", nicht "starting".
    expect(poller.getStatus()).toBe('restarting');
    poller.stop();
  });
});

/**
 * B6: Eine Probe, die VOR einem Push gestartet wurde, durfte ihr (älteres)
 * Ergebnis danach noch anwenden. Beim Boot hieß das: Daemon meldet „ready",
 * die schon laufende Probe scheitert (sie startete, bevor der Dev-Server
 * lauschte) → „restarting" unter einer bereiten Vorschau, bis zum nächsten
 * Poll. Umgekehrt überschrieb eine erfolgreiche Probe ein frisches „failed".
 */
describe('Eine laufende Probe überschreibt keinen neueren Push', () => {
  function haengendeQuelle() {
    let ablehnen: (error: Error) => void = () => {};
    let aufloesen: (status: PreviewStatus) => void = () => {};
    const fetchStatus = (): Promise<PreviewStatus> =>
      new Promise<PreviewStatus>((resolve, reject) => {
        aufloesen = resolve;
        ablehnen = reject;
      });
    return {
      fetchStatus,
      ablehnen: (e: Error) => ablehnen(e),
      aufloesen: (s: PreviewStatus) => aufloesen(s),
    };
  }

  test('Push „ready", danach scheitert die alte Probe: es bleibt bei „ready"', async () => {
    const quelle = haengendeQuelle();
    const poller = new PreviewStatusPoller({
      fetchStatus: quelle.fetchStatus,
      startupIntervalMs: 10_000,
      intervalMs: 10_000,
    });
    poller.start();
    poller.notify('ready');
    quelle.ablehnen(new Error('Probe scheitert'));
    await Bun.sleep(10);
    expect(poller.getStatus()).toBe('ready');
    poller.stop();
  });

  test('Push „failed", danach meldet die alte Probe „ready": es bleibt bei „failed"', async () => {
    const quelle = haengendeQuelle();
    const poller = new PreviewStatusPoller({
      fetchStatus: quelle.fetchStatus,
      startupIntervalMs: 10_000,
      intervalMs: 10_000,
    });
    poller.start();
    poller.notify('failed');
    quelle.aufloesen('ready');
    await Bun.sleep(10);
    expect(poller.getStatus()).toBe('failed');
    poller.stop();
  });

  test('ohne Push dazwischen gilt das Ergebnis der Probe wie bisher', async () => {
    const quelle = haengendeQuelle();
    const poller = new PreviewStatusPoller({
      fetchStatus: quelle.fetchStatus,
      startupIntervalMs: 10_000,
      intervalMs: 10_000,
    });
    poller.start();
    quelle.aufloesen('ready');
    await Bun.sleep(10);
    expect(poller.getStatus()).toBe('ready');
    poller.stop();
  });
});

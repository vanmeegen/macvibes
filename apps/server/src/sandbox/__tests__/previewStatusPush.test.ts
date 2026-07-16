import { describe, expect, test } from 'bun:test';
import { PushedPreviewStatus } from '../previewStatusPush';

describe('PushedPreviewStatus (ADR 0001: Host-Empfänger mit Staleness + Probe-Fallback)', () => {
  test('frischer Daemon-Push zählt als Status', async () => {
    let now = 1000;
    const pushed = new PushedPreviewStatus({ staleMs: 100, now: () => now });
    pushed.receive('restarting');
    now = 1050;
    expect(await pushed.fetchStatus(() => Promise.resolve(true))()).toBe('restarting');
  });

  test('kein Push bisher + Preview antwortet → ready (Probe ist Ground Truth)', async () => {
    const pushed = new PushedPreviewStatus({ staleMs: 100, now: () => 1000 });
    expect(await pushed.fetchStatus(() => Promise.resolve(true))()).toBe('ready');
  });

  test('kein Push + Preview antwortet nicht → Fehler (Poller macht starting/restarting)', async () => {
    const pushed = new PushedPreviewStatus({ staleMs: 100, now: () => 1000 });
    await expect(pushed.fetchStatus(() => Promise.resolve(false))()).rejects.toThrow();
  });

  test('veralteter Push wird ignoriert — die Probe entscheidet', async () => {
    let now = 1000;
    const pushed = new PushedPreviewStatus({ staleMs: 100, now: () => now });
    pushed.receive('failed');
    now = 1200;
    expect(await pushed.fetchStatus(() => Promise.resolve(true))()).toBe('ready');
    await expect(pushed.fetchStatus(() => Promise.resolve(false))()).rejects.toThrow();
  });

  test('failed vom Daemon (Crash-Loop) schlägt eine positive Probe NICHT', async () => {
    // monit-Detail hat Vorrang, solange es frisch ist: unmonitor heißt failed,
    // auch wenn ein alter Dev-Server-Prozess noch auf HTTP antwortet.
    const pushed = new PushedPreviewStatus({ staleMs: 100, now: () => 1000 });
    pushed.receive('failed');
    expect(await pushed.fetchStatus(() => Promise.resolve(true))()).toBe('failed');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewModel } from '../PreviewModel';

const fetchMock = vi.fn();

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: Bedingung nicht erfüllt');
}

describe('PreviewModel', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bleibt auf "waiting", solange der Dev-Server nicht erreichbar ist', async () => {
    fetchMock.mockRejectedValue(new Error('Verbindung abgelehnt'));
    const model = new PreviewModel(5);
    model.start('localhost', 5199);

    expect(model.status).toBe('waiting');
    expect(model.url).toBe('http://localhost:5199/');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(model.status).toBe('waiting');
    model.reset();
  });

  it('wird "ready", sobald der Dev-Server antwortet', async () => {
    fetchMock.mockRejectedValueOnce(new Error('noch nicht da'));
    fetchMock.mockResolvedValue({ ok: true } as Response);
    const model = new PreviewModel(5);
    model.start('mein-mac.local', 42311);

    await waitFor(() => model.status === 'ready');
    expect(model.url).toBe('http://mein-mac.local:42311/');
    model.reset();
  });

  it('reset setzt den Zustand auf "unavailable" zurück', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response);
    const model = new PreviewModel(5);
    model.start('localhost', 5199);
    await waitFor(() => model.status === 'ready');

    model.reset();
    expect(model.status).toBe('unavailable');
    expect(model.url).toBeNull();
  });
});

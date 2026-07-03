import { createServer } from 'node:net';

function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen(port, '0.0.0.0', () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => resolve(boundPort));
    });
  });
}

/**
 * Findet einen freien Host-Port — bevorzugt den gewünschten (previewPort
 * aus templates.json), sonst einen vom System zugewiesenen (R7).
 */
export async function findFreePort(preferred: number): Promise<number> {
  const preferredResult = await tryListen(preferred);
  if (preferredResult !== null) return preferredResult;
  const fallback = await tryListen(0);
  if (fallback === null) {
    throw new Error('Kein freier Port gefunden');
  }
  return fallback;
}

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { httpProbe } from '../httpProbe';

/**
 * Die Probe zielt auf den Dev-Server IN der untrusted VM. Antwort, Statuszeile
 * und Location-Header sind damit angreiferkontrolliert (H10).
 */
let opfer: ReturnType<typeof Bun.serve>;
let vm: ReturnType<typeof Bun.serve>;
let opferAufrufe = 0;

beforeAll(() => {
  // Steht für einen Host-Loopback-Dienst, den die Egress-Policy der VM sperrt
  // (Caddy-Admin, macvibes selbst, der lokale Modell-Router).
  opfer = Bun.serve({
    port: 0,
    fetch: () => {
      opferAufrufe += 1;
      return new Response('geheim');
    },
  });
  vm = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${opfer.port}/admin` },
        });
      }
      if (url.pathname === '/kaputt') return new Response('Fehler', { status: 500 });
      return new Response('ok');
    },
  });
});

afterAll(() => {
  vm.stop(true);
  opfer.stop(true);
});

describe('httpProbe (H10): die VM darf den Host nicht umlenken', () => {
  test('folgt einem VM-gesetzten Redirect NICHT und kontaktiert das Ziel nie', async () => {
    opferAufrufe = 0;
    const erreichbar = await httpProbe(`http://localhost:${vm.port}/redirect`);
    // 3xx heißt: der Dev-Server lebt und antwortet — genau das prüft die Probe.
    expect(erreichbar).toBe(true);
    expect(opferAufrufe).toBe(0);
  });

  test('zählt weiterhin jede HTTP-Antwort als erreichbar (auch 5xx)', async () => {
    expect(await httpProbe(`http://localhost:${vm.port}/`)).toBe(true);
    expect(await httpProbe(`http://localhost:${vm.port}/kaputt`)).toBe(true);
  });

  test('meldet einen toten Port als nicht erreichbar', async () => {
    const tot = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const port = tot.port;
    tot.stop(true);
    expect(await httpProbe(`http://localhost:${port}/`, 300)).toBe(false);
  });
});

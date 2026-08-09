import { afterEach, describe, expect, test } from 'bun:test';
import {
  resolveTarget,
  sanitizeDownstreamHeaders,
  sanitizeUpstreamHeaders,
  startPreviewGateway,
} from '../previewGateway';

/**
 * F2/F11: Zwischen Browser und der nicht vertrauenswürdigen VM darf weder das
 * Session-Cookie hinein- noch ein VM-gesetztes Routing-Cookie herausfließen.
 */
describe('Header-Trennung Browser ↔ VM (F2, F11)', () => {
  test('das Session-Cookie erreicht die VM nicht, fremde Cookies bleiben', () => {
    const out = sanitizeUpstreamHeaders(
      new Headers({
        cookie: 'macvibes_session=geheim; app_theme=dark; mvp=proj-1',
        authorization: 'Bearer geheim',
        'x-harmlos': 'ja',
      }),
    );
    expect(out.get('cookie')).toBe('app_theme=dark');
    expect(out.get('authorization')).toBeNull();
    expect(out.get('x-harmlos')).toBe('ja');
  });

  test('bleibt nichts übrig, entfällt der Cookie-Header ganz', () => {
    const out = sanitizeUpstreamHeaders(new Headers({ cookie: 'macvibes_session=geheim' }));
    expect(out.get('cookie')).toBeNull();
  });

  test('die VM kann kein Routing-Cookie und kein HSTS setzen', () => {
    const out = sanitizeDownstreamHeaders(
      new Headers({
        'set-cookie': 'mvp=fremdes-projekt; Path=/',
        'strict-transport-security': 'max-age=31536000',
        'content-type': 'text/html',
      }),
    );
    expect(out.get('set-cookie')).toBeNull();
    expect(out.get('strict-transport-security')).toBeNull();
    expect(out.get('content-type')).toBe('text/html');
  });

  test('eigene Cookies der Preview-App bleiben erhalten', () => {
    const out = sanitizeDownstreamHeaders(new Headers({ 'set-cookie': 'app_state=42; Path=/' }));
    expect(out.get('set-cookie')).toBe('app_state=42; Path=/');
  });
});

describe('resolveTarget (rein)', () => {
  test('Einstiegspfad /p/<id>/ → id, Forward auf VM-Root, Cookie setzen', () => {
    expect(resolveTarget({ pathname: '/p/proj-1/', referer: null, cookie: null })).toEqual({
      projectId: 'proj-1',
      forwardPath: '/',
      setCookie: true,
    });
  });

  test('Einstiegspfad mit Unterpfad /p/<id>/fo/bar → Rest bleibt erhalten', () => {
    expect(resolveTarget({ pathname: '/p/proj-1/foo/bar', referer: null, cookie: null })).toEqual({
      projectId: 'proj-1',
      forwardPath: '/foo/bar',
      setCookie: true,
    });
  });

  test('Einstieg ohne Trailing-Slash /p/<id> → Forward /', () => {
    expect(resolveTarget({ pathname: '/p/proj-1', referer: null, cookie: null })?.forwardPath).toBe(
      '/',
    );
  });

  test('Root-absolutes Asset: id kommt aus dem Referer (parallelfest)', () => {
    expect(
      resolveTarget({
        pathname: '/@vite/client',
        referer: 'http://192.168.1.77:4173/p/proj-9/',
        cookie: 'mvp=proj-1',
      }),
    ).toEqual({ projectId: 'proj-9', forwardPath: '/@vite/client', setCookie: false });
  });

  test('Ohne Referer: Fallback auf Cookie mvp', () => {
    expect(
      resolveTarget({
        pathname: '/_bun/client/index.js',
        referer: null,
        cookie: 'a=1; mvp=proj-7',
      }),
    ).toEqual({ projectId: 'proj-7', forwardPath: '/_bun/client/index.js', setCookie: false });
  });

  test('Weder Pfad noch Referer noch Cookie → null', () => {
    expect(resolveTarget({ pathname: '/@vite/client', referer: null, cookie: null })).toBeNull();
  });

  test('projectId wird URL-dekodiert', () => {
    expect(resolveTarget({ pathname: '/p/a%20b/', referer: null, cookie: null })?.projectId).toBe(
      'a b',
    );
  });
});

describe('startPreviewGateway (Integration mit Fake-Upstream)', () => {
  const started: { stop: () => void }[] = [];
  let upstream: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    for (const s of started.splice(0)) s.stop();
    upstream?.stop(true);
    upstream = null;
  });

  test('proxied HTTP an den richtigen VM-Port, setzt Cookie am Einstieg', async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: (req) => new Response(`upstream:${new URL(req.url).pathname}`),
    });
    const vmPort = upstream.port ?? null;
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => vmPort,
      authenticate: async () => true,
    });
    started.push(gw);

    const res = await fetch(`http://127.0.0.1:${gw.port}/p/proj-1/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream:/');
    expect(res.headers.get('set-cookie') ?? '').toContain('mvp=proj-1');

    // Root-absolutes Asset via Referer → derselbe Upstream, Pfad erhalten.
    const asset = await fetch(`http://127.0.0.1:${gw.port}/@vite/client`, {
      headers: { referer: `http://127.0.0.1:${gw.port}/p/proj-1/` },
    });
    expect(await asset.text()).toBe('upstream:/@vite/client');
  });

  test('ZWEI Projekte gleichzeitig: Referer trennt die Upstreams sauber', async () => {
    // Zwei "VMs" (Upstreams) — das Gateway muss root-absolute Asset-Requests
    // anhand des Referers dem RICHTIGEN Projekt zuordnen (parallel offene
    // Previews im selben Browser, ein einziger Gateway-Port).
    upstream = Bun.serve({ port: 0, fetch: () => new Response('vm-A') });
    const upstreamB = Bun.serve({ port: 0, fetch: () => new Response('vm-B') });
    try {
      const ports: Record<string, number | null> = {
        'proj-a': upstream.port ?? null,
        'proj-b': upstreamB.port ?? null,
      };
      const gw = startPreviewGateway({
        port: 0,
        previewPortFor: (id) => ports[id] ?? null,
        authenticate: async () => true,
      });
      started.push(gw);

      // Einstieg beider Projekte trifft die jeweils eigene VM.
      expect(await (await fetch(`http://127.0.0.1:${gw.port}/p/proj-a/`)).text()).toBe('vm-A');
      expect(await (await fetch(`http://127.0.0.1:${gw.port}/p/proj-b/`)).text()).toBe('vm-B');

      // Dasselbe Asset, unterschiedlicher Referer → unterschiedliche VM.
      const viaA = await fetch(`http://127.0.0.1:${gw.port}/assets/app.js`, {
        headers: { referer: `http://127.0.0.1:${gw.port}/p/proj-a/` },
      });
      const viaB = await fetch(`http://127.0.0.1:${gw.port}/assets/app.js`, {
        headers: { referer: `http://127.0.0.1:${gw.port}/p/proj-b/` },
      });
      expect(await viaA.text()).toBe('vm-A');
      expect(await viaB.text()).toBe('vm-B');
    } finally {
      upstreamB.stop(true);
    }
  });

  test('kein/gestoppter VM-Port → 503', async () => {
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => null,
      authenticate: async () => true,
    });
    started.push(gw);
    const res = await fetch(`http://127.0.0.1:${gw.port}/p/proj-x/`);
    expect(res.status).toBe(503);
  });

  test('unbekanntes Ziel (kein Routing-Hinweis) → 503', async () => {
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => 1,
      authenticate: async () => true,
    });
    started.push(gw);
    const res = await fetch(`http://127.0.0.1:${gw.port}/@vite/client`);
    expect(res.status).toBe(503);
  });

  /**
   * F19: Das Gateway lauscht auf 0.0.0.0 und wird für Remote-Zugriff bewusst
   * geforwardet — ohne Auth erreicht jeder mit einer Projekt-ID jede laufende
   * Preview, inklusive POST-Requests in die fremde VM.
   */
  test('ohne Session: 401, und die VM wird nicht kontaktiert (F19)', async () => {
    let upstreamHits = 0;
    upstream = Bun.serve({
      port: 0,
      fetch: () => {
        upstreamHits += 1;
        return new Response('geheim');
      },
    });
    const vmPort = upstream.port ?? null;
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => vmPort,
      authenticate: async (token) => token === 'gueltig',
    });
    started.push(gw);

    const res = await fetch(`http://127.0.0.1:${gw.port}/p/proj-1/`);
    expect(res.status).toBe(401);
    expect(upstreamHits).toBe(0);

    const ok = await fetch(`http://127.0.0.1:${gw.port}/p/proj-1/`, {
      headers: { cookie: 'macvibes_session=gueltig' },
    });
    expect(ok.status).toBe(200);
    expect(upstreamHits).toBe(1);
  });

  test('kaputtes Percent-Encoding im Cookie ergibt 401, keinen Absturz (H7)', async () => {
    // Der Decode stand im Argument der Auth-Prüfung, wurde also VOR ihr
    // ausgewertet: ein unangemeldeter Request mit `%ZZ` warf einen
    // unbehandelten URIError.
    let upstreamHits = 0;
    upstream = Bun.serve({
      port: 0,
      fetch: () => {
        upstreamHits += 1;
        return new Response('geheim');
      },
    });
    const vmPort = upstream.port ?? null;
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => vmPort,
      authenticate: async (token) => token === 'gueltig',
    });
    started.push(gw);

    for (const kaputt of [
      'macvibes_session=%ZZ',
      'macvibes_session=%',
      'macvibes_session=%E0%A4',
    ]) {
      const res = await fetch(`http://127.0.0.1:${gw.port}/p/proj-1/`, {
        headers: { cookie: kaputt },
      });
      expect(res.status).toBe(401);
    }
    expect(upstreamHits).toBe(0);
  });

  test('mehrdeutiges Session-Cookie ergibt 401 (H2: Cookie-Tossing)', async () => {
    let upstreamHits = 0;
    upstream = Bun.serve({
      port: 0,
      fetch: () => {
        upstreamHits += 1;
        return new Response('geheim');
      },
    });
    const vmPort = upstream.port ?? null;
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => vmPort,
      authenticate: async (token) => token === 'gueltig',
    });
    started.push(gw);

    // Die Preview hat ein zweites Cookie untergeschoben; welches echt ist,
    // kann das Gateway nicht entscheiden.
    const res = await fetch(`http://127.0.0.1:${gw.port}/p/proj-1/`, {
      headers: { cookie: 'macvibes_session=untergeschoben; macvibes_session=gueltig' },
    });
    expect(res.status).toBe(401);
    expect(upstreamHits).toBe(0);
  });

  test('auch der WebSocket-Upgrade verlangt eine Session (F19)', async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv): Response | undefined {
        if (srv.upgrade(req, { data: undefined })) return undefined;
        return new Response('nope');
      },
      websocket: {
        message(ws, msg): void {
          ws.send(`echo:${msg as string}`);
        },
      },
    });
    const vmPort = upstream.port ?? null;
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => vmPort,
      authenticate: async (token) => token === 'gueltig',
    });
    started.push(gw);

    const client = new WebSocket(`ws://127.0.0.1:${gw.port}/p/proj-1/`);
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      client.addEventListener('close', done);
      client.addEventListener('error', done);
      client.addEventListener('message', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    expect(closed).toBe(true);
  });

  test('das Session-Cookie wird nicht an die VM weitergereicht (F2)', async () => {
    let seenCookie: string | null = null;
    upstream = Bun.serve({
      port: 0,
      fetch: (req) => {
        seenCookie = req.headers.get('cookie');
        return new Response('ok');
      },
    });
    const vmPort = upstream.port ?? null;
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => vmPort,
      authenticate: async () => true,
    });
    started.push(gw);

    await fetch(`http://127.0.0.1:${gw.port}/p/proj-1/`, {
      headers: { cookie: 'macvibes_session=geheim; app_theme=dark' },
    });
    expect(seenCookie ?? '').not.toContain('geheim');
    expect(seenCookie ?? '').toContain('app_theme=dark');
  });

  test('stop() löst zügig auf, auch wenn die VM einer offenen HMR-WS schon weg ist', async () => {
    // Regression (Live-Befund 2026-08): Beim SIGTERM hing der Abschaltschritt
    // „Preview-Gateway" >45 s. Pro HMR-Verbindung öffnet das Gateway einen
    // EIGENEN Upstream-Client (ws://127.0.0.1:<vmPort>). Beim Herunterfahren
    // werden die Sandboxes (VMs) VOR dem Gateway gestoppt — der Upstream zeigt
    // also auf einen toten Peer. server.stop(true) wartete dann bis zum
    // TCP-Timeout auf diese Verbindung. stop() muss die selbst geöffneten
    // Upstreams selbst schliessen und darf nicht auf sie warten.
    const localUpstream = Bun.serve({
      port: 0,
      fetch(req, srv): Response | undefined {
        if (srv.upgrade(req, { data: undefined })) return undefined;
        return new Response('nope');
      },
      websocket: {
        message(ws, msg): void {
          ws.send(`echo:${msg as string}`);
        },
      },
    });
    const vmPort = localUpstream.port ?? null;
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => vmPort,
      authenticate: async () => true,
    });

    // Echte proxied Verbindung aufbauen und einen Roundtrip abwarten, damit der
    // Upstream-Client garantiert OPEN ist.
    const client = new WebSocket(`ws://127.0.0.1:${gw.port}/p/proj-1/`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS-Timeout')), 5000);
      client.addEventListener('open', () => client.send('ping'));
      client.addEventListener('message', () => {
        clearTimeout(timer);
        resolve();
      });
      client.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WS-Fehler'));
      });
    });

    // Die „VM" verschwindet abrupt — genau die Reihenfolge beim Shutdown.
    localUpstream.stop(true);
    await Bun.sleep(100);

    // stop() muss zügig auflösen — vor dem Fix hängt es bis zum TCP-Timeout.
    const ergebnis = await Promise.race([
      gw.stop().then(() => 'gestoppt' as const),
      Bun.sleep(3000).then(() => 'timeout' as const),
    ]);
    client.close();
    expect(ergebnis).toBe('gestoppt');
  });

  test('HMR-WebSocket wird bidirektional zum VM-Dev-Server gebrückt', async () => {
    // Fake-Upstream mit WS-Echo (steht für den HMR-Endpunkt des Dev-Servers).
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv): Response | undefined {
        if (srv.upgrade(req, { data: undefined })) return undefined;
        return new Response('nope');
      },
      websocket: {
        message(ws, msg): void {
          ws.send(`echo:${msg as string}`);
        },
      },
    });
    const vmPort = upstream.port ?? null;
    const gw = startPreviewGateway({
      port: 0,
      previewPortFor: () => vmPort,
      authenticate: async () => true,
    });
    started.push(gw);

    const client = new WebSocket(`ws://127.0.0.1:${gw.port}/p/proj-1/`);
    const reply = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS-Timeout')), 5000);
      client.addEventListener('open', () => client.send('ping'));
      client.addEventListener('message', (e) => {
        clearTimeout(timer);
        resolve(String((e as MessageEvent).data));
      });
      client.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WS-Fehler'));
      });
    });
    client.close();
    expect(reply).toBe('echo:ping');
  });
});

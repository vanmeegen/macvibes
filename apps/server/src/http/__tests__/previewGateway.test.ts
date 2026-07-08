import { afterEach, describe, expect, test } from 'bun:test';
import { resolveTarget, startPreviewGateway } from '../previewGateway';

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
    const gw = startPreviewGateway({ port: 0, previewPortFor: () => vmPort });
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

  test('kein/gestoppter VM-Port → 503', async () => {
    const gw = startPreviewGateway({ port: 0, previewPortFor: () => null });
    started.push(gw);
    const res = await fetch(`http://127.0.0.1:${gw.port}/p/proj-x/`);
    expect(res.status).toBe(503);
  });

  test('unbekanntes Ziel (kein Routing-Hinweis) → 503', async () => {
    const gw = startPreviewGateway({ port: 0, previewPortFor: () => 1 });
    started.push(gw);
    const res = await fetch(`http://127.0.0.1:${gw.port}/@vite/client`);
    expect(res.status).toBe(503);
  });
});

import { createOwnProject, expect, openAsVisitor, test } from './fixtures';

// R7 — Live-Preview: Dev-Server läuft in der Sandbox, iframe zeigt darauf.

test('Preview: Dev-Server der Sandbox wird im iframe erreichbar', async ({
  page,
  request,
  chatPage,
}) => {
  test.setTimeout(180_000);
  await createOwnProject(page, 'Preview Test');

  // Erst „startet…"-Zustand oder direkt ready — nie ein Browser-Fehlerbild.
  const iframe = chatPage.previewIframe;
  await expect(iframe).toBeVisible({ timeout: 120_000 });

  // Neu: die iframe-URL zeigt aufs Preview-Gateway (fester Port) mit /p/<id>/,
  // nicht mehr direkt auf den dynamischen VM-Port.
  const src = await iframe.getAttribute('src');
  expect(src).toMatch(/^http:\/\/localhost:\d+\/p\/[^/]+\/$/);

  // Der Dev-Server antwortet wirklich — über das Gateway durchgereicht
  // (Template-agnostisch: nur Status zählt). 127.0.0.1 statt localhost: der
  // Dev-Server bindet IPv4, node-fetch würde localhost sonst zu ::1 auflösen.
  // Das Gateway verlangt seit F19 eine gültige Session; der request-Fixture
  // hat keine Browser-Cookies, deshalb reichen wir sie explizit durch.
  const session = (await page.context().cookies()).find((c) => c.name === 'macvibes_session');
  expect(session).toBeDefined();
  const response = await request.get((src ?? '').replace('localhost', '127.0.0.1'), {
    headers: { cookie: `macvibes_session=${session?.value ?? ''}` },
  });
  expect(response.ok()).toBeTruthy();

  // Ohne Session bleibt dieselbe URL verschlossen (F19).
  const anonym = await request.get((src ?? '').replace('localhost', '127.0.0.1'));
  expect(anonym.status()).toBe(401);

  // Und die Seite RENDERT im iframe: erst damit laufen die root-absoluten
  // Asset-Requests (/@vite/client, /_bun/…) über die Referer-Routing-Logik
  // des Gateways — genau die Bug-Klasse „Preview bleibt schwarz".
  await expect(chatPage.previewBody).toContainText(/Deine App/i, { timeout: 60_000 });
});

test('Fremdes Projekt: Öffnen startet die Sandbox, Preview wird sichtbar (R10)', async ({
  page,
  chatPage,
}) => {
  test.setTimeout(180_000);

  const name = await createOwnProject(page, 'Preview Fremd');

  // Nur-Lese-Besucher: Chat bleibt gesperrt, aber die Sandbox bootet, damit die
  // Live-Preview betrachtet werden kann (R10). Vorher die Grace-Period (E2E:
  // 1,5 s) abwarten, damit die Sandbox des Owners sicher gestoppt ist — der
  // Besucher muss sie selbst hochfahren.
  await openAsVisitor(page, name, { waitAfterLogoutMs: 3_000 });

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(chatPage.previewIframe).toBeVisible({ timeout: 120_000 });
  await expect(chatPage.previewUnavailable).toHaveCount(0);
});

import { describe, expect, test } from 'bun:test';
import { FakeAgentRunner } from '../../agent/fakeRunner';
import { loadConfig } from '../../config';
import { SandboxManager } from '../../sandbox/sandboxManager';
import type { SandboxContext, SandboxHandle, SandboxProvider } from '../../sandbox/provider';
import { ChatService } from '../../services/chatService';
import { createTestDb } from '../../services/__tests__/testUtils';
import { createAppYoga } from '../createAppYoga';

const HOST = 'mac.local:4000';

function makeYoga(): ReturnType<typeof createAppYoga> {
  const db = createTestDb();
  const provider: SandboxProvider = {
    async start(_context: SandboxContext): Promise<SandboxHandle> {
      return { previewHostPort: 1, previewStatus: () => 'ready' as const, stop: async () => {} };
    },
  };
  const sandboxManager = new SandboxManager({
    provider,
    graceMs: 1000,
    idleMs: 1000,
    maxSandboxes: 8,
  });
  const chatService = new ChatService(db, new FakeAgentRunner(1), {});
  return createAppYoga({ db, config: loadConfig(), sandboxManager, chatService, devWebPort: 5173 });
}

function graphql(headers: Record<string, string>, query = '{ __typename }'): Request {
  return new Request(`http://${HOST}/graphql`, {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
}

/**
 * F5: `createYoga` ohne cors-Option spiegelte JEDE Origin und setzte
 * Allow-Credentials — die Preview-VM konnte damit Antworten der API lesen.
 */
describe('CORS-Allowlist (F5)', () => {
  test('fremde Origin wird nicht zurückgespiegelt', async () => {
    const res = await makeYoga().fetch(
      new Request(`http://${HOST}/graphql`, {
        method: 'OPTIONS',
        headers: {
          host: HOST,
          origin: 'https://boese.example',
          'access-control-request-method': 'POST',
        },
      }),
      { ip: null },
    );
    // Yoga sendet für nicht erlaubte Origins das Literal "null" statt der
    // Origin — der Browser blockt das. Entscheidend ist nur: nicht spiegeln.
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://boese.example');
  });

  test('die eigene Origin wird erlaubt', async () => {
    const res = await makeYoga().fetch(
      new Request(`http://${HOST}/graphql`, {
        method: 'OPTIONS',
        headers: {
          host: HOST,
          origin: `http://${HOST}`,
          'access-control-request-method': 'POST',
        },
      }),
      { ip: null },
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(`http://${HOST}`);
  });
});

/**
 * F6: Die Authentifizierung hängt allein am Ambient-Cookie. Ohne Prüfung
 * genügt ein Formular in der Preview (same-site, SameSite=Lax greift nicht),
 * um eine Mutation im Namen des Betrachters auszulösen.
 */
describe('CSRF-Schutz (F6)', () => {
  test('Sec-Fetch-Site: cross-site wird mit 403 abgelehnt', async () => {
    const res = await makeYoga().fetch(graphql({ 'sec-fetch-site': 'cross-site' }), { ip: null });
    expect(res.status).toBe(403);
  });

  test('die Preview-Origin auf anderem Port derselben Site wird abgelehnt', async () => {
    const res = await makeYoga().fetch(
      graphql({ origin: 'http://mac.local:4173', 'sec-fetch-site': 'same-site' }),
      { ip: null },
    );
    expect(res.status).toBe(403);
  });

  test('same-origin-Anfragen kommen durch', async () => {
    const res = await makeYoga().fetch(
      graphql({ origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' }),
      { ip: null },
    );
    expect(res.status).toBe(200);
  });
});

/**
 * F24: `maskedErrors: false` reichte jede git-/msb-/fs-Meldung samt Hostpfaden
 * an das UI durch. Maskierung an, aber DomainError bleibt lesbar.
 */
describe('Fehlermaskierung (F24)', () => {
  test('die deutsche DomainError-Meldung überlebt die Maskierung', async () => {
    const res = await makeYoga().fetch(graphql({}, '{ projects { id } }'), { ip: null });
    const body = (await res.json()) as { errors?: { message: string }[] };
    expect(body.errors?.[0]?.message).toBe('Nicht angemeldet');
  });
});

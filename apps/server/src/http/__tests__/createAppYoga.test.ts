import { describe, expect, spyOn, test } from 'bun:test';
import { FakeAgentRunner } from '../../agent/fakeRunner';
import { loadConfig } from '../../config';
import { createDb, type Db } from '../../db/client';
import { SandboxManager } from '../../sandbox/sandboxManager';
import type { SandboxContext, SandboxHandle, SandboxProvider } from '../../sandbox/provider';
import { ChatService } from '../../services/chatService';
import { createTestDb } from '../../services/__tests__/testUtils';
import { createAppYoga } from '../createAppYoga';

const HOST = 'mac.local:4000';

function makeYoga(overrides: { db?: Db } = {}): ReturnType<typeof createAppYoga> {
  const db = overrides.db ?? createTestDb();
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
  // devWebPort kommt (wie im echten Betrieb) aus dem config-Objekt — nicht
  // aus der Test-Umgebung, damit die Origin-Tests deterministisch bleiben.
  const config = { ...loadConfig(), devWebPort: 5173 };
  return createAppYoga({ db, config, sandboxManager, chatService });
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

  test('die Dev-Web-Origin aus der Config wird erlaubt', async () => {
    // Guard für den Refactor „devWebPort aus dem config-Objekt": makeYoga
    // setzt devWebPort 5173 — die Vite-Origin muss in der Allowlist landen.
    const res = await makeYoga().fetch(
      new Request(`http://${HOST}/graphql`, {
        method: 'OPTIONS',
        headers: {
          host: HOST,
          origin: 'http://mac.local:5173',
          'access-control-request-method': 'POST',
        },
      }),
      { ip: null },
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('http://mac.local:5173');
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
  interface ErrorBody {
    errors?: { message: string; extensions?: { code?: string } }[];
  }

  test('die deutsche DomainError-Meldung überlebt die Maskierung', async () => {
    const res = await makeYoga().fetch(graphql({}, '{ projects { id } }'), { ip: null });
    // HTTP 200 ist Teil des API-Vertrags: DomainErrors sind erwartete
    // GraphQL-Fehler, keine Transportfehler. Die Invariante hängt an Yogas
    // isOriginalGraphQLError (ein gesetzter originalError, der KEIN
    // GraphQLError ist, kippte sie auf 500) — deshalb hier festgenagelt.
    expect(res.status).toBe(200);
    const body = (await res.json()) as ErrorBody;
    expect(body.errors?.[0]?.message).toBe('Nicht angemeldet');
  });

  test('DomainErrors tragen den API-Vertrag extensions.code = DOMAIN_ERROR', async () => {
    const res = await makeYoga().fetch(graphql({}, '{ projects { id } }'), { ip: null });
    const body = (await res.json()) as ErrorBody;
    expect(body.errors?.[0]?.extensions?.code).toBe('DOMAIN_ERROR');
  });

  test('interne Fehlermeldungen erreichen den Client NICHT', async () => {
    // DB ohne Migrationen: der login-Resolver läuft in einen echten internen
    // Fehler ("no such table: users") — genau die Klasse Meldung (SQL-/git-/
    // fs-Interna), die maskiert werden muss.
    const kaputteDb = createDb(':memory:');
    const res = await makeYoga({ db: kaputteDb }).fetch(
      graphql({}, 'mutation { login(username: "marco", password: "passwort123") { id } }'),
      { ip: null },
    );
    // Auch maskierte interne Fehler antworten mit 200: die Maskierung ersetzt
    // den Fehler durch einen GraphQLError OHNE originalError, den Yoga als
    // „erwartet" zählt. Festgenagelt, damit ein Yoga-Upgrade das nicht still
    // auf 500 kippt (das UI unterscheidet GraphQL- von Transportfehlern).
    expect(res.status).toBe(200);
    const body = (await res.json()) as ErrorBody;
    const message = body.errors?.[0]?.message ?? '';
    expect(message).toBe('Unexpected error.');
    expect(message).not.toContain('users');
    expect(body.errors?.[0]?.extensions?.code).not.toBe('DOMAIN_ERROR');
  });

  test('GraphQL-Validierungsfehler bleiben unverändert sichtbar', async () => {
    const res = await makeYoga().fetch(graphql({}, '{ gibtEsNicht }'), { ip: null });
    const body = (await res.json()) as ErrorBody;
    expect(body.errors?.[0]?.message).toContain('gibtEsNicht');
  });
});

/**
 * Regression des M3-Fixes: weil maskInternalErrors für DomainErrors ein NEUES
 * GraphQLError-Objekt baut, wertete Yogas maskError-Wrapper (`newError !==
 * error`) jeden DomainError als maskierten Fehler und loggte ihn mit vollem
 * Stacktrace — jedes „Nicht angemeldet" eines ausgeloggten Tabs, jeder
 * Rate-Limit-Treffer wurde Dauerrauschen, das echte Fehler verdeckt.
 */
describe('Fehler-Logging', () => {
  test('DomainErrors werden NICHT als error geloggt', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await makeYoga().fetch(graphql({}, '{ projects { id } }'), { ip: null });
      expect(res.status).toBe(200);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('interne Fehler werden WEITERHIN geloggt', async () => {
    // Gegenprobe: die Unterdrückung darf NUR DomainErrors treffen — interne
    // Fehler (hier: DB ohne Migrationen) müssen im Server-Log auftauchen,
    // gerade WEIL das UI nur „Unexpected error." sieht (F24).
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const kaputteDb = createDb(':memory:');
      await makeYoga({ db: kaputteDb }).fetch(
        graphql({}, 'mutation { login(username: "marco", password: "passwort123") { id } }'),
        { ip: null },
      );
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

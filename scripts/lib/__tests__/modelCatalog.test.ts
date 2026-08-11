/**
 * Modell-Katalog eigener Anbieter — test-first (CLAUDE.md). Reine Logik:
 * Kandidaten-URLs (/models mit derselben Wurzel-/v1-Logik wie die Probe),
 * defensives Parsen der Anbieter-Antwort ({data:[{id,…}]}), Filtern, das
 * Auswahl-Parsing („1,3,7" / „alle" / leer) und die dünne fetch-Schale
 * (injizierbar — Tests machen NIE echte Netz-Requests, Redirects werden aus
 * demselben Token-Leak-Grund wie bei der Probe nicht verfolgt).
 */
import { describe, expect, test } from 'bun:test';
import {
  AUSWAHL_ANZEIGE_LIMIT,
  begrenzeTreffer,
  filterModelle,
  holeModellListe,
  modelListRequests,
  modelListUrls,
  parseAuswahl,
  parseManuelleIds,
  parseModelList,
  trenneClaudeIds,
  type ModellKandidat,
} from '../modelCatalog';

describe('modelListUrls — Kandidaten wie bei der Format-Probe (Wurzel-/v1-Logik)', () => {
  test('Basis ohne /v1 → beide Varianten: <basis>/models und <wurzel>/v1/models', () => {
    expect(modelListUrls('https://api.acme.example')).toEqual([
      'https://api.acme.example/models',
      'https://api.acme.example/v1/models',
    ]);
  });

  test('Basis MIT /v1 → die Varianten fallen zusammen (Dedupe, kein /v1/v1)', () => {
    expect(modelListUrls('https://openrouter.ai/api/v1')).toEqual([
      'https://openrouter.ai/api/v1/models',
    ]);
  });

  test('Trailing-Slashes und Leerraum werden normalisiert', () => {
    expect(modelListUrls('  https://api.acme.example/v1//  ')).toEqual([
      'https://api.acme.example/v1/models',
    ]);
  });
});

describe('modelListRequests — beide Auth-Varianten (welche zieht, weiß man nicht)', () => {
  test('mit Token: Bearer-Variante UND x-api-key+anthropic-version-Variante', () => {
    const requests = modelListRequests('https://api.acme.example/v1/models', 'sk-1');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers).toEqual({ authorization: 'Bearer sk-1' });
    expect(requests[1]?.headers).toEqual({
      'x-api-key': 'sk-1',
      'anthropic-version': '2023-06-01',
    });
    for (const r of requests) expect(r.url).toBe('https://api.acme.example/v1/models');
  });

  test('ohne Token: keine Auth-Header (lokale Endpunkte), Anthropic-Variante nur mit Version', () => {
    const requests = modelListRequests('http://localhost:8080/models', '');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers).toEqual({});
    expect(requests[1]?.headers).toEqual({ 'anthropic-version': '2023-06-01' });
  });
});

describe('parseModelList — defensives Parsen der {data:[…]}-Form', () => {
  test('OpenRouter/OpenAI/Anthropic-Form: id + Label aus name/display_name/id', () => {
    const body = {
      data: [
        { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' },
        { id: 'glm-4.7', display_name: 'GLM 4.7' },
        { id: 'nur-id' },
      ],
    };
    expect(parseModelList(body)).toEqual([
      { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder' },
      { id: 'glm-4.7', label: 'GLM 4.7' },
      { id: 'nur-id', label: 'nur-id' },
    ]);
  });

  test('nur Einträge mit nichtleerer String-id — alles andere wird still übergangen', () => {
    const body = {
      data: [{ id: '' }, { id: 42 }, { name: 'ohne id' }, null, 'string', { id: 'gueltig' }],
    };
    expect(parseModelList(body)).toEqual([{ id: 'gueltig', label: 'gueltig' }]);
  });

  test('leere/whitespace-Labels fallen auf die id zurück', () => {
    expect(parseModelList({ data: [{ id: 'x-1', name: '   ' }] })).toEqual([
      { id: 'x-1', label: 'x-1' },
    ]);
  });

  test('doppelte ids: der erste Eintrag gewinnt (kein Dropdown-Duplikat)', () => {
    const body = {
      data: [
        { id: 'a', name: 'Erster' },
        { id: 'a', name: 'Zweiter' },
      ],
    };
    expect(parseModelList(body)).toEqual([{ id: 'a', label: 'Erster' }]);
  });

  test('unbekannte Formen → leere Liste, kein Werfen', () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList('kein json-objekt')).toEqual([]);
    expect(parseModelList({ models: [{ id: 'x' }] })).toEqual([]);
    expect(parseModelList({ data: 'kein array' })).toEqual([]);
    expect(parseModelList([{ id: 'x' }])).toEqual([]);
  });
});

const KATALOG: ModellKandidat[] = [
  { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder' },
  { id: 'qwen/qwen3-max', label: 'Qwen3 Max' },
  { id: 'glm-4.7', label: 'GLM 4.7' },
  { id: 'meta/llama-4', label: 'Llama 4' },
];

describe('filterModelle — Suchbegriff auf id UND Label, case-insensitiv', () => {
  test('Treffer über die id', () => {
    expect(filterModelle(KATALOG, 'qwen').map((m) => m.id)).toEqual([
      'qwen/qwen3-coder',
      'qwen/qwen3-max',
    ]);
  });

  test('Treffer über das Label (Groß-/Kleinschreibung egal)', () => {
    expect(filterModelle(KATALOG, 'llama').map((m) => m.id)).toEqual(['meta/llama-4']);
    expect(filterModelle(KATALOG, 'GLM').map((m) => m.id)).toEqual(['glm-4.7']);
  });

  test('leerer/Whitespace-Begriff → ganze Liste (kleiner Katalog: einfach Enter)', () => {
    expect(filterModelle(KATALOG, '')).toEqual(KATALOG);
    expect(filterModelle(KATALOG, '   ')).toEqual(KATALOG);
  });

  test('kein Treffer → leere Liste', () => {
    expect(filterModelle(KATALOG, 'mistral')).toEqual([]);
  });
});

describe('begrenzeTreffer — kein Wall-of-Text (gedeckelte Anzeige)', () => {
  test('unter dem Limit: alles anzeigen, kein Rest', () => {
    expect(begrenzeTreffer([1, 2, 3], 30)).toEqual({ angezeigt: [1, 2, 3], restAnzahl: 0 });
  });

  test('über dem Limit: deckeln und Rest melden', () => {
    const viele = Array.from({ length: 45 }, (_, i) => i);
    const { angezeigt, restAnzahl } = begrenzeTreffer(viele, 30);
    expect(angezeigt).toHaveLength(30);
    expect(angezeigt[0]).toBe(0);
    expect(restAnzahl).toBe(15);
  });

  test('Default-Limit ist der exportierte Anzeigedeckel', () => {
    const viele = Array.from({ length: AUSWAHL_ANZEIGE_LIMIT + 7 }, (_, i) => i);
    expect(begrenzeTreffer(viele).restAnzahl).toBe(7);
  });
});

describe('parseAuswahl — Nummern „1,3,7", „alle", leer', () => {
  test('leer/Whitespace → fertig (nichts aus dieser Suche übernehmen)', () => {
    expect(parseAuswahl('', 10)).toEqual({ art: 'fertig' });
    expect(parseAuswahl('   ', 10)).toEqual({ art: 'fertig' });
  });

  test('„alle" (auch groß geschrieben) → alle Treffer', () => {
    expect(parseAuswahl('alle', 10)).toEqual({ art: 'alle' });
    expect(parseAuswahl('ALLE', 10)).toEqual({ art: 'alle' });
  });

  test('Nummern → 0-basierte Indizes in Eingabereihenfolge, dedupliziert', () => {
    expect(parseAuswahl('1,3,7', 10)).toEqual({ art: 'nummern', indizes: [0, 2, 6] });
    expect(parseAuswahl('3, 1, 3', 10)).toEqual({ art: 'nummern', indizes: [2, 0] });
    expect(parseAuswahl('2 4', 10)).toEqual({ art: 'nummern', indizes: [1, 3] });
  });

  test('Nummer außerhalb der Anzeige → ungueltig mit klarer Meldung', () => {
    const ergebnis = parseAuswahl('1,31', 30);
    expect(ergebnis.art).toBe('ungueltig');
    if (ergebnis.art === 'ungueltig') expect(ergebnis.meldung).toContain('31');
  });

  test('Nicht-Zahlen → ungueltig (nichts still verwerfen)', () => {
    expect(parseAuswahl('1,x', 10).art).toBe('ungueltig');
    expect(parseAuswahl('0', 10).art).toBe('ungueltig');
    expect(parseAuswahl('-1', 10).art).toBe('ungueltig');
    expect(parseAuswahl('1.5', 10).art).toBe('ungueltig');
  });
});

describe('parseManuelleIds — kommagetrennter Fallback ohne Listen-Abruf', () => {
  test('trimmt, verwirft Leereinträge, dedupliziert', () => {
    expect(parseManuelleIds(' qwen/qwen3-coder , glm-4.7 ,, glm-4.7 ')).toEqual([
      'qwen/qwen3-coder',
      'glm-4.7',
    ]);
  });

  test('leere Eingabe → leere Liste', () => {
    expect(parseManuelleIds('')).toEqual([]);
    expect(parseManuelleIds(' , ,')).toEqual([]);
  });
});

describe('trenneClaudeIds — das claude-Präfix bleibt reserviert (Proxy-Routing)', () => {
  test('claude-* wird aussortiert und benannt, der Rest bleibt in Reihenfolge', () => {
    expect(trenneClaudeIds(['glm-4.7', 'claude-sonnet-4-5', 'qwen/qwen3-coder'])).toEqual({
      erlaubt: ['glm-4.7', 'qwen/qwen3-coder'],
      verboten: ['claude-sonnet-4-5'],
    });
  });

  test('ohne claude-Kandidaten bleibt verboten leer', () => {
    expect(trenneClaudeIds(['a', 'b'])).toEqual({ erlaubt: ['a', 'b'], verboten: [] });
  });
});

/** Fake-fetch: zeichnet Requests auf und antwortet nach Drehbuch (URL→Antwort). */
function fakeFetch(
  antworten: Record<string, () => Response | Promise<Response>>,
  aufgezeichnet: Array<{ url: string; init: RequestInit }>,
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    aufgezeichnet.push({ url, init });
    const antwort = antworten[url];
    if (antwort === undefined) return new Response('not found', { status: 404 });
    return antwort();
  };
}

const LISTE_OK = JSON.stringify({ data: [{ id: 'glm-4.7', name: 'GLM 4.7' }] });

describe('holeModellListe — dünne fetch-Schale (injizierbar, nie echtes Netz)', () => {
  test('erste Kandidaten-URL liefert die Liste → sie wird zurückgegeben', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const liste = await holeModellListe('https://api.acme.example/v1', 'sk-1', {
      fetchFn: fakeFetch(
        { 'https://api.acme.example/v1/models': () => new Response(LISTE_OK, { status: 200 }) },
        calls,
      ),
    });
    expect(liste).toEqual([{ id: 'glm-4.7', label: 'GLM 4.7' }]);
  });

  test('GET, redirect manual (Token-Leak) und Timeout-Signal sind gesetzt', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await holeModellListe('https://api.acme.example/v1', 'sk-1', {
      fetchFn: fakeFetch(
        { 'https://api.acme.example/v1/models': () => new Response(LISTE_OK, { status: 200 }) },
        calls,
      ),
    });
    const erster = calls[0];
    expect(erster?.init.method).toBe('GET');
    expect(erster?.init.redirect).toBe('manual');
    expect(erster?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('404 auf /models → zweite Kandidaten-URL (/v1/models) wird probiert', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const liste = await holeModellListe('https://api.acme.example', 'sk-1', {
      fetchFn: fakeFetch(
        { 'https://api.acme.example/v1/models': () => new Response(LISTE_OK, { status: 200 }) },
        calls,
      ),
    });
    expect(liste).toEqual([{ id: 'glm-4.7', label: 'GLM 4.7' }]);
    expect(calls.some((c) => c.url === 'https://api.acme.example/models')).toBe(true);
  });

  test('Bearer abgelehnt (401) → die x-api-key-Variante wird noch probiert', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const liste = await holeModellListe('https://api.acme.example/v1', 'sk-1', {
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        const headers = init.headers as Record<string, string>;
        return headers['x-api-key'] === 'sk-1'
          ? new Response(LISTE_OK, { status: 200 })
          : new Response('unauthorized', { status: 401 });
      },
    });
    expect(liste).toEqual([{ id: 'glm-4.7', label: 'GLM 4.7' }]);
  });

  test('alles scheitert (404/Netzfehler/kaputtes JSON) → leere Liste, KEIN Werfen', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const liste = await holeModellListe('https://api.acme.example', 'sk-1', {
      fetchFn: fakeFetch(
        {
          'https://api.acme.example/models': () => new Response('kein json {', { status: 200 }),
          'https://api.acme.example/v1/models': () => {
            throw new Error('ECONNREFUSED');
          },
        },
        calls,
      ),
    });
    expect(liste).toEqual([]);
  });

  test('2xx mit leerer/unbekannter Form zählt nicht als Erfolg — weiter probieren', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const liste = await holeModellListe('https://api.acme.example', 'sk-1', {
      fetchFn: fakeFetch(
        {
          'https://api.acme.example/models': () =>
            new Response(JSON.stringify({ data: [] }), { status: 200 }),
          'https://api.acme.example/v1/models': () => new Response(LISTE_OK, { status: 200 }),
        },
        calls,
      ),
    });
    expect(liste).toEqual([{ id: 'glm-4.7', label: 'GLM 4.7' }]);
  });

  test('der Token taucht in keiner URL auf (nur in Headern)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    await holeModellListe('https://api.acme.example', 'sk-geheim', {
      fetchFn: fakeFetch({}, calls),
    });
    for (const c of calls) expect(c.url).not.toContain('sk-geheim');
  });
});

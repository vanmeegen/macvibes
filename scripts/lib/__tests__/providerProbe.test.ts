/**
 * Format-Erkennung eigener Anbieter — test-first (CLAUDE.md). Die komplette
 * Diagnose-Matrix (Status → Meldung) wird als REINE Logik getestet; die dünne
 * fetch-Schale bekommt einen Fake injiziert — KEIN Test macht echte
 * Netz-Requests.
 */
import { describe, expect, test } from 'bun:test';
import {
  bewerteProben,
  erkenneAnbieterFormat,
  fuehreProbenAus,
  klassifiziereStatus,
  probeRequest,
  probeSpecs,
  PROBE_TIMEOUT_MS,
  type ProbeErgebnis,
} from '../providerProbe';

const BASIS = 'https://api.example.com';

/** Kurzform: Anthropic-Probe mit Status (null = Netzfehler). */
function anth(status: number | null, fehler?: 'timeout' | 'netzfehler'): ProbeErgebnis {
  const basis: ProbeErgebnis = {
    spec: { format: 'anthropic', url: `${BASIS}/v1/messages` },
    status,
  };
  return fehler === undefined ? basis : { ...basis, fehler };
}

/** Kurzform: OpenAI-Probe mit Status; apiBase wählbar (mit/ohne /v1). */
function oai(
  status: number | null,
  apiBase = BASIS,
  fehler?: 'timeout' | 'netzfehler',
): ProbeErgebnis {
  const basis: ProbeErgebnis = {
    spec: { format: 'openai', url: `${apiBase}/chat/completions`, apiBase },
    status,
  };
  return fehler === undefined ? basis : { ...basis, fehler };
}

describe('probeSpecs — Kandidaten-URLs aus der Basis-URL', () => {
  test('Basis ohne /v1 → drei Kandidaten (Anthropic + beide OpenAI-Pfadvarianten)', () => {
    const specs = probeSpecs('https://api.example.com');
    expect(specs).toEqual([
      { format: 'anthropic', url: 'https://api.example.com/v1/messages' },
      {
        format: 'openai',
        url: 'https://api.example.com/chat/completions',
        apiBase: 'https://api.example.com',
      },
      {
        format: 'openai',
        url: 'https://api.example.com/v1/chat/completions',
        apiBase: 'https://api.example.com/v1',
      },
    ]);
  });

  test('abschließende Slashes werden entfernt (Nutzer tippen sie mal mit, mal ohne)', () => {
    expect(probeSpecs('https://api.example.com/')).toEqual(probeSpecs('https://api.example.com'));
  });

  test('Basis MIT /v1 (z. B. OpenRouter) → kein doppeltes /v1, Anthropic ab der Wurzel', () => {
    const specs = probeSpecs('https://openrouter.ai/api/v1');
    // /v1/v1/… wäre sinnlos; die beiden OpenAI-Varianten fallen zusammen (Dedupe).
    expect(specs).toEqual([
      { format: 'anthropic', url: 'https://openrouter.ai/api/v1/messages' },
      {
        format: 'openai',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        apiBase: 'https://openrouter.ai/api/v1',
      },
    ]);
  });
});

describe('probeRequest — Minimal-Requests exakt nach Anbieter-Spezifikation', () => {
  test('Anthropic: x-api-key + anthropic-version, max_tokens: 1', () => {
    const req = probeRequest(
      { format: 'anthropic', url: `${BASIS}/v1/messages` },
      'sk-geheim',
      'mein-modell',
    );
    expect(req.method).toBe('POST');
    expect(req.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-geheim',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.parse(req.body)).toEqual({
      model: 'mein-modell',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  test('OpenAI: Authorization Bearer, gleicher Minimal-Body', () => {
    const req = probeRequest(
      { format: 'openai', url: `${BASIS}/chat/completions`, apiBase: BASIS },
      'sk-geheim',
      'mein-modell',
    );
    expect(req.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-geheim',
    });
    expect(JSON.parse(req.body)).toEqual({
      model: 'mein-modell',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  test('leerer Token → KEIN Auth-Header (Endpunkte ohne Auth, z. B. lokal)', () => {
    const anthReq = probeRequest({ format: 'anthropic', url: `${BASIS}/v1/messages` }, '', 'm');
    expect(anthReq.headers['x-api-key']).toBeUndefined();
    expect(anthReq.headers['anthropic-version']).toBe('2023-06-01');
    const oaiReq = probeRequest(
      { format: 'openai', url: `${BASIS}/chat/completions`, apiBase: BASIS },
      '',
      'm',
    );
    expect(oaiReq.headers['authorization']).toBeUndefined();
  });
});

describe('klassifiziereStatus — die Status-Matrix pro Probe', () => {
  test('2xx → erkannt (Format funktioniert)', () => {
    expect(klassifiziereStatus(200)).toBe('erkannt');
    expect(klassifiziereStatus(201)).toBe('erkannt');
  });
  test('429 → erkannt (Auth + Format verstanden, nur Rate-Limit)', () => {
    expect(klassifiziereStatus(429)).toBe('erkannt');
  });
  test('400 → modell-strittig (Format verstanden, Body/Modell nicht)', () => {
    expect(klassifiziereStatus(400)).toBe('modell-strittig');
  });
  test('401/403 → token-abgelehnt (KEIN Formatproblem!)', () => {
    expect(klassifiziereStatus(401)).toBe('token-abgelehnt');
    expect(klassifiziereStatus(403)).toBe('token-abgelehnt');
  });
  test('404/405 → kein-endpunkt (dieses Format existiert dort nicht)', () => {
    expect(klassifiziereStatus(404)).toBe('kein-endpunkt');
    expect(klassifiziereStatus(405)).toBe('kein-endpunkt');
  });
  test('5xx → unklar (Server kaputt, keine Format-Aussage)', () => {
    expect(klassifiziereStatus(500)).toBe('unklar');
    expect(klassifiziereStatus(502)).toBe('unklar');
  });
});

describe('bewerteProben — Gesamtdiagnose (der Kern der UX)', () => {
  test('Anthropic 2xx → erkannt: Anthropic-kompatibel', () => {
    const diagnose = bewerteProben([anth(200), oai(404), oai(404, `${BASIS}/v1`)]);
    expect(diagnose.art).toBe('anthropic');
    expect(diagnose.meldung).toContain('Anthropic');
  });

  test('OpenAI 2xx auf der /v1-Variante → erkannt mit der RICHTIGEN api_base', () => {
    const diagnose = bewerteProben([anth(404), oai(404), oai(200, `${BASIS}/v1`)]);
    expect(diagnose.art).toBe('openai');
    if (diagnose.art === 'openai') expect(diagnose.apiBase).toBe(`${BASIS}/v1`);
    expect(diagnose.meldung).toContain('OpenAI');
  });

  test('beide Formate 2xx → Anthropic gewinnt (direkt, ohne Übersetzer)', () => {
    const diagnose = bewerteProben([anth(200), oai(200)]);
    expect(diagnose.art).toBe('anthropic');
  });

  test('401 ist KEIN Formatproblem: Meldung nennt den Token, nicht das Format', () => {
    const diagnose = bewerteProben([anth(401), oai(404), oai(404, `${BASIS}/v1`)]);
    expect(diagnose.art).toBe('token-abgelehnt');
    if (diagnose.art === 'token-abgelehnt') {
      expect(diagnose.status).toBe(401);
      // Starkes Indiz: NUR der Anthropic-Pfad hat den Request verstanden.
      expect(diagnose.format).toBe('anthropic');
    }
    expect(diagnose.meldung).toContain('Token');
    expect(diagnose.meldung).toContain('401');
    expect(diagnose.meldung.toLowerCase()).not.toContain('format nicht erkannt');
  });

  test('401 auf BEIDEN Formaten → token-abgelehnt ohne Format-Festlegung', () => {
    const diagnose = bewerteProben([anth(401), oai(401)]);
    expect(diagnose.art).toBe('token-abgelehnt');
    if (diagnose.art === 'token-abgelehnt') expect(diagnose.format).toBeNull();
  });

  test('2xx schlägt 401: funktionierendes Format gewinnt gegen abgelehnten Kandidaten', () => {
    const diagnose = bewerteProben([anth(401), oai(200)]);
    expect(diagnose.art).toBe('openai');
  });

  test('400 → Format erkannt, aber Modell/Anfrage strittig (Modell-ID prüfen)', () => {
    const diagnose = bewerteProben([anth(404), oai(400, `${BASIS}/v1`)]);
    expect(diagnose.art).toBe('modell-strittig');
    if (diagnose.art === 'modell-strittig') {
      expect(diagnose.format).toBe('openai');
      expect(diagnose.apiBase).toBe(`${BASIS}/v1`);
      expect(diagnose.status).toBe(400);
    }
    expect(diagnose.meldung).toContain('Modell');
  });

  test('400 schlägt 401 (Format+Token nachweislich ok, nur das Modell strittig)', () => {
    const diagnose = bewerteProben([anth(401), oai(400)]);
    expect(diagnose.art).toBe('modell-strittig');
    if (diagnose.art === 'modell-strittig') expect(diagnose.format).toBe('openai');
  });

  test('alles Netzfehler → nicht erreichbar (URL/Netz, kein Format-Urteil)', () => {
    const diagnose = bewerteProben([
      anth(null, 'netzfehler'),
      oai(null, BASIS, 'netzfehler'),
      oai(null, `${BASIS}/v1`, 'netzfehler'),
    ]);
    expect(diagnose.art).toBe('nicht-erreichbar');
    expect(diagnose.meldung.toLowerCase()).toContain('nicht erreichbar');
  });

  test('alles Timeouts → nicht erreichbar, Meldung nennt die Zeitüberschreitung', () => {
    const diagnose = bewerteProben([anth(null, 'timeout'), oai(null, BASIS, 'timeout')]);
    expect(diagnose.art).toBe('nicht-erreichbar');
    expect(diagnose.meldung).toContain('Zeitüberschreitung');
  });

  test('überall 404 → kein Format gefunden, Meldung nennt die Statuscodes', () => {
    const diagnose = bewerteProben([anth(404), oai(404), oai(404, `${BASIS}/v1`)]);
    expect(diagnose.art).toBe('kein-format');
    expect(diagnose.meldung).toContain('404');
  });

  test('Mischung 404 + Netzfehler → kein-format (Server antwortet ja teilweise)', () => {
    const diagnose = bewerteProben([anth(404), oai(null, BASIS, 'netzfehler')]);
    expect(diagnose.art).toBe('kein-format');
  });

  test('nur 5xx → kein-format mit Statuscode in der Meldung (Fehler nie verschlucken)', () => {
    const diagnose = bewerteProben([anth(500), oai(502)]);
    expect(diagnose.art).toBe('kein-format');
    expect(diagnose.meldung).toContain('500');
    expect(diagnose.meldung).toContain('502');
  });
});

/** Fake-fetch: antwortet je URL mit Status oder wirft — zeichnet Aufrufe auf. */
function fakeFetch(statusFuer: Record<string, number | Error>) {
  const aufrufe: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (url: string, init: RequestInit): Promise<Response> => {
    aufrufe.push({ url, init });
    const antwort = statusFuer[url];
    if (antwort === undefined) return Promise.reject(new TypeError('Unable to connect'));
    if (antwort instanceof Error) return Promise.reject(antwort);
    return Promise.resolve(new Response('{}', { status: antwort }));
  };
  return { fetchFn, aufrufe };
}

describe('fuehreProbenAus — dünne Schale mit injiziertem fetch (kein echtes Netz)', () => {
  test('fragt alle Kandidaten ab und liefert deren Status', async () => {
    const { fetchFn, aufrufe } = fakeFetch({
      [`${BASIS}/v1/messages`]: 404,
      [`${BASIS}/chat/completions`]: 404,
      [`${BASIS}/v1/chat/completions`]: 200,
    });
    const ergebnisse = await fuehreProbenAus(BASIS, 'sk-geheim', 'mein-modell', { fetchFn });
    expect(ergebnisse.map((e) => e.status)).toEqual([404, 404, 200]);
    expect(aufrufe).toHaveLength(3);
    // Jeder Request trägt ein Abort-Signal (Timeout — nichts darf hängen).
    for (const { init } of aufrufe) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('Timeout wird von anderen Netzfehlern unterschieden', async () => {
    const timeoutFehler = new Error('The operation timed out.');
    timeoutFehler.name = 'TimeoutError';
    const { fetchFn } = fakeFetch({
      [`${BASIS}/v1/messages`]: timeoutFehler,
      // die beiden OpenAI-URLs fehlen → TypeError (Netzfehler)
    });
    const ergebnisse = await fuehreProbenAus(BASIS, 'sk-geheim', 'm', { fetchFn });
    expect(ergebnisse[0]?.fehler).toBe('timeout');
    expect(ergebnisse[0]?.status).toBeNull();
    expect(ergebnisse[1]?.fehler).toBe('netzfehler');
    expect(ergebnisse[1]?.fehlerDetail).toContain('Unable to connect');
  });

  test('der Token steht NUR im Header — nie in Ergebnissen oder Diagnosen', async () => {
    const { fetchFn, aufrufe } = fakeFetch({});
    const ergebnisse = await fuehreProbenAus(BASIS, 'sk-SUPERGEHEIM', 'm', { fetchFn });
    expect(JSON.stringify(ergebnisse)).not.toContain('sk-SUPERGEHEIM');
    expect(JSON.stringify(bewerteProben(ergebnisse))).not.toContain('sk-SUPERGEHEIM');
    // … aber die Requests selbst tragen ihn (sonst wäre 401 garantiert).
    const anthAufruf = aufrufe.find((a) => a.url.endsWith('/v1/messages'));
    expect(new Headers(anthAufruf?.init.headers).get('x-api-key')).toBe('sk-SUPERGEHEIM');
  });

  test('Default-Timeout ist 10 s pro Probe', () => {
    expect(PROBE_TIMEOUT_MS).toBe(10_000);
  });
});

describe('erkenneAnbieterFormat — Probe + Auswertung zusammengesteckt', () => {
  test('OpenRouter-artiger Endpunkt (nur /v1/chat/completions) wird als OpenAI erkannt', async () => {
    const basis = 'https://openrouter.ai/api/v1';
    const { fetchFn } = fakeFetch({
      [`${basis}/messages`]: 404,
      [`${basis}/chat/completions`]: 200,
    });
    const diagnose = await erkenneAnbieterFormat(basis, 'sk-or', 'qwen/qwen3-coder', { fetchFn });
    expect(diagnose.art).toBe('openai');
    if (diagnose.art === 'openai') expect(diagnose.apiBase).toBe(basis);
  });

  test('Anthropic-Shim mit falschem Token → token-abgelehnt mit Format-Indiz', async () => {
    const { fetchFn } = fakeFetch({
      [`${BASIS}/v1/messages`]: 401,
      [`${BASIS}/chat/completions`]: 404,
      [`${BASIS}/v1/chat/completions`]: 404,
    });
    const diagnose = await erkenneAnbieterFormat(BASIS, 'sk-falsch', 'm', { fetchFn });
    expect(diagnose.art).toBe('token-abgelehnt');
    if (diagnose.art === 'token-abgelehnt') expect(diagnose.format).toBe('anthropic');
  });
});

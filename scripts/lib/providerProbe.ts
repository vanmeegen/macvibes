/**
 * Format-Erkennung für eigene Modell-Anbieter (`bun run setup`).
 *
 * Der Nutzer gibt nur Anzeigename, Basis-URL, Token und Modell-ID an — ob der
 * Endpunkt Anthropics `/v1/messages` oder OpenAIs `/chat/completions` spricht,
 * ermittelt diese Probe selbst: je EIN Minimal-Request (`max_tokens: 1`, kostet
 * praktisch nichts) pro Kandidat. Die AUSWERTUNG (HTTP-Status/Fehler →
 * Klartext-Diagnose) ist eine reine Funktion und voll getestet; nur
 * `fuehreProbenAus` macht echtes fetch (injizierbar — Tests machen NIE echte
 * Netz-Requests).
 *
 * Diagnose-Matrix pro Probe (klassifiziereStatus):
 *   2xx / 429 → erkannt          (Format funktioniert; 429 = nur Rate-Limit)
 *   400       → modell-strittig  (Format verstanden, Body/Modell nicht)
 *   401 / 403 → token-abgelehnt  (KEIN Formatproblem — der Endpunkt hat den
 *                                 Request verstanden und nur die Auth verworfen;
 *                                 starkes Indiz, dass er DIESES Format spricht)
 *   404 / 405 → kein-endpunkt    (dieser Pfad/dieses Format existiert dort nicht)
 *   sonst     → unklar           (z. B. 5xx — keine Format-Aussage)
 *   Netzfehler/Timeout → nicht erreichbar (URL/Netz, getrennt gemeldet)
 *
 * Der Token wird ausschließlich in Request-Header gesetzt und taucht in keiner
 * Diagnose, keinem Fehlerdetail und keinem Log auf.
 */

export type ProbeFormat = 'anthropic' | 'openai';

/** Ein Probe-Kandidat: welches Format, welche konkrete URL. */
export interface ProbeSpec {
  format: ProbeFormat;
  /** Vollständige Probe-URL (z. B. …/v1/messages). */
  url: string;
  /** Nur openai: die api_base, die LiteLLM bei Erfolg braucht. */
  apiBase?: string;
}

/** Fertig gebauter Minimal-Request (die dünne Schale schickt ihn nur ab). */
export interface ProbeRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** Ergebnis einer einzelnen Probe: Status oder klar benannter Netzfehler. */
export interface ProbeErgebnis {
  spec: ProbeSpec;
  /** HTTP-Status; null bei Netzfehler/Timeout. */
  status: number | null;
  fehler?: 'timeout' | 'netzfehler';
  /** Fehlermeldung des fetch (enthält nie den Token — der steht nur im Header). */
  fehlerDetail?: string;
}

export type StatusKlasse =
  'erkannt' | 'modell-strittig' | 'token-abgelehnt' | 'kein-endpunkt' | 'weiterleitung' | 'unklar';

/** Klartext-Diagnose fürs Setup — `meldung` ist die nutzerfertige Erklärung. */
export type FormatDiagnose =
  | { art: 'anthropic'; meldung: string }
  | { art: 'openai'; apiBase: string; meldung: string }
  | {
      art: 'modell-strittig';
      format: ProbeFormat;
      apiBase?: string;
      status: number;
      meldung: string;
    }
  | { art: 'token-abgelehnt'; format: ProbeFormat | null; status: number; meldung: string }
  | { art: 'nicht-erreichbar'; meldung: string }
  | { art: 'kein-format'; meldung: string };

/** Timeout pro Probe — nichts darf hängen. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Kandidaten-URLs aus der Basis-URL. Nutzer geben die Basis mal mit, mal ohne
 * `/v1` an — deshalb werden für OpenAI BEIDE Pfadvarianten probiert. Endet die
 * Basis schon auf `/v1`, wird für den Anthropic-Kandidaten die Wurzel davor
 * genutzt (kein sinnloses `/v1/v1/messages`), und die beiden OpenAI-Varianten
 * fallen zusammen (Dedupe über die URL).
 */
export function probeSpecs(baseUrl: string): ProbeSpec[] {
  const basis = baseUrl.trim().replace(/\/+$/, '');
  const wurzel = basis.endsWith('/v1') ? basis.slice(0, -'/v1'.length) : basis;
  const kandidaten: ProbeSpec[] = [
    { format: 'anthropic', url: `${wurzel}/v1/messages` },
    { format: 'openai', url: `${basis}/chat/completions`, apiBase: basis },
    { format: 'openai', url: `${wurzel}/v1/chat/completions`, apiBase: `${wurzel}/v1` },
  ];
  const gesehen = new Set<string>();
  return kandidaten.filter((spec) => {
    if (gesehen.has(spec.url)) return false;
    gesehen.add(spec.url);
    return true;
  });
}

/**
 * Der Minimal-Request pro Kandidat — exakt die Header, die der jeweilige
 * API-Stil verlangt (Anthropic: x-api-key + anthropic-version; OpenAI:
 * Authorization Bearer). Leerer Token → kein Auth-Header (lokale Endpunkte
 * ohne Auth sollen nicht an einem leeren Bearer scheitern).
 */
export function probeRequest(spec: ProbeSpec, token: string, modelId: string): ProbeRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (spec.format === 'anthropic') {
    if (token !== '') headers['x-api-key'] = token;
    headers['anthropic-version'] = '2023-06-01';
  } else if (token !== '') {
    headers['authorization'] = `Bearer ${token}`;
  }
  return {
    url: spec.url,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  };
}

/** Die Status-Matrix pro Probe (s. Modul-Kommentar). */
export function klassifiziereStatus(status: number): StatusKlasse {
  if (status >= 200 && status < 300) return 'erkannt';
  if (status === 429) return 'erkannt';
  if (status === 400) return 'modell-strittig';
  if (status === 401 || status === 403) return 'token-abgelehnt';
  if (status === 404 || status === 405) return 'kein-endpunkt';
  // 3xx: wir folgen bewusst nicht (Token-Leak, s. fuehreProbenAus). Ehrlich
  // melden statt still scheitern — der Nutzer soll die Ziel-URL angeben.
  if (status >= 300 && status < 400) return 'weiterleitung';
  return 'unklar';
}

/** Menschenlesbarer Name eines Formats für die Klartext-Meldungen. */
function formatName(format: ProbeFormat): string {
  return format === 'anthropic' ? 'Anthropic-kompatibel (/v1/messages)' : 'OpenAI-kompatibel';
}

/**
 * Gesamtdiagnose über alle Proben — der Kern der guten UX. Vorrang:
 *   1. Ein 2xx/429 → Format erkannt. Antworten BEIDE Formate, gewinnt
 *      Anthropic (direkte Anbindung ohne Übersetzer schlägt den Umweg).
 *   2. Ein 400 → Format verstanden, Modell/Anfrage strittig (Modell-ID prüfen).
 *      Schlägt 401 anderswo: 400 beweist, dass Format UND Token akzeptiert sind.
 *   3. Ein 401/403 → Token abgelehnt — ausdrücklich KEIN „Format nicht
 *      erkannt". Kam es nur von EINEM Format, wird das als Indiz mitgemeldet.
 *   4. ALLE Proben Netzfehler/Timeout → nicht erreichbar (URL/Netz).
 *   5. Sonst (404/405/5xx-Mischung) → kein Format gefunden; alle Statuscodes
 *      werden genannt (Fehler nie verschlucken).
 */
export function bewerteProben(ergebnisse: ProbeErgebnis[]): FormatDiagnose {
  const mitStatus = ergebnisse.filter(
    (e): e is ProbeErgebnis & { status: number } => e.status !== null,
  );

  const erkannt = mitStatus.filter((e) => klassifiziereStatus(e.status) === 'erkannt');
  const erkanntAnthropic = erkannt.find((e) => e.spec.format === 'anthropic');
  if (erkanntAnthropic !== undefined) {
    return {
      art: 'anthropic',
      meldung:
        'Erkannt: Anthropic-kompatibel (/v1/messages) — wird direkt angebunden, ohne Übersetzer.',
    };
  }
  const erkanntOpenai = erkannt.find((e) => e.spec.format === 'openai');
  if (erkanntOpenai !== undefined) {
    return {
      art: 'openai',
      apiBase: erkanntOpenai.spec.apiBase ?? '',
      meldung: `Erkannt: OpenAI-kompatibel (${erkanntOpenai.spec.url}) — wird über den mitgelieferten Übersetzer (LiteLLM-Router) geführt.`,
    };
  }

  const strittig =
    mitStatus.find(
      (e) => e.spec.format === 'anthropic' && klassifiziereStatus(e.status) === 'modell-strittig',
    ) ?? mitStatus.find((e) => klassifiziereStatus(e.status) === 'modell-strittig');
  if (strittig !== undefined) {
    const basis = {
      art: 'modell-strittig' as const,
      format: strittig.spec.format,
      status: strittig.status,
      meldung:
        `Format erkannt (${formatName(strittig.spec.format)}), aber der Endpunkt lehnt die Anfrage ab ` +
        `(HTTP ${strittig.status}) — vermutlich stimmt die Modell-ID nicht. Bitte prüfen.`,
    };
    return strittig.spec.apiBase === undefined
      ? basis
      : { ...basis, apiBase: strittig.spec.apiBase };
  }

  const abgelehnt = mitStatus.filter((e) => klassifiziereStatus(e.status) === 'token-abgelehnt');
  const abgelehntErster = abgelehnt[0];
  if (abgelehntErster !== undefined) {
    const formate = new Set(abgelehnt.map((e) => e.spec.format));
    const format = formate.size === 1 ? abgelehntErster.spec.format : null;
    const status = abgelehntErster.status;
    const indiz =
      format === null
        ? ''
        : ` Der Endpunkt scheint ${formatName(format)} zu sprechen (er hat den Request verstanden und nur die Auth verworfen).`;
    return {
      art: 'token-abgelehnt',
      format,
      status,
      meldung: `Token wurde abgelehnt (HTTP ${status}) — bitte prüfen. Das ist kein Formatproblem.${indiz}`,
    };
  }

  // Weiterleitung: Wir folgen bewusst nicht (der Token ginge sonst an das
  // fremde Ziel). Statt „kein Format gefunden" zu melden — was den Nutzer an
  // der falschen Stelle suchen liesse — sagen wir klar, was zu tun ist.
  const umgeleitet = mitStatus.filter((e) => klassifiziereStatus(e.status) === 'weiterleitung');
  const umgeleitetErster = umgeleitet[0];
  if (umgeleitetErster !== undefined) {
    return {
      art: 'kein-format',
      meldung:
        `Die URL leitet weiter (HTTP ${umgeleitetErster.status}). Aus Sicherheitsgründen folgen ` +
        `wir dem nicht — der Token würde sonst an das Weiterleitungsziel geschickt. ` +
        `Bitte die endgültige Ziel-URL direkt angeben.`,
    };
  }

  if (mitStatus.length === 0) {
    const nurTimeouts = ergebnisse.every((e) => e.fehler === 'timeout');
    return {
      art: 'nicht-erreichbar',
      meldung: nurTimeouts
        ? `Endpunkt nicht erreichbar: Zeitüberschreitung (${PROBE_TIMEOUT_MS / 1000} s pro Probe) — URL und Netz prüfen.`
        : 'Endpunkt nicht erreichbar (Netzfehler) — URL und Netz prüfen.',
    };
  }

  const details = ergebnisse
    .map((e) =>
      e.status === null
        ? `${e.spec.url}: ${e.fehler === 'timeout' ? 'Zeitüberschreitung' : 'Netzfehler'}`
        : `${e.spec.url}: HTTP ${e.status}`,
    )
    .join(', ');
  return {
    art: 'kein-format',
    meldung: `Kein unterstütztes Format gefunden — weder /v1/messages noch /chat/completions antworten brauchbar (${details}).`,
  };
}

/** Injizierbare fetch-Naht — Tests reichen hier einen Fake herein. */
export interface ProbeOptionen {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/**
 * Dünne Netz-Schale: schickt die Minimal-Requests ab (parallel, je mit
 * Abort-Timeout) und übersetzt fetch-Fehler in klar benannte Ergebnisse.
 * Fehler werden NIE verschluckt (fehlerDetail), der Token NIE aufgenommen.
 */
export async function fuehreProbenAus(
  baseUrl: string,
  token: string,
  modelId: string,
  optionen: ProbeOptionen = {},
): Promise<ProbeErgebnis[]> {
  const fetchFn = optionen.fetchFn ?? ((url, init) => fetch(url, init));
  const timeoutMs = optionen.timeoutMs ?? PROBE_TIMEOUT_MS;
  return Promise.all(
    probeSpecs(baseUrl).map(async (spec): Promise<ProbeErgebnis> => {
      const request = probeRequest(spec, token, modelId);
      try {
        const antwort = await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          // KEINEN Weiterleitungen folgen — sonst leckt der Token. `fetch` folgt
          // 3xx standardmässig, und während `authorization` beim Hostwechsel
          // spec-konform gestrippt wird, bleibt der Anthropic-Header
          // `x-api-key` als Custom-Header erhalten und ginge im Klartext an
          // das fremde Redirect-Ziel (empirisch reproduziert). Eine 3xx-Antwort
          // melden wir stattdessen ehrlich: der Nutzer soll die Ziel-URL
          // direkt angeben.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Body nicht gebraucht — nur der Status zählt; aufräumen, damit keine
        // offene Verbindung liegen bleibt (Fehler dabei sind egal).
        await antwort.body?.cancel().catch(() => {});
        return { spec, status: antwort.status };
      } catch (error) {
        const istTimeout =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return {
          spec,
          status: null,
          fehler: istTimeout ? 'timeout' : 'netzfehler',
          fehlerDetail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        };
      }
    }),
  );
}

/** Probe + Auswertung zusammengesteckt — der eine Aufruf fürs Setup. */
export async function erkenneAnbieterFormat(
  baseUrl: string,
  token: string,
  modelId: string,
  optionen: ProbeOptionen = {},
): Promise<FormatDiagnose> {
  return bewerteProben(await fuehreProbenAus(baseUrl, token, modelId, optionen));
}

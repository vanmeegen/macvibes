/**
 * Modell-Katalog eines eigenen Anbieters (`bun run setup`).
 *
 * Das Modell wird pro Chat im Dropdown gewählt — deshalb bindet das Setup pro
 * Anbieter eine LISTE von Modellen an, nicht eines. Die Liste holt es sich per
 * `GET /models` beim Anbieter selbst (OpenRouter, OpenAI und Anthropic
 * antworten praktisch gleich: `{ data: [ { id, name?, display_name? } ] }`).
 * Hier lebt die REINE Logik: Kandidaten-URLs (dieselbe Wurzel-/v1-Logik wie
 * providerProbe.probeSpecs), beide Auth-Varianten (welche der Endpunkt
 * akzeptiert, weiß man vorher nicht), defensives Parsen, Filtern und das
 * Auswahl-Parsing („1,3,7" / „alle" / leer). Nur `holeModellListe` macht
 * fetch — injizierbar, Tests machen NIE echte Netz-Requests.
 *
 * Sicherheitsregeln wie bei der Format-Probe (providerProbe.ts):
 *   - `redirect: 'manual'` — fetch folgt 3xx sonst automatisch, und der
 *     Custom-Header `x-api-key` ginge im Klartext an das Redirect-Ziel.
 *   - Timeout pro Request — nichts darf hängen.
 *   - Der Token steht ausschließlich in Request-Headern und taucht in keiner
 *     Rückgabe, keinem Fehler und keinem Log auf.
 * Scheitert der Abruf (404, Auth, Netz, unbekannte Form), ist das KEIN
 * Abbruch: leere Liste → die Schale fällt auf manuelle Eingabe zurück.
 */

/** Ein Modell aus der Anbieter-Liste: id + menschenlesbares Label. */
export interface ModellKandidat {
  id: string;
  label: string;
}

/** Fertig gebauter Listen-Request (die dünne Schale schickt ihn nur ab). */
export interface ModellListenRequest {
  url: string;
  headers: Record<string, string>;
}

/** Ergebnis des Auswahl-Parsings an der Treffer-Anzeige. */
export type AuswahlErgebnis =
  | { art: 'fertig' }
  | { art: 'alle' }
  | { art: 'nummern'; indizes: number[] }
  | { art: 'ungueltig'; meldung: string };

/** Timeout pro Listen-Request — wie bei der Probe: nichts darf hängen. */
export const MODELLLISTE_TIMEOUT_MS = 10_000;

/**
 * Anzeigedeckel für Treffer: OpenRouter liefert hunderte Modelle — mehr als
 * ~30 nummerierte Zeilen sind am Prompt nicht mehr überblickbar (Wall-of-Text);
 * der Rest wird als Anzahl gemeldet und über einen schärferen Filter erreicht.
 */
export const AUSWAHL_ANZEIGE_LIMIT = 30;

/**
 * Kandidaten-URLs für die Modell-Liste — dieselbe Wurzel-/v1-Logik wie
 * probeSpecs: Nutzer geben die Basis mal mit, mal ohne `/v1` an, deshalb
 * werden `<basis>/models` UND `<wurzel>/v1/models` probiert (Dedupe, wenn
 * beide zusammenfallen).
 */
export function modelListUrls(baseUrl: string): string[] {
  const basis = baseUrl.trim().replace(/\/+$/, '');
  const wurzel = basis.endsWith('/v1') ? basis.slice(0, -'/v1'.length) : basis;
  return [...new Set([`${basis}/models`, `${wurzel}/v1/models`])];
}

/**
 * Beide Auth-Varianten pro URL: OpenAI-Stil (`authorization: Bearer`) und
 * Anthropic-Stil (`x-api-key` + `anthropic-version`) — welche der Endpunkt
 * akzeptiert, weiß man vor der Format-Probe nicht. Leerer Token → keine
 * Auth-Header (lokale Endpunkte ohne Auth sollen nicht an einem leeren
 * Bearer scheitern); die Anthropic-Variante behält den Versions-Header.
 */
export function modelListRequests(url: string, token: string): ModellListenRequest[] {
  const bearer: Record<string, string> = token === '' ? {} : { authorization: `Bearer ${token}` };
  const anthropic: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (token !== '') anthropic['x-api-key'] = token;
  return [
    { url, headers: bearer },
    { url, headers: anthropic },
  ];
}

/**
 * Antwort der Anbieter defensiv parsen. OpenRouter, OpenAI und Anthropic
 * liefern `{ data: [ { id, name?, display_name? } ] }` — übernommen werden nur
 * Einträge mit nichtleerer String-`id`; das Label kommt aus `name` bzw.
 * `display_name` (Anthropic) und fällt sonst auf die id zurück. Unbekannte
 * Formen ergeben eine LEERE Liste, es wird nie geworfen — die Schale fällt
 * dann auf manuelle Eingabe zurück.
 */
export function parseModelList(body: unknown): ModellKandidat[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const gesehen = new Set<string>();
  const kandidaten: ModellKandidat[] = [];
  for (const eintrag of data) {
    if (typeof eintrag !== 'object' || eintrag === null) continue;
    const { id, name, display_name: displayName } = eintrag as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || gesehen.has(id)) continue;
    gesehen.add(id);
    const label =
      typeof name === 'string' && name.trim() !== ''
        ? name
        : typeof displayName === 'string' && displayName.trim() !== ''
          ? displayName
          : id;
    kandidaten.push({ id, label });
  }
  return kandidaten;
}

/**
 * Suchbegriff case-insensitiv auf id UND Label anwenden. Leerer Begriff →
 * ganze Liste (kleine Kataloge, z. B. ein lokaler Shim: einfach Enter drücken).
 */
export function filterModelle(liste: ModellKandidat[], begriff: string): ModellKandidat[] {
  const b = begriff.trim().toLowerCase();
  if (b === '') return liste;
  return liste.filter((m) => m.id.toLowerCase().includes(b) || m.label.toLowerCase().includes(b));
}

/** Treffer für die Anzeige deckeln — der Rest wird nur als Anzahl gemeldet. */
export function begrenzeTreffer<T>(
  treffer: T[],
  limit: number = AUSWAHL_ANZEIGE_LIMIT,
): { angezeigt: T[]; restAnzahl: number } {
  return { angezeigt: treffer.slice(0, limit), restAnzahl: Math.max(0, treffer.length - limit) };
}

/**
 * Auswahl-Eingabe an der nummerierten Treffer-Anzeige parsen:
 *   - leer            → fertig (nichts aus dieser Suche übernehmen)
 *   - „alle"          → alle Treffer dieser Suche (auch die über dem Deckel)
 *   - „1,3,7" / „2 4" → 0-basierte Indizes in Eingabereihenfolge, dedupliziert
 * Ungültiges (Nicht-Zahl, 0, außerhalb der Anzeige) wird klar gemeldet statt
 * still verworfen — sonst glaubt der Nutzer, ein Modell übernommen zu haben.
 */
export function parseAuswahl(eingabe: string, angezeigtAnzahl: number): AuswahlErgebnis {
  const e = eingabe.trim();
  if (e === '') return { art: 'fertig' };
  if (e.toLowerCase() === 'alle') return { art: 'alle' };
  const indizes: number[] = [];
  for (const teil of e.split(/[\s,]+/).filter((t) => t !== '')) {
    if (!/^[0-9]+$/.test(teil)) {
      return { art: 'ungueltig', meldung: `„${teil}" ist keine Nummer aus der Anzeige.` };
    }
    const nummer = Number(teil);
    if (nummer < 1 || nummer > angezeigtAnzahl) {
      return {
        art: 'ungueltig',
        meldung: `Nummer ${nummer} liegt außerhalb der Anzeige (1–${angezeigtAnzahl}).`,
      };
    }
    if (!indizes.includes(nummer - 1)) indizes.push(nummer - 1);
  }
  return { art: 'nummern', indizes };
}

/** Kommagetrennte Modell-IDs (manueller Fallback): trimmen, dedupen. */
export function parseManuelleIds(eingabe: string): string[] {
  const gesehen = new Set<string>();
  const ids: string[] = [];
  for (const teil of eingabe.split(',')) {
    const id = teil.trim();
    if (id === '' || gesehen.has(id)) continue;
    gesehen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Das `claude`-Präfix bleibt für eigene Anbieter verboten: der Credential-Proxy
 * routet solche ids IMMER an die Anthropic-API — ein eigener Anbieter käme nie
 * an den Request (agentModel.ts lehnt solche Einträge beim Laden ohnehin ab).
 * Statt einer Ablehnungs-Schleife pro Eingabe werden die verbotenen ids hier
 * aussortiert und der Schale zum Melden zurückgegeben.
 */
export function trenneClaudeIds(ids: string[]): { erlaubt: string[]; verboten: string[] } {
  const erlaubt: string[] = [];
  const verboten: string[] = [];
  for (const id of ids) (id.startsWith('claude') ? verboten : erlaubt).push(id);
  return { erlaubt, verboten };
}

/** Injizierbare fetch-Naht — Tests reichen hier einen Fake herein. */
export interface ModellListenOptionen {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/**
 * Dünne Netz-Schale: probiert die Kandidaten-URLs × Auth-Varianten der Reihe
 * nach (sequenziell — kein Hämmern auf den Anbieter) und gibt die ERSTE
 * nichtleere, parsebare Liste zurück. Jeder Fehlschlag (Status ≠ 2xx,
 * Netzfehler, Timeout, kaputtes/unbekanntes JSON) führt nur zum nächsten
 * Kandidaten; am Ende bedeutet die leere Liste: manuell eingeben. Es wird nie
 * geworfen und der Token nie in eine Ausgabe aufgenommen.
 */
export async function holeModellListe(
  baseUrl: string,
  token: string,
  optionen: ModellListenOptionen = {},
): Promise<ModellKandidat[]> {
  const fetchFn = optionen.fetchFn ?? ((url, init) => fetch(url, init));
  const timeoutMs = optionen.timeoutMs ?? MODELLLISTE_TIMEOUT_MS;
  for (const url of modelListUrls(baseUrl)) {
    for (const request of modelListRequests(url, token)) {
      try {
        const antwort = await fetchFn(request.url, {
          method: 'GET',
          headers: request.headers,
          // KEINEN Weiterleitungen folgen — sonst leckt der Token (x-api-key
          // bleibt als Custom-Header über den Hostwechsel erhalten, s. Probe).
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (antwort.status < 200 || antwort.status >= 300) {
          // Body aufräumen, damit keine offene Verbindung liegen bleibt.
          await antwort.body?.cancel().catch(() => {});
          continue;
        }
        const liste = parseModelList(await antwort.json().catch(() => null));
        if (liste.length > 0) return liste;
      } catch {
        // Netzfehler/Timeout: bewusst nur weiterprobieren — der Listen-Abruf
        // ist Komfort, der Fallback (manuelle Eingabe) fängt alles auf.
      }
    }
  }
  return [];
}

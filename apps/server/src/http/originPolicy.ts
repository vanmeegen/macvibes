/**
 * Origin-Politik für die GraphQL-API (F5, F6).
 *
 * Ausgangslage: `createYoga` ohne `cors`-Option spiegelt JEDE Origin und setzt
 * `Allow-Credentials: true`; zugleich gab es keine CSRF-Prüfung. Weil die
 * Preview auf Port 4173 same-site zur App auf 4000 ist, greift `SameSite=Lax`
 * nicht — vom Agenten geschriebenes JavaScript konnte also Mutationen mit dem
 * Session-Cookie des Betrachters fahren und die Antworten lesen.
 */

export interface OriginPolicyInput {
  /** `Host`-Header des Requests — daraus leitet sich die eigene Origin ab. */
  host: string | null;
  /** Zusätzlich erlaubte Origins (MACVIBES_ALLOWED_ORIGINS, kommagetrennt). */
  configured: string[];
  /** Dev-Modus: der Vite-Server läuft auf einem eigenen Port. */
  devWebPort: number | null;
}

/**
 * Erlaubte Origins für einen Request.
 *
 * Die eigene Origin wird aus dem `Host`-Header abgeleitet, NICHT hart auf
 * localhost gesetzt — sonst stirbt der LAN-Zugriff über `http://<mac>.local`
 * oder die IP. Beide Schemata sind erlaubt, weil TLS optional vor dem Server
 * terminiert (Caddy) und derselbe Server auch im Klartext erreichbar ist.
 */
export function allowedOrigins(input: OriginPolicyInput): string[] {
  const origins = new Set<string>(input.configured.filter((o) => o.length > 0));
  const host = input.host?.trim() ?? '';
  if (host.length > 0) {
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
    // Im Dev proxied Vite /graphql mit changeOrigin: der Host wird zu
    // localhost:4000, die Origin bleibt aber der Vite-Port. Ohne diesen
    // Eintrag wäre `bun run dev` tot.
    const hostname = host.split(':')[0] ?? '';
    if (input.devWebPort !== null && hostname.length > 0) {
      origins.add(`http://${hostname}:${input.devWebPort}`);
      origins.add(`https://${hostname}:${input.devWebPort}`);
    }
  }
  return [...origins];
}

export interface CsrfInput {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  allowed: string[];
}

/**
 * Ist das ein Cross-Site-Zugriff, der abgelehnt werden muss?
 *
 * Zwei Signale, weil beide für sich Lücken haben: `Sec-Fetch-Site` ist
 * eindeutig, fehlt aber in älteren Clients; `Origin` fehlt bei manchen
 * same-origin-GETs. Fehlen beide, lassen wir durch — sonst wären
 * Kommandozeilen-Clients (curl, Tests) ausgesperrt, die ohnehin kein
 * Ambient-Cookie mitbringen.
 */
export function isCrossSiteRequest(input: CsrfInput): boolean {
  if (input.secFetchSite === 'cross-site') return true;
  if (input.origin !== null && input.origin !== 'null') {
    return !input.allowed.includes(input.origin);
  }
  return false;
}

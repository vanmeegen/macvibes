import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Der In-VM-Daemon ist ein eigenes Artefakt: er wird gebündelt, in die MicroVM
 * gemountet und läuft dort — auf der anderen Seite der Sicherheitsgrenze.
 *
 * Trotzdem importierte er host-seitige Sandbox-Module (`sandbox/monitStatus`,
 * `sandbox/httpProbe`, `sandbox/provider`). Damit reichte der Abhängigkeitsgraph
 * des VM-Bundles in genau die Schicht hinein, die den Host verwaltet: Provider,
 * Ports, VM-Tokens, msb-Client. Heute zieht der Bundler davon nur die
 * verwendeten Funktionen mit; eine spätere Änderung an einem dieser Module
 * — ein Import von `msbClient` in `provider.ts` genügt — schleppt Host-Code in
 * die VM, ohne dass es jemandem auffällt.
 *
 * Dieser Test ist die Fitnessfunktion dazu: er hält die Grenze fest, statt sie
 * einer Konvention zu überlassen. Als WHITELIST, nicht als Blacklist: eine
 * Verbotsliste (früher: nur `sandbox/`) hätte einen künftigen Import von
 * `../agentGateway`, `../../core/*` oder `../../services/*` — alles Host-Code —
 * stillschweigend durchgelassen. Erlaubt ist nur, was nachweislich in die VM
 * gehört; alles andere ist ein Verstoß, bis es hier bewusst eingetragen wird.
 *
 * Und zwar TRANSITIV: Der Scan bleibt nicht am Daemon-Ordner stehen, sondern
 * folgt jedem erlaubten lokalen Import in dessen Zieldatei und prüft auch
 * DEREN Importe gegen dieselbe Whitelist. Vorher garantierte die Begründung
 * eines Eintrags („host-frei") nichts: ein Import von `db/` in
 * `claudeStreamJson.ts` blieb unsichtbar — die Datei liegt außerhalb des
 * Daemon-Ordners und wurde nie gescannt, eslint erlaubt agent→db, und
 * `Bun.build` hätte den Host-Code kommentarlos ins VM-Bundle inlined. Jeder
 * künftige Whitelist-Eintrag ist damit automatisch mitgeprüft — ohne dass
 * jemand daran denken muss, hier einen Pin nachzuziehen.
 *
 * Bewusst streng: auch `import type` zählt. Ein Typ-Import schleppt zwar
 * keinen Code ins Bundle (er wird wegkompiliert), aber die geteilten
 * Vokabular-Module sollen auch keine TYP-Abhängigkeit auf Host-Schichten
 * aufbauen — wer eine braucht, trägt sie hier bewusst und begründet ein.
 */

const DAEMON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Was ins VM-Bundle importiert werden DARF — der verifizierte Ist-Zustand.
 * Die Muster werden gegen den DAEMON-RELATIVEN Modulpfad geprüft (jeder
 * Import wird dorthin normalisiert, egal aus welcher Datei des Bundles er
 * stammt). Jeder Eintrag trägt seine Begründung; ein neuer Eintrag heißt:
 * bewusst entschieden, dass das Modul VM-tauglich ist — seine eigenen
 * Importe prüft der rekursive Scan dann automatisch mit.
 */
const ERLAUBTE_IMPORTE: ReadonlyArray<{ muster: RegExp; grund: string }> = [
  // Geschwister im Daemon-Ordner selbst — per Definition Teil des Bundles.
  { muster: /^\.\/[^/]+$/, grund: 'Daemon-eigenes Modul' },
  // AgentEvent-Vokabular: reine Typen/Datenformen, host-frei — und der
  // rekursive Scan hält es dabei (heute: Fan-Out 0).
  { muster: /^\.\.\/events$/, grund: 'geteiltes AgentEvent-Vokabular' },
  // Mapping SDK-Message → AgentEvent, läuft bewusst in der VM. Erlaubt ist
  // ihm transitiv nur, was selbst auf dieser Whitelist steht (heute: nur der
  // Typ-Import aus `../events`).
  { muster: /^\.\.\/claudeStreamJson$/, grund: 'SDK-Message-Mapping' },
  // Preview-Status-Vokabular: bewusst importfrei gehalten (s. eslint.config.js),
  // genau damit es gefahrlos ins VM-Bundle darf.
  { muster: /^\.\.\/\.\.\/preview\/[^/]+$/, grund: 'importfreies Preview-Vokabular' },
  // Host↔VM-Vertragskonstanten (GUEST_WORKDIR, MONIT_HTTPD_PORT, …): genau
  // dafür da, von beiden Seiten gekannt zu werden. VM-tauglich, weil der
  // rekursive Scan seine Importe (heute: keine) mitprüft.
  { muster: /^\.\.\/\.\.\/core\/vmContract$/, grund: 'Host↔VM-Vertrag' },
  // Das Agent SDK ist in der VM installiert (/opt/macvibes) — kein Host-Code.
  { muster: /^@anthropic-ai\/claude-agent-sdk$/, grund: 'Agent SDK (in der VM installiert)' },
];

function quellDateien(verzeichnis: string): string[] {
  const gefunden: string[] = [];
  for (const eintrag of readdirSync(verzeichnis)) {
    const pfad = join(verzeichnis, eintrag);
    if (statSync(pfad).isDirectory()) {
      // Tests dürfen host-seitige Hilfen benutzen — sie landen nie im Bundle.
      if (eintrag === '__tests__') continue;
      gefunden.push(...quellDateien(pfad));
      continue;
    }
    if (eintrag.endsWith('.ts')) gefunden.push(pfad);
  }
  return gefunden;
}

/**
 * Alle Modulpfade aus `import ... from '...'`, `export ... from '...'`,
 * `import('...')` und nacktem `import '...'` (Seiteneffekt-Import).
 */
function importe(quelle: string): string[] {
  // Fail-CLOSED gegen Syntax, die dieser Parser nicht versteht: Doppelquotes
  // und Template-Literale wären für die Regex unsichtbar, eslint-boundaries
  // erlaubt agent→db, und `bun run ci` fuhr lange ohne format:check — ein
  // `from "../../db/schema"` wäre so still ins VM-Bundle gerutscht. Lieber
  // laut scheitern und den Stil erzwingen, als eine stumme Umgehung dulden.
  const fremdeSyntax = quelle.match(/(?:from|import)\s*\(?\s*["`]/);
  if (fremdeSyntax) {
    throw new Error(
      `Import-Syntax, die dieser Scan nicht prüfen kann: ${fremdeSyntax[0].trim()} — ` +
        `im VM-Bundle sind nur Single-Quote-Importe erlaubt (Prettier erzwingt sie ohnehin).`,
    );
  }
  const treffer = quelle.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'|import\s+'([^']+)'/g);
  return [...treffer].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

/**
 * Normalisiert einen Import auf den DAEMON-relativen Modulpfad — die Form,
 * in der die Whitelist ihre Muster formuliert. Ein `./events` in
 * `agent/claudeStreamJson.ts` wird so zu `../events`, ein `./status` in
 * `preview/monitStatus.ts` zu `../../preview/status`: dieselbe Regel gilt
 * damit für jede Datei des Bundles, egal wo sie liegt.
 * (`relative` liefert unter Windows Backslashes — die Muster erwarten `/`.)
 */
function daemonRelativ(datei: string, spezifizierer: string): string {
  const ziel = resolve(dirname(datei), spezifizierer);
  const relativZuDaemon = relative(DAEMON_DIR, ziel).replaceAll('\\', '/');
  return relativZuDaemon.startsWith('.') ? relativZuDaemon : `./${relativZuDaemon}`;
}

/** Löst einen relativen Import auf seine .ts-Datei auf (für die Rekursion). */
function zielDatei(datei: string, spezifizierer: string): string {
  return `${resolve(dirname(datei), spezifizierer)}.ts`;
}

/**
 * Scannt eine Bundle-Datei: prüft jeden Import gegen die Whitelist und folgt
 * erlaubten LOKALEN Importen rekursiv in deren Zieldatei — so ist jeder
 * Whitelist-Eintrag automatisch transitiv dicht, statt sich auf die
 * Begründung im Kommentar zu verlassen.
 */
function pruefeDatei(datei: string, besucht: Set<string>, verstoesse: string[]): void {
  if (besucht.has(datei)) return;
  besucht.add(datei);
  for (const spezifizierer of importe(readFileSync(datei, 'utf8'))) {
    const lokal = spezifizierer.startsWith('.');
    // Paket-Importe werden wörtlich geprüft, lokale in Daemon-Sicht normalisiert.
    const normalisiert = lokal ? daemonRelativ(datei, spezifizierer) : spezifizierer;
    if (!ERLAUBTE_IMPORTE.some(({ muster }) => muster.test(normalisiert))) {
      const relDatei = relative(DAEMON_DIR, datei).replaceAll('\\', '/');
      verstoesse.push(
        `${relDatei} importiert '${spezifizierer}' (aus Daemon-Sicht '${normalisiert}') — ` +
          `nicht auf der VM-Bundle-Whitelist. Diese Datei wird (direkt oder transitiv) in ` +
          `die MicroVM gebündelt; Host-Code (core/, services/, sandbox/, db/, agentGateway, …) ` +
          `darf dort nicht hinein — auch nicht als \`import type\` (Vokabular-Module bleiben ` +
          `host-frei). Ist das Modul nachweislich VM-tauglich, trage es begründet in ` +
          `ERLAUBTE_IMPORTE ein — der Scan prüft seine eigenen Importe dann automatisch mit.`,
      );
      continue;
    }
    if (!lokal) continue;
    const ziel = zielDatei(datei, spezifizierer);
    if (!existsSync(ziel)) {
      // Lieber laut scheitern als still ein Loch lassen: ein erlaubter
      // Import, dessen Ziel der Scan nicht findet, wäre ungeprüft.
      throw new Error(`Bundle-Scan: Zieldatei zu '${spezifizierer}' nicht gefunden: ${ziel}`);
    }
    pruefeDatei(ziel, besucht, verstoesse);
  }
}

describe('Grenze des VM-Bundles', () => {
  test('das VM-Bundle importiert TRANSITIV ausschließlich Module von der Whitelist', () => {
    const verstoesse: string[] = [];
    const besucht = new Set<string>();
    for (const datei of quellDateien(DAEMON_DIR)) {
      pruefeDatei(datei, besucht, verstoesse);
    }
    expect(verstoesse).toEqual([]);
  });

  test('der Scan erreicht die Whitelist-Ziele außerhalb des Daemon-Ordners (sonst prüft er nichts)', () => {
    // Selbsttest der Fitnessfunktion: genau die Dateien, deren Ungeprüftheit
    // die Lücke war (events, claudeStreamJson, preview/*, vmContract), müssen
    // im rekursiven Scan auftauchen — sonst ist die Grenze wieder nur eine
    // Behauptung im Whitelist-Kommentar.
    const besucht = new Set<string>();
    for (const datei of quellDateien(DAEMON_DIR)) {
      pruefeDatei(datei, besucht, []);
    }
    const agentDir = resolve(DAEMON_DIR, '..');
    const srcDir = resolve(agentDir, '..');
    for (const erwartet of [
      join(agentDir, 'events.ts'),
      join(agentDir, 'claudeStreamJson.ts'),
      join(srcDir, 'preview', 'status.ts'),
      join(srcDir, 'preview', 'monitStatus.ts'),
      join(srcDir, 'preview', 'httpProbe.ts'),
      join(srcDir, 'core', 'vmContract.ts'),
    ]) {
      expect(besucht.has(erwartet)).toBe(true);
    }
  });

  test('findet die Quelldateien überhaupt (sonst prüft der Test nichts)', () => {
    const dateien = quellDateien(DAEMON_DIR);
    expect(dateien.length).toBeGreaterThan(2);
    expect(dateien.some((d) => d.endsWith('main.ts'))).toBe(true);
  });
});

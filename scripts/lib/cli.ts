/**
 * Reine, testbare Dispatch-Logik der `macvibes`-CLI. Bewusst OHNE Syscalls und
 * ohne Spawnen — die dünne Schale (scripts/cli.ts) übersetzt die hier
 * bestimmte Aktion in echte Unterprozesse. So bleibt die Argument-Auswertung
 * ohne laufende Server/Prompts testbar (Muster wie scripts/lib/setup.ts).
 */

/** Die Unterbefehle der CLI mit je einer Zeile Beschreibung (für die Hilfe). */
export const CLI_BEFEHLE = [
  { name: 'setup', beschreibung: 'Geführtes First-Run-Setup (Doctor, Anbieter, Admin, .env)' },
  { name: 'start', beschreibung: 'Produktion: Web-UI bauen und Server starten (LAN)' },
  { name: 'stop', beschreibung: 'Alles beenden: Web, Server, Egress-Proxy, MicroVMs' },
  { name: 'dev', beschreibung: 'Entwicklungsmodus: Web (Vite) und Server parallel' },
  { name: 'doctor', beschreibung: 'Umgebung prüfen (bun, git, msb, Hypervisor, Ports)' },
] as const;

export type CliBefehlName = (typeof CLI_BEFEHLE)[number]['name'];

/**
 * Ergebnis der Argument-Auswertung — ein reines Datum, damit die Schale nur
 * noch mechanisch dispatchen muss:
 *   - help/version: lokal beantworten, Exit 0.
 *   - run         : Unterbefehl starten, `rest` unverändert durchreichen
 *                   (Reihenfolge inklusive `--` bleibt erhalten).
 *   - unknown     : Fehlermeldung + Hilfe, Exit 1. `input` trägt das erste
 *                   Argument für eine konkrete Meldung.
 */
export type CliAktion =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; command: CliBefehlName; rest: string[] }
  | { kind: 'unknown'; input: string };

function istBefehl(wert: string): wert is CliBefehlName {
  return CLI_BEFEHLE.some((befehl) => befehl.name === wert);
}

/** argv OHNE Runtime/Skript (also process.argv.slice(2)) auswerten. */
export function parseCliArgs(argv: string[]): CliAktion {
  const [erstes, ...rest] = argv;
  if (erstes === undefined || erstes === 'help' || erstes === '--help' || erstes === '-h') {
    return { kind: 'help' };
  }
  if (erstes === '--version' || erstes === '-v') {
    return { kind: 'version' };
  }
  if (istBefehl(erstes)) {
    return { kind: 'run', command: erstes, rest };
  }
  // Auch unbekannte Flags landen hier — stilles Ignorieren wäre gefährlicher
  // als ein klarer Fehler (Tippfehler wie `macvibes strat` sollen auffallen).
  return { kind: 'unknown', input: erstes };
}

/** Knappe, deutsche Hilfe — eine Zeile pro Befehl, wie in der Spec verlangt. */
export function hilfeText(): string {
  const breite = Math.max(...CLI_BEFEHLE.map((befehl) => befehl.name.length));
  const zeilen = CLI_BEFEHLE.map(
    (befehl) => `  ${befehl.name.padEnd(breite)}  ${befehl.beschreibung}`,
  );
  return [
    'macvibes — lokale Vibe-Coding-Plattform',
    '',
    'Verwendung: macvibes <befehl>',
    '',
    'Befehle:',
    ...zeilen,
    '',
    'Optionen:',
    '  --help, -h     Diese Hilfe anzeigen',
    '  --version, -v  Version anzeigen',
  ].join('\n');
}

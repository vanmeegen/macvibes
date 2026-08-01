import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 * einer Konvention zu überlassen.
 */

const DAEMON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/** Alle Modulpfade aus `import ... from '...'` und `import('...')`. */
function importe(quelle: string): string[] {
  const treffer = quelle.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'/g);
  return [...treffer].map((m) => (m[1] ?? m[2]) as string);
}

describe('Grenze des VM-Bundles', () => {
  test('der Daemon importiert nichts aus der Host-Sandbox-Schicht', () => {
    const verstoesse: string[] = [];
    for (const datei of quellDateien(DAEMON_DIR)) {
      for (const pfad of importe(readFileSync(datei, 'utf8'))) {
        if (/(^|\/)sandbox\//.test(pfad)) {
          verstoesse.push(`${datei.slice(DAEMON_DIR.length + 1)} → ${pfad}`);
        }
      }
    }
    expect(verstoesse).toEqual([]);
  });

  test('findet die Quelldateien überhaupt (sonst prüft der Test nichts)', () => {
    const dateien = quellDateien(DAEMON_DIR);
    expect(dateien.length).toBeGreaterThan(2);
    expect(dateien.some((d) => d.endsWith('main.ts'))).toBe(true);
  });
});

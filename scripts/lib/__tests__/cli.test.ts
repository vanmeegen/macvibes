/**
 * Reine Dispatch-Logik der `macvibes`-CLI (scripts/cli.ts). Getestet wird NUR
 * die Argument-Auswertung (parseCliArgs) und der Hilfetext — die dünne Schale
 * scripts/cli.ts spawnt Unterprozesse und bleibt bewusst ungetestet (sie würde
 * echte Server/Setups starten). Test-first nach CLAUDE.md.
 */
import { describe, expect, test } from 'bun:test';
import { CLI_BEFEHLE, hilfeText, parseCliArgs } from '../cli';

describe('parseCliArgs — bekannte Befehle', () => {
  for (const befehl of ['setup', 'start', 'stop', 'dev', 'doctor'] as const) {
    test(`'${befehl}' wird als run-Aktion erkannt`, () => {
      expect(parseCliArgs([befehl])).toEqual({ kind: 'run', command: befehl, rest: [] });
    });
  }

  test('Extra-Argumente werden unverändert durchgereicht', () => {
    expect(parseCliArgs(['dev', '--foo', 'bar'])).toEqual({
      kind: 'run',
      command: 'dev',
      rest: ['--foo', 'bar'],
    });
  });

  test('Extra-Argumente behalten ihre Reihenfolge (auch mit --)', () => {
    expect(parseCliArgs(['start', '--', '-x'])).toEqual({
      kind: 'run',
      command: 'start',
      rest: ['--', '-x'],
    });
  });
});

describe('parseCliArgs — Hilfe', () => {
  test('leeres argv zeigt die Hilfe', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'help' });
  });

  for (const alias of ['--help', '-h', 'help']) {
    test(`'${alias}' zeigt die Hilfe`, () => {
      expect(parseCliArgs([alias])).toEqual({ kind: 'help' });
    });
  }
});

describe('parseCliArgs — Version', () => {
  for (const alias of ['--version', '-v']) {
    test(`'${alias}' zeigt die Version`, () => {
      expect(parseCliArgs([alias])).toEqual({ kind: 'version' });
    });
  }
});

describe('parseCliArgs — unbekannte Befehle', () => {
  test('unbekannter Befehl wird mit der Eingabe gemeldet (für die Fehlermeldung)', () => {
    expect(parseCliArgs(['frobnicate'])).toEqual({ kind: 'unknown', input: 'frobnicate' });
  });

  test('unbekannte Flags sind ebenfalls unbekannt (kein stilles Ignorieren)', () => {
    expect(parseCliArgs(['--frobnicate'])).toEqual({ kind: 'unknown', input: '--frobnicate' });
  });
});

describe('hilfeText — knappe, deutsche Hilfe', () => {
  test('nennt jeden Befehl mit einer Beschreibung', () => {
    const text = hilfeText();
    for (const { name, beschreibung } of CLI_BEFEHLE) {
      expect(text).toContain(name);
      expect(beschreibung.length).toBeGreaterThan(0);
      expect(text).toContain(beschreibung);
    }
  });

  test('nennt den Programmnamen und die Hilfe-/Versions-Flags', () => {
    const text = hilfeText();
    expect(text).toContain('macvibes');
    expect(text).toContain('--help');
    expect(text).toContain('--version');
  });
});

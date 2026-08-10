import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_MODELS,
  allAgentModels,
  agentTimeoutsFor,
  isKnownAgentModel,
  isSlowAgentModel,
  loadUserAgentModels,
  parseUserAgentModels,
  registerUserAgentModels,
} from '../agentModel';

// Modul-Zustand nach jedem Test zurücksetzen — der Katalog ist prozessweit,
// und bun test führt alle Dateien im selben Prozess aus.
afterEach(() => {
  registerUserAgentModels([]);
});

describe('parseUserAgentModels (Nutzer-Modelle aus <macvibesHome>/models.json)', () => {
  test('gültige Einträge werden übernommen, ohne Warnungen', () => {
    const raw = JSON.stringify([
      { id: 'openrouter/qwen/qwen3-coder', label: 'Qwen3 Coder (OpenRouter)', slow: true },
      { id: 'openai/gpt-4o', label: 'GPT-4o', slow: false },
    ]);
    const result = parseUserAgentModels(raw);
    expect(result.models).toEqual([
      { id: 'openrouter/qwen/qwen3-coder', label: 'Qwen3 Coder (OpenRouter)', slow: true },
      { id: 'openai/gpt-4o', label: 'GPT-4o', slow: false },
    ]);
    expect(result.warnings).toEqual([]);
  });

  test('kaputtes JSON: keine Modelle, eine Warnung — nie werfen', () => {
    const result = parseUserAgentModels('{ kaputt');
    expect(result.models).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });

  test('kein Array (Objekt an der Wurzel): keine Modelle, eine Warnung', () => {
    const result = parseUserAgentModels('{"id":"x","label":"X","slow":true}');
    expect(result.models).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });

  test('kaputte Einträge werden übersprungen und gemeldet, gute bleiben', () => {
    const raw = JSON.stringify([
      { id: 'gut/modell', label: 'Gutes Modell', slow: true },
      { id: '', label: 'Leere id', slow: true },
      { id: 'ohne-label', slow: true },
      { id: 'slow-als-string', label: 'Kaputt', slow: 'ja' },
      'kein-objekt',
      null,
    ]);
    const result = parseUserAgentModels(raw);
    expect(result.models).toEqual([{ id: 'gut/modell', label: 'Gutes Modell', slow: true }]);
    expect(result.warnings.length).toBe(5);
  });

  test('ids mit "claude"-Präfix werden abgelehnt (Proxy routet sie an Anthropic)', () => {
    const raw = JSON.stringify([
      { id: 'claude-eigenbau', label: 'Falle', slow: true },
      { id: 'claude', label: 'Exakt das Präfix', slow: true },
      // "claudius" beginnt NICHT mit "claude" — nur das echte Präfix ist die
      // Routing-Falle des Credential-Proxys, kein Ähnlichkeitsverbot.
      { id: 'claudius/anderes-praefix', label: 'Nur fast claude', slow: true },
    ]);
    const result = parseUserAgentModels(raw);
    expect(result.models.map((m) => m.id)).toEqual(['claudius/anderes-praefix']);
    expect(result.warnings.length).toBe(2);
  });

  test('Kollision mit eingebautem Modell: eingebauter Eintrag gewinnt, Warnung', () => {
    const raw = JSON.stringify([{ id: 'qwen3.6-coder', label: 'Übernahmeversuch', slow: false }]);
    const result = parseUserAgentModels(raw);
    expect(result.models).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });

  test('Duplikate innerhalb der Nutzerdatei: erster Eintrag gewinnt, Warnung', () => {
    const raw = JSON.stringify([
      { id: 'doppelt/modell', label: 'Erster', slow: true },
      { id: 'doppelt/modell', label: 'Zweiter', slow: false },
    ]);
    const result = parseUserAgentModels(raw);
    expect(result.models).toEqual([{ id: 'doppelt/modell', label: 'Erster', slow: true }]);
    expect(result.warnings.length).toBe(1);
  });
});

describe('registrierte Nutzer-Modelle erweitern den Katalog', () => {
  test('allAgentModels = eingebaute + Nutzer-Modelle (in dieser Reihenfolge)', () => {
    registerUserAgentModels([{ id: 'openai/gpt-4o', label: 'GPT-4o', slow: true }]);
    expect(allAgentModels().map((m) => m.id)).toEqual([
      ...AGENT_MODELS.map((m) => m.id),
      'openai/gpt-4o',
    ]);
  });

  test('isKnownAgentModel/isSlowAgentModel sehen Nutzer-Modelle (Mutation + Timeouts)', () => {
    expect(isKnownAgentModel('openai/gpt-4o')).toBe(false);
    registerUserAgentModels([{ id: 'openai/gpt-4o', label: 'GPT-4o', slow: true }]);
    expect(isKnownAgentModel('openai/gpt-4o')).toBe(true);
    expect(isSlowAgentModel('openai/gpt-4o')).toBe(true);
    const fast = { idleMs: 1, firstEventMs: 2, coldStartMs: 3 };
    const slow = { idleMs: 4, firstEventMs: 5, coldStartMs: 6 };
    expect(agentTimeoutsFor('openai/gpt-4o', fast, slow)).toEqual(slow);
  });

  test('AGENT_MODELS (eingebauter Katalog) bleibt von Nutzer-Modellen unberührt', () => {
    registerUserAgentModels([{ id: 'openai/gpt-4o', label: 'GPT-4o', slow: true }]);
    expect(AGENT_MODELS.some((m) => m.id === 'openai/gpt-4o')).toBe(false);
  });
});

describe('loadUserAgentModels (Dateizugriff, von der Composition Root aufgerufen)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'macvibes-models-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('fehlende Datei: kein Fehler, keine Warnung, Katalog = eingebaute', () => {
    const warnings: string[] = [];
    loadUserAgentModels(join(dir, 'gibt-es-nicht.json'), (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(allAgentModels()).toEqual([...AGENT_MODELS]);
  });

  test('vorhandene Datei wird gelesen und registriert', () => {
    const file = join(dir, 'models.json');
    writeFileSync(file, JSON.stringify([{ id: 'openai/gpt-4o', label: 'GPT-4o', slow: true }]));
    const warnings: string[] = [];
    loadUserAgentModels(file, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(isKnownAgentModel('openai/gpt-4o')).toBe(true);
  });

  test('kaputte Datei: warnt, wirft nie (Serverstart darf nicht scheitern)', () => {
    const file = join(dir, 'models.json');
    writeFileSync(file, '{ kaputt');
    const warnings: string[] = [];
    expect(() => loadUserAgentModels(file, (m) => warnings.push(m))).not.toThrow();
    expect(warnings.length).toBe(1);
    expect(allAgentModels()).toEqual([...AGENT_MODELS]);
  });

  test('erneutes Laden ersetzt die Nutzer-Modelle (kein Aufsummieren)', () => {
    const file = join(dir, 'models.json');
    writeFileSync(file, JSON.stringify([{ id: 'openai/gpt-4o', label: 'GPT-4o', slow: true }]));
    loadUserAgentModels(file);
    writeFileSync(file, JSON.stringify([{ id: 'openai/gpt-4.1', label: 'GPT-4.1', slow: true }]));
    loadUserAgentModels(file);
    expect(isKnownAgentModel('openai/gpt-4o')).toBe(false);
    expect(isKnownAgentModel('openai/gpt-4.1')).toBe(true);
  });
});

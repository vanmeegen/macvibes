import { afterEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL,
  allAgentModels,
  defaultAgentModel,
  effectiveAgentModel,
  isKnownAgentModel,
  loadClaudeModels,
  parseClaudeModels,
  registerClaudeModels,
} from '../agentModel';
import { createTempDir, trackTempDirs } from '../../testing/testUtils';

const tempDirs = trackTempDirs();

afterEach(() => {
  registerClaudeModels(null);
});

/**
 * Die Anthropic-Modelle im Dropdown sind Konfiguration, kein Code: ein neues
 * Modell soll sich ohne Neubau eintragen lassen. Quelle ist
 * `<macvibesHome>/claude-models.json`; fehlt die Datei, gilt die eingebaute Liste.
 */
describe('parseClaudeModels (claude-models.json)', () => {
  test('liest id und label, die Reihenfolge der Datei bleibt erhalten', () => {
    const { models, warnings } = parseClaudeModels(
      JSON.stringify([
        { id: 'claude-opus-6', label: 'Claude Opus 6' },
        { id: 'claude-sonnet-6', label: 'Claude Sonnet 6' },
      ]),
    );
    expect(warnings).toEqual([]);
    expect(models).toEqual([
      { id: 'claude-opus-6', label: 'Claude Opus 6', slow: false },
      { id: 'claude-sonnet-6', label: 'Claude Sonnet 6', slow: false },
    ]);
  });

  test('"zuletzt": true wird übernommen', () => {
    const { models } = parseClaudeModels(
      JSON.stringify([
        { id: 'claude-sonnet-6', label: 'Sonnet 6' },
        { id: 'claude-fable-6', label: 'Fable 6 *', zuletzt: true },
      ]),
    );
    expect(models[1]).toEqual({
      id: 'claude-fable-6',
      label: 'Fable 6 *',
      slow: false,
      zuletzt: true,
    });
  });

  test('ids ohne "claude"-Präfix werden abgelehnt (der Proxy schickte sie nicht an Anthropic)', () => {
    const { models, warnings } = parseClaudeModels(
      JSON.stringify([
        { id: 'gpt-5', label: 'GPT-5' },
        { id: 'claude-sonnet-6', label: 'Sonnet 6' },
      ]),
    );
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-6']);
    expect(warnings.join(' ')).toMatch(/gpt-5/);
  });

  test('kaputte Einträge und Dubletten werden übersprungen und gemeldet, nie geworfen', () => {
    const { models, warnings } = parseClaudeModels(
      JSON.stringify([
        'unsinn',
        { id: 'claude-a' },
        { id: 'claude-b', label: 'B', zuletzt: 'ja' },
        { id: 'claude-c', label: 'C' },
        { id: 'claude-c', label: 'C nochmal' },
      ]),
    );
    expect(models.map((m) => m.id)).toEqual(['claude-c']);
    expect(warnings).toHaveLength(4);
  });

  test('kein JSON oder kein Array ergibt eine leere Liste mit Warnung', () => {
    expect(parseClaudeModels('{kaputt').models).toEqual([]);
    expect(parseClaudeModels('{kaputt').warnings).toHaveLength(1);
    expect(parseClaudeModels('{"id":"claude-x"}').warnings).toHaveLength(1);
  });
});

describe('loadClaudeModels', () => {
  async function datei(inhalt: string): Promise<string> {
    const dir = await createTempDir('macvibes-claude-models-');
    tempDirs.push(dir);
    const pfad = join(dir, 'claude-models.json');
    await writeFile(pfad, inhalt);
    return pfad;
  }

  test('fehlende Datei: die eingebaute Liste gilt', () => {
    expect(loadClaudeModels('/gibt/es/nicht/claude-models.json')).toBe(0);
    expect(allAgentModels().map((m) => m.id)).toEqual(AGENT_MODELS.map((m) => m.id));
    expect(defaultAgentModel()).toBe(DEFAULT_AGENT_MODEL);
  });

  test('die Datei ERSETZT die eingebauten Anthropic-Modelle; das lokale Modell bleibt', async () => {
    const pfad = await datei(
      JSON.stringify([
        { id: 'claude-opus-6', label: 'Claude Opus 6' },
        { id: 'claude-fable-6', label: 'Fable 6 *', zuletzt: true },
        { id: 'claude-haiku-6', label: 'Claude Haiku 6' },
      ]),
    );
    expect(loadClaudeModels(pfad)).toBe(3);
    expect(allAgentModels().map((m) => m.id)).toEqual([
      'claude-opus-6',
      'claude-haiku-6',
      'Qwen3.8-27B-oQ4e-mtp',
      'claude-fable-6',
    ]);
    expect(isKnownAgentModel('claude-sonnet-5-5')).toBe(false);
  });

  test('der erste Eintrag der Datei ist der Default für neue Projekte', async () => {
    const pfad = await datei(
      JSON.stringify([
        { id: 'claude-opus-6', label: 'Claude Opus 6' },
        { id: 'claude-haiku-6', label: 'Claude Haiku 6' },
      ]),
    );
    loadClaudeModels(pfad);
    expect(defaultAgentModel()).toBe('claude-opus-6');
  });

  test('eine Datei ohne einen gültigen Eintrag lässt die eingebaute Liste stehen und warnt', async () => {
    const warnungen: string[] = [];
    const pfad = await datei('[{"id":"gpt-5","label":"GPT-5"}]');
    expect(loadClaudeModels(pfad, (w) => warnungen.push(w))).toBe(0);
    expect(defaultAgentModel()).toBe(DEFAULT_AGENT_MODEL);
    expect(warnungen.join(' ')).toMatch(/eingebaute Liste/);
  });
});

/**
 * Wird die Liste geändert, stehen in bestehenden Projekten Modelle, die es im
 * Dropdown nicht mehr gibt. Solche Projekte laufen mit dem Default weiter,
 * statt mit einem abgekündigten Modell an der API zu scheitern.
 */
describe('effectiveAgentModel', () => {
  test('ein Modell aus dem Katalog bleibt', () => {
    expect(effectiveAgentModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(effectiveAgentModel('Qwen3.8-27B-oQ4e-mtp')).toBe('Qwen3.8-27B-oQ4e-mtp');
  });

  test('ein Modell, das nicht (mehr) im Katalog steht, wird zum Default', () => {
    expect(effectiveAgentModel('claude-sonnet-5')).toBe(DEFAULT_AGENT_MODEL);
    expect(effectiveAgentModel(null)).toBe(DEFAULT_AGENT_MODEL);
  });
});

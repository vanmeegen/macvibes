import { describe, expect, test } from 'bun:test';
import { projects } from '../../db/schema';
import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL,
  agentTimeoutsFor,
  effectiveAgentModel,
  isKnownAgentModel,
  isSlowAgentModel,
} from '../agentModel';

describe('Modellkatalog (Modellwahl pro Chat)', () => {
  test('enthält genau die fünf wählbaren Modelle, das teure Fable zuletzt', () => {
    expect(AGENT_MODELS.map((m) => m.id)).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'Qwen3.8-27B-oQ4e-mtp',
      'claude-fable-5-2',
    ]);
  });

  test('Fable trägt Sternchen und Kostenwarnung im Anzeigenamen', () => {
    const fable = AGENT_MODELS.find((m) => m.id === 'claude-fable-5-2');
    expect(fable?.label).toBe('Claude Fable 5.2 * — Achtung, sehr teuer');
    expect(fable?.slow).toBe(false);
  });

  test('Default ist Claude Sonnet 5.5 (neue Chats starten damit)', () => {
    expect(DEFAULT_AGENT_MODEL).toBe('claude-sonnet-5-5');
  });

  test('jedes Modell hat einen nichtleeren Anzeigenamen', () => {
    for (const m of AGENT_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  test('das lokale Qwen-Modell ist als langsam markiert, Claude-Modelle nicht', () => {
    expect(isSlowAgentModel('Qwen3.8-27B-oQ4e-mtp')).toBe(true);
    expect(isSlowAgentModel('claude-sonnet-5-5')).toBe(false);
    expect(isSlowAgentModel('claude-haiku-5-5')).toBe(false);
    expect(isSlowAgentModel('claude-opus-5-5')).toBe(false);
  });

  test('unbekannte Modelle werden erkannt (Validierung der Mutation)', () => {
    expect(isKnownAgentModel('claude-sonnet-5-5')).toBe(true);
    expect(isKnownAgentModel('Qwen3.8-27B-oQ4e-mtp')).toBe(true);
    expect(isKnownAgentModel('gpt-5')).toBe(false);
    expect(isKnownAgentModel('')).toBe(false);
  });

  test('agentTimeoutsFor wählt langsame Timeouts nur für langsame Modelle', () => {
    const fast = { idleMs: 180_000, firstEventMs: 8_000, coldStartMs: 30_000 };
    const slow = { idleMs: 600_000, firstEventMs: 180_000, coldStartMs: 300_000 };
    expect(agentTimeoutsFor('Qwen3.8-27B-oQ4e-mtp', fast, slow)).toEqual(slow);
    expect(agentTimeoutsFor('claude-sonnet-5-5', fast, slow)).toEqual(fast);
    // Unbekannte Modelle (z. B. via Router ergänzt): konservativ langsam behandeln,
    // damit ein träges Fremdmodell nicht sofort abgebrochen wird.
    expect(agentTimeoutsFor('mistral-large', fast, slow)).toEqual(slow);
  });
});

describe('Default-Modell und DB-Spalte', () => {
  test('der Spalten-Default ist Altbestand und wird beim Lesen zum aktuellen Default', () => {
    // Der Default der Spalte lässt sich in SQLite nur per Tabellen-Neubau
    // ändern, und der löscht die Chat-Nachrichten (s. Migration 0006). Er bleibt
    // deshalb auf dem alten Wert — wirksam wird er nie: effectiveAgentModel
    // macht aus einem Modell außerhalb des Katalogs den Default.
    expect(projects.agentModel.default).toBe('claude-sonnet-5');
    expect(effectiveAgentModel(projects.agentModel.default as string)).toBe(DEFAULT_AGENT_MODEL);
  });
});

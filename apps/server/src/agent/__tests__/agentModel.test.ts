import { describe, expect, test } from 'bun:test';
import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODEL,
  agentTimeoutsFor,
  isKnownAgentModel,
  isSlowAgentModel,
} from '../agentModel';

describe('Modellkatalog (Modellwahl pro Chat)', () => {
  test('enthält genau die fünf wählbaren Modelle', () => {
    expect(AGENT_MODELS.map((m) => m.id)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'qwen3.6-coder',
      'qwen3.6-moe',
    ]);
  });

  test('Default ist Claude Sonnet 5 (neue Chats starten damit)', () => {
    expect(DEFAULT_AGENT_MODEL).toBe('claude-sonnet-5');
  });

  test('jedes Modell hat einen nichtleeren Anzeigenamen', () => {
    for (const m of AGENT_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  test('lokale Qwen-Modelle sind als langsam markiert, Claude-Modelle nicht', () => {
    expect(isSlowAgentModel('qwen3.6-coder')).toBe(true);
    expect(isSlowAgentModel('qwen3.6-moe')).toBe(true);
    expect(isSlowAgentModel('claude-sonnet-5')).toBe(false);
    expect(isSlowAgentModel('claude-haiku-4-5')).toBe(false);
    expect(isSlowAgentModel('claude-opus-4-8')).toBe(false);
  });

  test('unbekannte Modelle werden erkannt (Validierung der Mutation)', () => {
    expect(isKnownAgentModel('claude-sonnet-5')).toBe(true);
    expect(isKnownAgentModel('qwen3.6-moe')).toBe(true);
    expect(isKnownAgentModel('gpt-5')).toBe(false);
    expect(isKnownAgentModel('')).toBe(false);
  });

  test('agentTimeoutsFor wählt langsame Timeouts nur für langsame Modelle', () => {
    const fast = { idleMs: 180_000, firstEventMs: 8_000, coldStartMs: 30_000 };
    const slow = { idleMs: 600_000, firstEventMs: 180_000, coldStartMs: 300_000 };
    expect(agentTimeoutsFor('qwen3.6-coder', fast, slow)).toEqual(slow);
    expect(agentTimeoutsFor('claude-sonnet-5', fast, slow)).toEqual(fast);
    // Unbekannte Modelle (z. B. via Router ergänzt): konservativ langsam behandeln,
    // damit ein träges Fremdmodell nicht sofort abgebrochen wird.
    expect(agentTimeoutsFor('mistral-large', fast, slow)).toEqual(slow);
  });
});

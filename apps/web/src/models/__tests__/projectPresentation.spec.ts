import { describe, expect, it } from 'vitest';
import { agentWorkingLabel, formatTimestamp, projectStatusChip } from '../projectPresentation';

describe('agentWorkingLabel — sichtbares Boot-Feedback statt gefühltem Hänger', () => {
  it('zeigt beim VM-Boot klar an, dass die MicroVM startet', () => {
    expect(agentWorkingLabel('starting')).toBe('MicroVM startet — Workspace wird vorbereitet …');
  });

  it('zeigt bei gestoppter/stoppender Sandbox, dass sie gleich gestartet wird', () => {
    expect(agentWorkingLabel('stopped')).toBe('Sandbox wird gestartet …');
    expect(agentWorkingLabel('stopping')).toBe('Sandbox wird gestartet …');
  });

  it('zeigt bei laufender Sandbox den normalen Agenten-Status', () => {
    expect(agentWorkingLabel('running')).toBe('Agent arbeitet …');
  });
});

describe('projectStatusChip — „arbeitet" hat Vorrang vor dem Sandbox-Status', () => {
  it('zeigt „arbeitet", wenn ein Agent-Turn läuft (Sandbox läuft dann ohnehin)', () => {
    expect(projectStatusChip('running', true)).toEqual({ label: 'arbeitet', color: 'warning' });
  });

  it('zeigt sonst den Sandbox-Status wie bisher', () => {
    expect(projectStatusChip('running', false)).toEqual({ label: 'bereit', color: 'success' });
    expect(projectStatusChip('starting', false)).toEqual({ label: 'startet', color: 'default' });
    expect(projectStatusChip('stopped', false)).toEqual({ label: 'gestoppt', color: 'default' });
  });

  it('übersetzt auch „stopping" — nie das rohe englische Statuswort', () => {
    expect(projectStatusChip('stopping', false)).toEqual({ label: 'stoppt', color: 'default' });
  });
});

describe('formatTimestamp', () => {
  it('formatiert einen ISO-Zeitstempel deutsch', () => {
    expect(formatTimestamp('2026-07-02T12:00:00.000Z')).toMatch(
      /^\d{2}\.\d{2}\.2026, \d{2}:\d{2}$/,
    );
  });

  it('gibt Unlesbares unverändert zurück statt „Invalid Date"', () => {
    expect(formatTimestamp('kaputt')).toBe('kaputt');
  });
});

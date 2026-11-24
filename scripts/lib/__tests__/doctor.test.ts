/**
 * Doctor-Auswertung (lib/doctor): rein, ohne Syscalls — die echten Zustände
 * erhebt lib/doctorState und reicht sie hier als Daten herein.
 */
import { describe, expect, test } from 'bun:test';
import { doctor, type DoctorInput } from '../doctor';

describe('doctor — reine Auswertung injizierter Prüf-Ergebnisse', () => {
  const gesund: DoctorInput = {
    bunVersion: '1.3.14',
    bunPin: '1.3.14',
    gitAvailable: true,
    msbAvailable: true,
    hypervisorAvailable: true,
    belegtePorts: [],
  };

  test('alles ok → keine Fehler, keine Warnungen', () => {
    const report = doctor(gesund);
    expect(report.hatFehler).toBe(false);
    expect(report.hatWarnung).toBe(false);
    expect(report.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  test('fehlendes bun ist ein harter Fehler mit Handlungshinweis', () => {
    const report = doctor({ ...gesund, bunVersion: null });
    const bun = report.checks.find((c) => c.id === 'bun');
    expect(bun?.status).toBe('fail');
    expect(bun?.hinweis.length).toBeGreaterThan(0);
    expect(report.hatFehler).toBe(true);
  });

  test('abweichende bun-Version warnt (Pin 1.3.14), blockiert aber nicht', () => {
    const report = doctor({ ...gesund, bunVersion: '1.4.0' });
    const bun = report.checks.find((c) => c.id === 'bun');
    expect(bun?.status).toBe('warn');
    expect(report.hatFehler).toBe(false);
    expect(report.hatWarnung).toBe(true);
  });

  test('fehlendes git ist ein harter Fehler', () => {
    const report = doctor({ ...gesund, gitAvailable: false });
    expect(report.checks.find((c) => c.id === 'git')?.status).toBe('fail');
    expect(report.hatFehler).toBe(true);
  });

  test('fehlendes msb ist nur eine Warnung (Prozess-Fallback existiert)', () => {
    const report = doctor({ ...gesund, msbAvailable: false });
    expect(report.checks.find((c) => c.id === 'msb')?.status).toBe('warn');
    expect(report.hatFehler).toBe(false);
  });

  test('msb da, aber kein Hypervisor → Warnung (VM kann nicht booten)', () => {
    const report = doctor({ ...gesund, hypervisorAvailable: false });
    expect(report.checks.find((c) => c.id === 'hypervisor')?.status).toBe('warn');
    expect(report.hatFehler).toBe(false);
  });

  test('ohne msb ist die Hypervisor-Prüfung nicht anwendbar (ok/übersprungen)', () => {
    const report = doctor({ ...gesund, msbAvailable: false, hypervisorAvailable: false });
    expect(report.checks.find((c) => c.id === 'hypervisor')?.status).toBe('ok');
  });

  test('belegte Ports warnen mit den konkreten Portnummern', () => {
    const report = doctor({ ...gesund, belegtePorts: [4000, 5173] });
    const ports = report.checks.find((c) => c.id === 'ports');
    expect(ports?.status).toBe('warn');
    expect(ports?.hinweis).toContain('4000');
    expect(ports?.hinweis).toContain('5173');
  });
});

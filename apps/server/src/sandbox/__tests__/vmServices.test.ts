import { describe, expect, test } from 'bun:test';
import { MONIT_HTTPD_PORT, buildVmServices } from '../vmServices';

const SPEC = {
  devCommand: "bun run dev --port '5199'",
  previewPort: 5199,
  daemonEnv: {
    ANTHROPIC_BASE_URL: 'http://host.microsandbox.internal:4000/anthropic',
    MACVIBES_AGENT_GATEWAY_URL: "ws://host:4000/agent?sandbox=sb-1&token=ge'heim",
  },
};

describe('buildVmServices (monit)', () => {
  const services = buildVmServices(SPEC);

  test('PID 1 kopiert die monitrc mit Mode 600 und exec-t tini (Subreaper) → monit', () => {
    expect(services.pid1Command).toContain('install -m 600 /opt/macvibes/etc/monitrc');
    // -s ist Pflicht: tini ist in der msb-VM nicht das echte PID 1 — ohne
    // Subreaper bleiben tote Services Zombies und monit restartet nie.
    expect(services.pid1Command).toContain('exec tini -s --');
    expect(services.pid1Command).toContain('monit -I');
  });

  test('monitrc: beide Services mit Pidfile, Port-Health-Check und Crash-Loop-Schutz', () => {
    const monitrc = services.files['monitrc']!;
    expect(monitrc).toContain('check process devserver with pidfile /run/macvibes/devserver.pid');
    expect(monitrc).toContain(
      'check process agent-daemon with pidfile /run/macvibes/agent-daemon.pid',
    );
    // Health-Check auf den Preview-Port, geduldig während der Startphase.
    expect(monitrc).toContain(`if failed port ${SPEC.previewPort}`);
    // Crash-Loop endet in einem Endzustand (unmonitor ≙ unser "failed").
    expect(monitrc).toContain('then unmonitor');
    // Status-API für den Host.
    expect(monitrc).toContain(`set httpd port ${MONIT_HTTPD_PORT}`);
  });

  test('devserver-run.sh: PORT-Env, /work, nice/ionice, devCommand sicher gequotet', () => {
    const run = services.files['devserver-run.sh']!;
    expect(run).toContain("export PORT='5199'");
    expect(run).toContain('cd /work');
    expect(run).toContain('nice -n 19 ionice -c 3');
    // Single-Quotes im devCommand dürfen das Quoting nicht sprengen.
    expect(run).toContain("bun run dev --port '\\''5199'\\''");
  });

  test('devserver-run.sh: Delta-Install aus bun.lock VOR dem devCommand (ADR 0002)', () => {
    const run = services.files['devserver-run.sh']!;
    // Subshell mit daemon.env.sh: bun install braucht den Egress-Proxy und den
    // Cache-Pfad — das Token darf aber NICHT an den devCommand (User-Code) leaken.
    expect(run).toContain('( . /opt/macvibes/etc/daemon.env.sh');
    expect(run).toContain('bun install --silent');
    // Nicht fatal: der Dev-Server startet auch bei fehlgeschlagenem Install.
    expect(run).toContain('||');
    // Reihenfolge: Install vor dem exec des devCommand.
    expect(run.indexOf('bun install')).toBeLessThan(run.indexOf('exec nice'));
  });

  test('daemon.env.sh exportiert die Env — Werte mit Single-Quotes sicher escaped', () => {
    const env = services.files['daemon.env.sh']!;
    expect(env).toContain(
      "export ANTHROPIC_BASE_URL='http://host.microsandbox.internal:4000/anthropic'",
    );
    expect(env).toContain("ge'\\''heim");
  });

  test('daemon-run.sh lädt die Env und startet das Bundle aus /opt/macvibes/bin', () => {
    const run = services.files['daemon-run.sh']!;
    expect(run).toContain('. /opt/macvibes/etc/daemon.env.sh');
    expect(run).toContain('exec bun /opt/macvibes/bin/main.js');
  });

  test('Start-Scripte schreiben Pidfiles (monit-Vertrag), Stop-Scripte killen die Prozessgruppe', () => {
    expect(services.files['devserver-start.sh']).toContain('/run/macvibes/devserver.pid');
    expect(services.files['devserver-start.sh']).toContain('setsid');
    expect(services.files['devserver-stop.sh']).toContain('kill');
    expect(services.files['daemon-start.sh']).toContain('/run/macvibes/agent-daemon.pid');
    expect(services.files['daemon-stop.sh']).toContain('kill');
  });
});

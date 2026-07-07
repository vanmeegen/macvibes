/**
 * Erzeugt die Service-Konfiguration für den In-VM-Supervisor (tini + monit,
 * Entscheidung siehe architektur.md). Statt des bisherigen
 * `sleep infinity`-Halters läuft PID 1 als echter Supervisor, der Dev-Server
 * und Agent-Daemon startet, überwacht und neu startet — Health-Check,
 * Crash-Loop-Schutz und Restart sind Konfiguration statt Eigenbau
 * (ersetzt den host-seitigen PreviewSupervisor-Watchdog).
 *
 * Die Dateien werden auf dem HOST geschrieben und read-only nach
 * `/opt/macvibes/etc` gemountet; das Daemon-Bundle liegt unter
 * `/opt/macvibes/bin`.
 */

/** Mountpunkt der Supervisor-/Service-Konfiguration in der VM. */
export const VM_ETC_DIR = '/opt/macvibes/etc';
/** Mountpunkt des Agent-Daemon-Bundles in der VM. */
export const VM_BIN_DIR = '/opt/macvibes/bin';
/** Port der monit-Status-API in der VM (wird auf den Host gemappt). */
export const MONIT_HTTPD_PORT = 2812;

export interface VmServicesSpec {
  /** devCommand aus templates.json — einziger Vertrag zum Template. */
  devCommand: string;
  previewPort: number;
  /** Env für den Agent-Daemon (Credential-Proxy, Gateway-URL, …). */
  daemonEnv: Record<string, string>;
}

export interface VmServices {
  /** Relativer Pfad unter VM_ETC_DIR → Dateiinhalt. */
  files: Record<string, string>;
  /** PID-1-Kommando der VM (nach dem Workspace-Bootstrap ge-exec-t). */
  pid1Command: string;
}

/** Sicheres Single-Quoting für POSIX-sh (Werte dürfen alles enthalten). */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const RUN_DIR = '/run/macvibes';
const DEVSERVER_PIDFILE = `${RUN_DIR}/devserver.pid`;
const DAEMON_PIDFILE = `${RUN_DIR}/agent-daemon.pid`;

/** Run-Wrapper: führen die Services im Vordergrund aus (von monit abgelöst). */
function buildRunWrappers(spec: VmServicesSpec): Record<string, string> {
  const envLines = Object.entries(spec.daemonEnv)
    .map(([key, value]) => `export ${key}=${shQuote(value)}`)
    .join('\n');

  return {
    'daemon.env.sh': `${envLines}\n`,
    'devserver-run.sh': [
      '#!/bin/sh',
      '# monit startet Programme mit minimalem PATH — bun liegt in /usr/local/bin.',
      'export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
      '# Dev-Server im Vordergrund — niedrige Priorität, damit der Agent-Turn',
      '# in derselben VM nicht verhungert (Kaltstart, chatproblems.md #12).',
      'cd /work',
      `export PORT=${shQuote(String(spec.previewPort))}`,
      `exec nice -n 19 ionice -c 3 sh -c ${shQuote(spec.devCommand)}`,
      '',
    ].join('\n'),
    'daemon-run.sh': [
      '#!/bin/sh',
      'export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
      `. ${VM_ETC_DIR}/daemon.env.sh`,
      'cd /work',
      `exec bun ${VM_BIN_DIR}/main.js`,
      '',
    ].join('\n'),
  };
}

function buildMonitFiles(spec: VmServicesSpec): Record<string, string> {
  // monit hält Kinder nicht selbst: Start-Scripte lösen den Prozess per setsid
  // ab und schreiben ein Pidfile (monit-Vertrag); Stop killt die Prozessgruppe.
  const startScript = (runScript: string, pidfile: string, log: string): string =>
    [
      '#!/bin/sh',
      `mkdir -p ${RUN_DIR}`,
      `setsid /bin/sh ${VM_ETC_DIR}/${runScript} >>${log} 2>&1 &`,
      `echo $! >${pidfile}`,
      '',
    ].join('\n');
  const stopScript = (pidfile: string): string =>
    [
      '#!/bin/sh',
      `[ -f ${pidfile} ] && kill -TERM -- -"$(cat ${pidfile})" 2>/dev/null`,
      `rm -f ${pidfile}`,
      'exit 0',
      '',
    ].join('\n');

  const monitrc = [
    '# macvibes VM-Supervision — generiert, nicht editieren.',
    'set daemon 2',
    'set log /var/log/monit.log',
    `set httpd port ${MONIT_HTTPD_PORT}`,
    '    allow 0.0.0.0/0.0.0.0',
    '',
    `check process devserver with pidfile ${DEVSERVER_PIDFILE}`,
    `  start program = "/bin/sh ${VM_ETC_DIR}/devserver-start.sh"`,
    `  stop program = "/bin/sh ${VM_ETC_DIR}/devserver-stop.sh"`,
    '  # Startphase geduldig (Vite/bun booten langsam); Crash erkennt der',
    '  # Prozess-Check ohnehin nach einem Zyklus.',
    `  if failed port ${spec.previewPort} for 30 cycles then restart`,
    '  if 5 restarts within 40 cycles then unmonitor',
    '',
    `check process agent-daemon with pidfile ${DAEMON_PIDFILE}`,
    `  start program = "/bin/sh ${VM_ETC_DIR}/daemon-start.sh"`,
    `  stop program = "/bin/sh ${VM_ETC_DIR}/daemon-stop.sh"`,
    '',
  ].join('\n');

  return {
    monitrc,
    'devserver-start.sh': startScript(
      'devserver-run.sh',
      DEVSERVER_PIDFILE,
      '/var/log/macvibes-devserver.log',
    ),
    'devserver-stop.sh': stopScript(DEVSERVER_PIDFILE),
    'daemon-start.sh': startScript(
      'daemon-run.sh',
      DAEMON_PIDFILE,
      '/var/log/macvibes-agent-daemon.log',
    ),
    'daemon-stop.sh': stopScript(DAEMON_PIDFILE),
  };
}

export function buildVmServices(spec: VmServicesSpec): VmServices {
  return {
    files: { ...buildRunWrappers(spec), ...buildMonitFiles(spec) },
    // monit verlangt Mode 600 auf der Config — der ro-Mount garantiert das
    // nicht, deshalb wird sie beim Boot nach /etc kopiert. tini reapt Zombies;
    // -s (Subreaper) ist Pflicht: in der msb-VM ist tini NICHT das echte PID 1,
    // ohne -s bleiben tote Services als Zombies stehen und monit startet sie
    // nie neu ("process is a zombie", Live-Befund 2026-07-06).
    pid1Command: `install -m 600 ${VM_ETC_DIR}/monitrc /etc/monitrc && exec tini -s -- monit -I -c /etc/monitrc`,
  };
}

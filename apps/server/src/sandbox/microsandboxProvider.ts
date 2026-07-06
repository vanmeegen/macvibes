import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentConfigDirFor, ensureWorkspace, projectVolumeDir } from '../services/workspaceService';
import { baselineExists, baselineSnapshotName } from './baselineService';
import { httpProbe } from './httpProbe';
import { previewStatusFromMonitText } from './monitStatus';
import { msbExec, runMsb } from './msb';
import { PreviewSupervisor } from './previewSupervisor';
import { PreviewStatusPoller } from './previewStatusPoller';
import { PortAllocator } from './portService';
import { MONIT_HTTPD_PORT, VM_BIN_DIR, VM_ETC_DIR, buildVmServices } from './vmServices';
import type { VmSupervisorKind } from './vmServices';
import type { PreviewStatus, SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export { MicrosandboxError, msbAvailable, waitForExecReady } from './msb';
export type { WaitForExecReadyOptions } from './msb';
import { waitForExecReady } from './msb';

/** Konfiguration des Daemon-Transports (Spike A+C) — undefined = exec-Pfad. */
export interface AgentDaemonProviderConfig {
  /** Verzeichnis mit dem gebündelten Daemon (main.js), ro in die VM gemountet. */
  bundleDir: string;
  /** In-VM-Supervisor-Kandidat (Duell monit vs. horust, architektur.md). */
  supervisor: VmSupervisorKind;
  /** Env für den Daemon der jeweiligen Sandbox (Gateway-URL enthält den Namen). */
  envFor: (sandboxName: string) => Record<string, string>;
}

export interface MicrosandboxProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
  /** OCI-Image für die Sandbox-VMs (Default: oven/bun). */
  image: string;
  cpus: number;
  memoryMib: number;
  /** Gesetzt = Agent-Daemon-Transport: Supervisor als PID 1 statt sleep infinity. */
  agentDaemon?: AgentDaemonProviderConfig;
}

/** Sandbox-Name eines Projekts — vom Provider und vom VM-Runner genutzt. */
export function microsandboxSandboxName(projectId: string): string {
  return `macvibes-${projectId}`;
}

/** Arbeitsverzeichnis in der VM — Mountpunkt des Projekt-Workspace. */
const GUEST_WORKDIR = '/work';

/**
 * Mountpunkt der persistenten Agent-Config in der VM. Claude Code schreibt
 * dorthin (CLAUDE_CONFIG_DIR), damit die Session einen VM-Neustart übersteht (R9).
 */
export const AGENT_CONFIG_GUEST_DIR = '/agent-config';

/**
 * Echter Sandbox-Provider auf microsandbox-MicroVMs (libkrun).
 *
 * Architektur (Watchdog-fähig): Die VM läuft als **stabiler Halter**
 * (`sleep infinity` als PID 1) und überlebt so einen Dev-Server-Crash — der
 * Agent (Claude Code, per `msb exec`) verliert seine Umgebung nicht. Der
 * Preview-/Dev-Server wird von einem **host-seitigen `PreviewSupervisor`**
 * per `msb exec` gestartet, überwacht und bei Ausfall neu gestartet.
 *
 * Schnittstelle zum Template (template-agnostisch): ausschließlich
 * `devCommand` + `previewPort` + PORT-Env aus templates.json.
 */
export class MicrosandboxSandboxProvider implements SandboxProvider {
  // Geteilt über ALLE Sandboxen dieses Providers → kollisionsfreie Host-Ports
  // auch bei parallelen Starts (zwei pwa-Projekte wollen beide previewPort 5173).
  private readonly ports = new PortAllocator();

  constructor(private readonly config: MicrosandboxProviderConfig) {}

  async start(context: SandboxContext): Promise<SandboxHandle> {
    const workspaceDir = await ensureWorkspace({
      macvibesHome: this.config.macvibesHome,
      bareRepoPath: this.config.bareRepoPath,
      projectId: context.projectId,
      branchName: context.branchName,
    });
    // Persistente Agent-Config (Claude-Sessiondaten) — überlebt VM-Neustarts (R9).
    const agentConfigDir = agentConfigDirFor(this.config.macvibesHome, context.projectId);
    mkdirSync(agentConfigDir, { recursive: true });

    const hostPort = await this.ports.allocate(context.previewPort);
    const name = microsandboxSandboxName(context.projectId);

    // Baseline-Fork (B5b): node_modules kommt vorinstalliert aus dem Snapshot
    // und wird in den gemounteten Workspace gelinkt — kein Install zur Laufzeit.
    const useBaseline = await baselineExists(context.templateDir);
    const bootstrap = useBaseline
      ? `[ -e node_modules ] || ln -s /baseline/work/node_modules node_modules`
      : `if [ -f package.json ] && [ ! -d node_modules ]; then bun install --silent; fi`;
    const source = useBaseline
      ? ['--snapshot', baselineSnapshotName(context.templateDir)]
      : [this.config.image];

    const commonRunArgs = [
      'run',
      '-d',
      '--no-tty',
      '--replace',
      '-q',
      '--name',
      name,
      '-v',
      `${workspaceDir}:${GUEST_WORKDIR}`,
      '-v',
      `${agentConfigDir}:${AGENT_CONFIG_GUEST_DIR}`,
      '-w',
      GUEST_WORKDIR,
      // 0.0.0.0: Preview ist im LAN erreichbar (R7/NFR).
      '-p',
      `0.0.0.0:${hostPort}:${context.previewPort}`,
      // Egress: öffentliches Internet (bun/npm) + Host-Gateway für den
      // Credential-Proxy (host.microsandbox.internal, B5c). Private Netze
      // sonst gesperrt — der Agent kommt nicht ins LAN.
      '--net-rule',
      'allow@public,allow@172.16.0.0/12',
      '-c',
      String(this.config.cpus),
      '-m',
      `${this.config.memoryMib}M`,
    ];

    // Daemon-Transport (Spike A+C): In-VM-Supervisor als PID 1 übernimmt
    // Dev-Server UND Agent-Daemon — kein sleep-infinity-Halter, kein
    // host-seitiger Watchdog, kein Stagger (nur EINE msb-exec-Session je Boot).
    const daemon = this.config.agentDaemon;
    if (daemon !== undefined) {
      return this.startWithDaemon({ context, name, hostPort, bootstrap, source, commonRunArgs });
    }

    // VM als stabiler Halter starten (Dev-Server läuft NICHT als PID 1).
    await runMsb([
      ...commonRunArgs,
      ...source,
      '--',
      'sh',
      '-c',
      `${bootstrap}; exec sleep infinity`,
    ]);

    // `msb run -d` kehrt zurück, bevor der Gast-Agent-Endpunkt für `msb exec`
    // bereit ist. Ohne dieses Warten scheitern die ersten Prompts/Dev-Server-
    // Starts mit "no agent endpoint found" (Race, 2026-07-05).
    await waitForExecReady(name);

    // Watchdog: Dev-Server per `msb exec` starten + überwachen (host-seitig).
    // `nice`/`ionice`: der Dev-Server-Boot (Vite/bun-Kompilierung) ist CPU-/IO-
    // intensiv und würde einen gleichzeitigen ersten Agent-Turn in derselben VM
    // massiv ausbremsen (~30s). Mit niedrigster Priorität bekommt der Agent
    // (claude, Standard-Priorität) Vorrang; der Dev-Server bootet, wenn CPU frei ist.
    const supervisor = new PreviewSupervisor({
      spawn: () =>
        msbExec(
          name,
          [
            'sh',
            '-c',
            `exec nice -n 19 ionice -c 3 sh -c '${context.devCommand.replaceAll("'", "'\\''")}'`,
          ],
          { PORT: String(context.previewPort) },
          GUEST_WORKDIR,
        ),
      probe: () => httpProbe(`http://localhost:${hostPort}/`),
      onStatusChange: (status) => console.log(`Preview ${context.projectId}: ${status}`),
    });
    // GESTAFFELT starten: werden die Dev-Server-exec-Session und der erste
    // claude-exec (Prompt direkt nach dem Öffnen) GLEICHZEITIG etabliert,
    // verliert claudes Session in microsandbox deterministisch ihren Output
    // (Session-Etablierungs-Race; erster Turn wirkt "stumm"). 1,5s Versatz
    // lässt claudes Session zuerst stehen; die Preview braucht ohnehin Sekunden.
    const supervisorDelay = setTimeout(() => supervisor.start(), 1_500);

    return {
      previewHostPort: hostPort,
      previewStatus: (): PreviewStatus => supervisor.getStatus(),
      stop: async () => {
        clearTimeout(supervisorDelay);
        this.ports.release(hostPort);
        await supervisor.stop();
        await this.stopVm(name);
      },
    };
  }

  /** Daemon-Transport: Supervisor (monit/horust) als PID 1, Status wird nur gelesen. */
  private async startWithDaemon(params: {
    context: SandboxContext;
    name: string;
    hostPort: number;
    bootstrap: string;
    source: string[];
    commonRunArgs: string[];
  }): Promise<SandboxHandle> {
    const { context, name, hostPort, bootstrap, source, commonRunArgs } = params;
    const daemon = this.config.agentDaemon as AgentDaemonProviderConfig;

    const services = buildVmServices({
      supervisor: daemon.supervisor,
      devCommand: context.devCommand,
      previewPort: context.previewPort,
      daemonEnv: daemon.envFor(name),
    });

    // Service-Konfiguration pro Projekt aufs Volume schreiben (ro-Mount).
    const etcDir = join(projectVolumeDir(this.config.macvibesHome, context.projectId), 'vm-etc');
    rmSync(etcDir, { recursive: true, force: true });
    for (const [relativePath, content] of Object.entries(services.files)) {
      const filePath = join(etcDir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }

    // monit hat eine HTTP-Status-API — nur auf dem Host (127.0.0.1) gemappt.
    const statusHostPort =
      daemon.supervisor === 'monit' ? await this.ports.allocate(MONIT_HTTPD_PORT) : null;

    await runMsb([
      ...commonRunArgs,
      '-v',
      `${etcDir}:${VM_ETC_DIR}:ro`,
      '-v',
      `${daemon.bundleDir}:${VM_BIN_DIR}:ro`,
      ...(statusHostPort !== null ? ['-p', `127.0.0.1:${statusHostPort}:${MONIT_HTTPD_PORT}`] : []),
      ...source,
      '--',
      'sh',
      '-c',
      `${bootstrap}; ${services.pid1Command}`,
    ]);
    await waitForExecReady(name);

    const poller = new PreviewStatusPoller({
      fetchStatus:
        statusHostPort !== null
          ? async (): Promise<PreviewStatus> => {
              const response = await fetch(
                `http://127.0.0.1:${statusHostPort}/_status?format=text`,
                { signal: AbortSignal.timeout(1500) },
              );
              if (!response.ok) throw new Error(`monit-Status ${response.status}`);
              return previewStatusFromMonitText(await response.text());
            }
          : async (): Promise<PreviewStatus> => {
              // horust hat keine Status-API — passiver Probe des Dev-Servers
              // (Restart-/Crash-Loop-Details sieht nur horust selbst).
              if (await httpProbe(`http://localhost:${hostPort}/`)) return 'ready';
              throw new Error('Preview nicht erreichbar');
            },
      onStatusChange: (status) => console.log(`Preview ${context.projectId}: ${status}`),
    });
    poller.start();

    return {
      previewHostPort: hostPort,
      previewStatus: (): PreviewStatus => poller.getStatus(),
      stop: async () => {
        poller.stop();
        this.ports.release(hostPort);
        if (statusHostPort !== null) this.ports.release(statusHostPort);
        await this.stopVm(name);
      },
    };
  }

  private async stopVm(name: string): Promise<void> {
    try {
      await runMsb(['stop', name]);
    } catch (error) {
      console.error(`msb stop ${name}:`, error);
    }
    try {
      await runMsb(['rm', name]);
    } catch (error) {
      console.error(`msb rm ${name}:`, error);
    }
  }
}

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentConfigDirFor, ensureWorkspace, projectVolumeDir } from '../services/workspaceService';
import { baselineBootstrapScript, baselineExists, baselineSnapshotName } from './baselineService';
import { httpProbe } from './httpProbe';
import { gateReadyWithProbe, previewStatusFromMonitText } from './monitStatus';
import { MicrosandboxError, runMsb, waitForExecReady } from './msb';
import { PreviewStatusPoller } from './previewStatusPoller';
import { PortAllocator } from './portService';
import { MONIT_HTTPD_PORT, VM_BIN_DIR, VM_ETC_DIR, buildVmServices } from './vmServices';
import type { PreviewStatus, SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export { msbAvailable } from './msb';

/** Konfiguration des Agent-Daemons (einziger Transport in die VM). */
export interface AgentDaemonProviderConfig {
  /** Verzeichnis mit dem gebündelten Daemon (main.js), ro in die VM gemountet. */
  bundleDir: string;
  /** Env für den Daemon der jeweiligen Sandbox (Gateway-URL enthält den Namen). */
  envFor: (sandboxName: string) => Record<string, string>;
}

export interface MicrosandboxProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
  /** OCI-Image für die Sandbox-VMs (Default: oven/bun, Version gepinnt). */
  image: string;
  cpus: number;
  memoryMib: number;
  /** Agent-Daemon-Transport — Pflicht: die VM läuft immer unter tini+monit. */
  agentDaemon: AgentDaemonProviderConfig;
}

/** Sandbox-Name eines Projekts — vom Provider und vom Runner genutzt. */
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
 * PID 1 der VM ist ein In-VM-Supervisor (tini + monit, siehe vmServices.ts),
 * der Dev-Server UND Agent-Daemon startet, überwacht und bei Crash neu
 * startet — kein host-seitiger Watchdog, kein msb exec im Agent-Pfad. Der
 * Daemon wählt sich ausgehend ins Host-Gateway ein (architektur.md, A+C).
 *
 * Voraussetzung ist der Baseline-Snapshot des Templates (`bun run baselines`):
 * er enthält node_modules, das Agent SDK und tini/monit. Ohne Baseline kann
 * die VM nicht booten — das meldet start() als klaren Fehler.
 *
 * Schnittstelle zum Template (template-agnostisch): ausschließlich
 * `devCommand` + `previewPort` + PORT-Env aus templates.json. Der
 * Preview-Status wird nur noch GELESEN (monit-HTTP-API + HTTP-Probe).
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

    // Baseline-Fork (B5b) ist Pflicht: der Snapshot enthält neben node_modules
    // auch tini/monit (PID 1) und das Agent SDK — ohne ihn bootet die VM nicht.
    if (!(await baselineExists(context.templateDir))) {
      throw new MicrosandboxError(
        `Keine Baseline für Template „${context.templateDir}" — bitte einmal ` +
          '`bun run baselines` ausführen (Supervisor und Agent-SDK stecken im Snapshot).',
      );
    }

    const name = microsandboxSandboxName(context.projectId);
    const hostPort = await this.ports.allocate(context.previewPort);
    // monit-Status-API — nur auf dem Host (127.0.0.1) gemappt, füttert previewStatus.
    const statusHostPort = await this.ports.allocate(MONIT_HTTPD_PORT);

    const services = buildVmServices({
      devCommand: context.devCommand,
      previewPort: context.previewPort,
      daemonEnv: this.config.agentDaemon.envFor(name),
    });

    // Service-Konfiguration pro Projekt aufs Volume schreiben (ro-Mount).
    // Owner-only (0700/0600): daemon.env.sh enthält das Proxy-Token — andere
    // Host-Nutzer haben darauf nichts zu suchen (nicht auf die umask verlassen).
    const etcDir = join(projectVolumeDir(this.config.macvibesHome, context.projectId), 'vm-etc');
    rmSync(etcDir, { recursive: true, force: true });
    mkdirSync(etcDir, { recursive: true, mode: 0o700 });
    for (const [relativePath, content] of Object.entries(services.files)) {
      const filePath = join(etcDir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, content, { mode: 0o600 });
    }

    // node_modules kommt vorinstalliert aus dem Snapshot und wird in den
    // gemounteten Workspace gelinkt — kein Install zur Laufzeit. Verlinkt ALLE
    // node_modules (auch apps/<x>/node_modules bei Workspace-Templates wie
    // fullstack), nicht nur das Root — sonst fehlt z. B. vite in .bin.
    const bootstrap = baselineBootstrapScript;

    await runMsb([
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
      '-v',
      `${etcDir}:${VM_ETC_DIR}:ro`,
      '-v',
      `${this.config.agentDaemon.bundleDir}:${VM_BIN_DIR}:ro`,
      '-w',
      GUEST_WORKDIR,
      // 0.0.0.0: Preview ist im LAN erreichbar (R7/NFR).
      '-p',
      `0.0.0.0:${hostPort}:${context.previewPort}`,
      '-p',
      `127.0.0.1:${statusHostPort}:${MONIT_HTTPD_PORT}`,
      // Egress: öffentliches Internet (bun/npm) + Host-Gateway für den
      // Credential-Proxy (host.microsandbox.internal, B5c). Private Netze
      // sonst gesperrt — der Agent kommt nicht ins LAN.
      '--net-rule',
      'allow@public,allow@172.16.0.0/12',
      '-c',
      String(this.config.cpus),
      '-m',
      `${this.config.memoryMib}M`,
      '--snapshot',
      baselineSnapshotName(context.templateDir),
      '--',
      'sh',
      '-c',
      `${bootstrap}; ${services.pid1Command}`,
    ]);
    // `msb run -d` kehrt zurück, bevor der Gast-Agent-Endpunkt bereit ist —
    // ohne dieses Warten scheitern frühe execs ("no agent endpoint found").
    await waitForExecReady(name);

    const poller = new PreviewStatusPoller({
      fetchStatus: async (): Promise<PreviewStatus> => {
        const response = await fetch(`http://127.0.0.1:${statusHostPort}/_status?format=text`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!response.ok) throw new Error(`monit-Status ${response.status}`);
        // 'ready' erst, wenn der Dev-Server WIRKLICH HTTP beantwortet — monit
        // sieht nur den Prozess (siehe gateReadyWithProbe).
        return gateReadyWithProbe(previewStatusFromMonitText(await response.text()), () =>
          httpProbe(`http://localhost:${hostPort}/`),
        );
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
        this.ports.release(statusHostPort);
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

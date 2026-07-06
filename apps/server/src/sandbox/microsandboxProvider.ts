import { mkdirSync } from 'node:fs';
import { agentConfigDirFor, ensureWorkspace } from '../services/workspaceService';
import { baselineExists, baselineSnapshotName } from './baselineService';
import { httpProbe } from './httpProbe';
import { MicrosandboxError, msbExec, runMsb } from './msb';
import { PreviewSupervisor } from './previewSupervisor';
import { PortAllocator } from './portService';
import type { PreviewStatus, SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export { MicrosandboxError, msbAvailable } from './msb';

export interface MicrosandboxProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
  /** OCI-Image für die Sandbox-VMs (Default: oven/bun). */
  image: string;
  cpus: number;
  memoryMib: number;
}

/** Sandbox-Name eines Projekts — vom Provider und vom VM-Runner genutzt. */
export function microsandboxSandboxName(projectId: string): string {
  return `macvibes-${projectId}`;
}

export interface WaitForExecReadyOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Exec-Probe (injizierbar für Tests). Wirft, solange die VM nicht bereit ist. */
  probe?: (name: string) => Promise<unknown>;
}

/**
 * Wartet, bis `msb exec` in der Sandbox funktioniert (Gast-Agent-Endpunkt
 * bereit). Verhindert die "no agent endpoint found"-Race beim ersten Prompt.
 */
export async function waitForExecReady(
  name: string,
  options: WaitForExecReadyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const probe = options.probe ?? ((n: string) => runMsb(['exec', n, '--', 'true']));

  const start = Date.now();
  let lastError: unknown = null;
  for (;;) {
    try {
      await probe(name);
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new MicrosandboxError(`Sandbox ${name} wurde nicht exec-bereit: ${String(lastError)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
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

    // VM als stabiler Halter starten (Dev-Server läuft NICHT als PID 1).
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
      },
    };
  }
}

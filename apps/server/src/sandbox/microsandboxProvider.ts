import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  agentConfigDirFor,
  bunCacheDirFor,
  ensureWorkspace,
  projectVolumeDir,
} from '../core/workspaceService';
import { AGENT_CONFIG_GUEST_DIR, GUEST_WORKDIR } from '../core/vmContract';
import { baselineBootstrapScript, baselineExists, baselineSnapshotName } from './baselineService';
import { httpProbe } from '../preview/httpProbe';
import {
  removeSandbox,
  SandboxRuntimeError,
  startSandbox,
  stopSandbox,
  waitForSandboxReady,
  type SandboxSpec,
} from './msbClient';
import { PreviewStatusPoller } from './previewStatusPoller';
import { PushedPreviewStatus } from './previewStatusPush';
import { PortAllocator } from './portService';
import { MONIT_HTTPD_PORT, VM_BIN_DIR, VM_ETC_DIR, buildVmServices } from './vmServices';
import type { PreviewStatus, SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export { msbAvailable } from './msbClient';

/** Konfiguration des Agent-Daemons (einziger Transport in die VM). */
export interface AgentDaemonProviderConfig {
  /** Verzeichnis mit dem gebündelten Daemon (main.js), ro in die VM gemountet. */
  bundleDir: string;
  /** Env für den Daemon der jeweiligen Sandbox (Gateway-URL enthält den Namen). */
  envFor: (sandboxName: string) => Record<string, string>;
  /** Entwertet das VM-Token beim Stoppen — sonst gilt es unbegrenzt weiter. */
  revokeToken?: (sandboxName: string) => void;
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
  /**
   * Abo auf die preview-status-Pushes des VM-Daemons (ADR 0001) — in der
   * Produktion das Agent-Gateway. Rückgabe: Abbestellen.
   */
  subscribePreviewStatus: (
    sandbox: string,
    listener: (status: PreviewStatus) => void,
  ) => () => void;
  /**
   * Warten, bis der Gast-Agent-Endpunkt bereit ist. Injizierbar, damit der
   * Aufräumpfad bei einem fehlgeschlagenen Start testbar ist (Default:
   * `waitForSandboxReady` aus msbClient.ts).
   */
  waitForReady?: (sandboxName: string) => Promise<void>;
  /**
   * Die VM starten. Injizierbar aus demselben Grund wie `waitForReady`: der
   * Aufräumpfad muss auch für einen Fehler im START selbst prüfbar sein
   * (Default: `startSandbox` aus msbClient.ts).
   */
  startSandbox?: (spec: SandboxSpec) => Promise<void>;
  /**
   * Host-Port-Vergabe. Injizierbar, damit ein Test beobachten kann, ob ein
   * gescheiterter Start seinen Port wieder freigibt (Default: eigener
   * Allocator pro Provider).
   */
  ports?: PortAllocator;
  /**
   * Idle-Frist der VM in Sekunden (ADR 0003). Wird aus dem host-seitigen
   * Idle-Timer abgeleitet (idleMs + 15 min) — bewusst kein eigener Parameter,
   * damit beide Werte nicht auseinanderlaufen können.
   */
  vmIdleTimeoutSecs?: number;
}

/** Ab wann ein Daemon-Status-Push als veraltet gilt (Daemon pusht alle ≤5 s). */
const PUSH_STALE_MS = 15_000;

/** Sandbox-Name eines Projekts — vom Provider und vom Runner genutzt. */
export function microsandboxSandboxName(projectId: string): string {
  return `macvibes-${projectId}`;
}

/**
 * Hostname, unter dem eine msb-VM ihren Host erreicht (NAT-Alias des
 * libkrun-Gateways). Das ist msb-spezifische Netz-Topologie, KEIN
 * backend-neutraler Host↔VM-Vertrag — ein anderes VM-Backend (z. B.
 * Windows-Stufe 2) hat einen anderen Weg zum Host. Deshalb wohnt der Name
 * hier beim msb-Provider und wird von der Composition Root in die
 * agent-Schicht injiziert (buildVmAgentEnv, Gateway-URL), statt dort
 * hartkodiert zu sein — ein Backend-Wechsel tauscht nur die Injektion.
 */
export const MSB_HOST_ALIAS = 'host.microsandbox.internal';

/**
 * Das `-p`-Argument für `msb run`: der Preview-Port der VM wird ausschließlich
 * an das Host-Loopback gebunden (H1).
 *
 * Früher stand hier `0.0.0.0`, weil das iframe laut R7 direkt auf den
 * gemappten Port zeigte. Seit dem Preview-Gateway ist das überholt: das iframe
 * zeigt auf das Gateway (`PreviewModel.ts`), und das Gateway spricht die VM nur
 * über 127.0.0.1 an (`previewGateway.ts`), ebenso die Status-Probe. Die
 * LAN-Bindung hatte damit keine Funktion mehr, umging aber beide Kontrollen des
 * Gateways: die Session-Prüfung (F19) und das Entfernen des Session-Cookies auf
 * dem Weg in die VM (F2). Für Remote/LAN wird nur der Gateway-Port gebraucht.
 */
export function previewPortMapping(hostPort: number, guestPort: number): string {
  return `127.0.0.1:${hostPort}:${guestPort}`;
}

/**
 * Baut ein `-v`-Argument (`QUELLE:ZIEL[:OPTIONEN]`) und löst die Quelle vorher
 * zu einem echten Pfad auf.
 *
 * msb 0.6.8 folgt symbolischen Links in der Mount-Quelle nicht mehr (Migration
 * `migrate_bind_rootfs_source`) und bricht mit „Not a directory" ab. Auf macOS
 * trifft das jeden Pfad unter `$TMPDIR`, weil `/var` ein Symlink auf
 * `/private/var` ist — im Produktivbetrieb liegt `~/macvibes` dagegen auf einem
 * echten Pfad, weshalb dort nichts brach. Auflösen ist unabhängig davon
 * richtig: msb bekommt so immer genau den Pfad, den es auch mountet.
 */
export function mountSource(hostPath: string, guestPath: string, options?: string): string {
  const quelle = realpathSync(hostPath);
  return options === undefined ? `${quelle}:${guestPath}` : `${quelle}:${guestPath}:${options}`;
}

/**
 * Mountpunkt der persistenten Agent-Config in der VM. Claude Code schreibt
 * dorthin (CLAUDE_CONFIG_DIR), damit die Session einen VM-Neustart übersteht (R9).
 * Teil des Host↔VM-Vertrags (core/vmContract): die VM nutzt denselben Pfad in
 * ihrer Agent-Umgebung (agent/vmAgentEnv) — Single Source of Truth dort.
 */
export { AGENT_CONFIG_GUEST_DIR };

/**
 * Mountpunkt des persistenten Bun-Install-Caches (ADR 0002): hält die per
 * `bun add` nachinstallierten Delta-Pakete über VM-Neustarts hinweg —
 * der Boot-Delta-Install bedient sich daraus (offline-fähig).
 */
export const BUN_CACHE_GUEST_DIR = '/bun-cache';

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
  private readonly ports: PortAllocator;

  constructor(private readonly config: MicrosandboxProviderConfig) {
    this.ports = config.ports ?? new PortAllocator();
  }

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
    // Persistenter Bun-Cache (ADR 0002) — Delta-Pakete überleben VM-Neustarts.
    const bunCacheDir = bunCacheDirFor(this.config.macvibesHome, context.projectId);
    mkdirSync(bunCacheDir, { recursive: true });

    // Baseline-Fork (B5b) ist Pflicht: der Snapshot enthält neben node_modules
    // auch tini/monit (PID 1) und das Agent SDK — ohne ihn bootet die VM nicht.
    if (!(await baselineExists(context.templateDir))) {
      throw new SandboxRuntimeError(
        `Keine Baseline für Template „${context.templateDir}" — bitte einmal ` +
          '`bun run baselines` ausführen (Supervisor und Agent-SDK stecken im Snapshot).',
      );
    }

    const name = microsandboxSandboxName(context.projectId);
    const hostPort = await this.ports.allocate(context.previewPort);

    // Ab hier sind Host-Port UND VM-Token vergeben (envFor in bootVm). Jeder
    // Fehler danach MUSS beides zurücknehmen und eine womöglich schon laufende
    // VM stoppen — sonst bliebe eine MicroVM mit gültigem Token übrig, für die
    // es keinen Handle und damit kein stop() mehr gibt: Credential- und
    // Egress-Proxy stünden ihr weiter offen, obwohl der Start für den Aufrufer
    // gescheitert ist. Früher lag dieses Aufräumen NUR im waitForReady-Pfad;
    // ein Wurf aus dem Start selbst (msb-Schemakonflikt, fehlender Snapshot,
    // OOM) ging daran vorbei und leckte Port und Token.
    try {
      await this.bootVm(context, name, hostPort, { workspaceDir, agentConfigDir, bunCacheDir });
    } catch (error) {
      this.config.agentDaemon.revokeToken?.(name);
      this.ports.release(hostPort);
      await this.stopVm(name);
      throw error;
    }

    // Preview-Status: frische Daemon-Pushes zählen (monit-Detailtiefe), ohne
    // sie entscheidet die HTTP-Probe auf den Preview-Port (ADR 0001).
    // Der Push ist der AUSLÖSER (sofortiger Statuswechsel), das Pollen nur noch
    // der unabhängige Wächter für den Fall, dass der Daemon stumm bleibt.
    let poller: PreviewStatusPoller | null = null;
    const pushed = new PushedPreviewStatus({
      staleMs: PUSH_STALE_MS,
      onPush: (status) => poller?.notify(status),
    });
    const unsubscribeStatus = this.config.subscribePreviewStatus(name, (status) =>
      pushed.receive(status),
    );
    poller = new PreviewStatusPoller({
      fetchStatus: pushed.fetchStatus(() => httpProbe(`http://localhost:${hostPort}/`)),
      onStatusChange: (status) => console.log(`Preview ${context.projectId}: ${status}`),
    });
    poller.start();

    return {
      previewHostPort: hostPort,
      previewStatus: (): PreviewStatus => poller.getStatus(),
      stop: async () => {
        // Token SOFORT entwerten: ein aus der VM abgeflossenes Token öffnete
        // sonst Credential- und Egress-Proxy noch lange nach ihrem Ende.
        this.config.agentDaemon.revokeToken?.(name);
        unsubscribeStatus();
        poller.stop();
        this.ports.release(hostPort);
        await this.stopVm(name);
      },
    };
  }

  /**
   * Schreibt die Service-Konfiguration aufs Volume, startet die VM und wartet,
   * bis ihr Agent-Endpunkt bereit ist. Wirft dieser Weg an irgendeiner Stelle,
   * räumt der Aufrufer Port, Token und VM auf.
   */
  private async bootVm(
    context: SandboxContext,
    name: string,
    hostPort: number,
    dirs: { workspaceDir: string; agentConfigDir: string; bunCacheDir: string },
  ): Promise<void> {
    const services = buildVmServices({
      devCommand: context.devCommand,
      previewPort: context.previewPort,
      daemonEnv: {
        ...this.config.agentDaemon.envFor(name),
        // Preview-Status-Push (ADR 0001): der Daemon liest monit + Dev-Server
        // in der VM lokal — dafür braucht er die Ports.
        MACVIBES_PREVIEW_PORT: String(context.previewPort),
        MACVIBES_MONIT_PORT: String(MONIT_HTTPD_PORT),
        // Ein Mechanismus, zwei Nutzer (ADR 0002): gilt für bun add des Agenten
        // UND für den Boot-Delta-Install in devserver-run.sh (sourcet die Env).
        BUN_INSTALL_CACHE_DIR: BUN_CACHE_GUEST_DIR,
      },
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
    // gemounteten Workspace gelinkt — kein VOLL-Install zur Laufzeit; das
    // Delta aus bun.lock zieht devserver-run.sh beim Start (ADR 0002).
    // Verlinkt ALLE node_modules (auch apps/<x>/node_modules bei
    // Workspace-Templates wie fullstack), nicht nur das Root — sonst fehlt
    // z. B. vite in .bin.
    const bootstrap = baselineBootstrapScript;

    await (this.config.startSandbox ?? startSandbox)({
      name,
      snapshot: baselineSnapshotName(context.templateDir),
      workdir: GUEST_WORKDIR,
      cpus: this.config.cpus,
      memoryMib: this.config.memoryMib,
      previewHostPort: hostPort,
      previewGuestPort: context.previewPort,
      mounts: [
        { host: dirs.workspaceDir, guest: GUEST_WORKDIR },
        { host: dirs.agentConfigDir, guest: AGENT_CONFIG_GUEST_DIR },
        { host: dirs.bunCacheDir, guest: BUN_CACHE_GUEST_DIR },
        { host: etcDir, guest: VM_ETC_DIR, readonly: true },
        { host: this.config.agentDaemon.bundleDir, guest: VM_BIN_DIR, readonly: true },
      ],
      // Absoluter Pfad: das SDK lehnt ein blosses 'sh' ab (die CLI nahm es an).
      command: ['/bin/sh', '-c', `${bootstrap}; ${services.pid1Command}`],
      ...(this.config.vmIdleTimeoutSecs !== undefined
        ? { idleTimeoutSecs: this.config.vmIdleTimeoutSecs }
        : {}),
    });
    // `msb run -d` kehrt zurück, bevor der Gast-Agent-Endpunkt bereit ist —
    // ohne dieses Warten scheitern frühe execs ("no agent endpoint found").
    await (this.config.waitForReady ?? waitForSandboxReady)(name);
  }

  private async stopVm(name: string): Promise<void> {
    // Eine bereits verschwundene Sandbox ist kein Fehler mehr (msbClient
    // unterscheidet das), ein echter Fehler wird weiterhin geloggt statt
    // verschluckt — Konvention: keine stillen Ausnahmen.
    try {
      await stopSandbox(name);
    } catch (error) {
      console.error(`Sandbox ${name} stoppen:`, error);
    }
    try {
      await removeSandbox(name);
    } catch (error) {
      console.error(`Sandbox ${name} entfernen:`, error);
    }
  }
}

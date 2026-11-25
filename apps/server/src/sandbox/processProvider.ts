import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnShellCommand } from '../core/exec';
import { ensureWorkspace } from '../core/workspaceService';
import { httpProbe } from '../preview/httpProbe';
import { ProcessSupervisor, type SupervisedProcess } from '../core/processSupervisor';
import { PortAllocator } from './portService';
import type { PreviewStatus, SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export interface ProcessProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
}

/**
 * Prozess-basierter Provider: arbeitet direkt auf dem Host (kein VM-Isolat).
 * Dient als Entwicklungs-/Test-Backend; der microsandbox-Provider (B5)
 * implementiert dasselbe Interface mit echten MicroVMs.
 *
 * Preview-Kontrakt (R7, template-agnostisch): das devCommand aus
 * templates.json wird mit gesetzter PORT-Env gestartet; die Plattform kennt
 * keinerlei Template-Interna. Der ProcessSupervisor startet den Dev-Server
 * bei Absturz neu — gleiches Verhalten wie in der MicroVM.
 */
export class ProcessSandboxProvider implements SandboxProvider {
  /**
   * Reserviert Vorschau-Ports über die ganze Lebensdauer einer Sandbox: zwischen
   * der Prüfung „frei?" und dem Lauschen des Dev-Servers liegen Sekunden
   * (bun install, Start). Ohne Reservierung bekam ein zweites Projekt desselben
   * Templates in dieser Zeit denselben Port.
   */
  private readonly ports = new PortAllocator();

  constructor(private readonly config: ProcessProviderConfig) {}

  async start(context: SandboxContext): Promise<SandboxHandle> {
    const workspaceDir = await ensureWorkspace({
      macvibesHome: this.config.macvibesHome,
      bareRepoPath: this.config.bareRepoPath,
      projectId: context.projectId,
      branchName: context.branchName,
    });

    const port = await this.ports.allocate(context.previewPort);
    try {
      return await this.starteMitPort(context, workspaceDir, port);
    } catch (error) {
      this.ports.release(port);
      throw error;
    }
  }

  private async starteMitPort(
    context: SandboxContext,
    workspaceDir: string,
    port: number,
  ): Promise<SandboxHandle> {
    // Delta-Install bei jedem Start (ADR 0002, Parität zur MicroVM): bei
    // vollständigem node_modules ein No-Op, sonst heilt er fehlende Pakete
    // aus bun.lock (z. B. ein bun add einer früheren Session).
    // --ignore-scripts ist Pflicht (F22): die package.json stammt aus dem
    // Workspace, den der nicht vertrauenswürdige Agent beschreibt — ohne das
    // liefen seine preinstall/postinstall-Hooks als Host-Nutzer.
    if (existsSync(join(workspaceDir, 'package.json'))) {
      const exitCode = await Bun.spawn(['bun', 'install', '--silent', '--ignore-scripts'], {
        cwd: workspaceDir,
      }).exited;
      if (exitCode !== 0) {
        // Nicht abbrechen (der Dev-Server meldet fehlende Pakete selbst), aber
        // auch nicht verschweigen — sonst sieht die Ursache wie ein Preview-Bug aus.
        console.warn(
          `bun install in ${workspaceDir} endete mit Exit-Code ${exitCode} — die Preview startet womöglich nicht.`,
        );
      }
    }

    const spawn = (): SupervisedProcess =>
      // Plattformneutral (bun exec + tree-kill): kill() beendet den ganzen
      // Prozessbaum — Dev-Server samt Kindern, auf macOS wie Windows.
      spawnShellCommand(context.devCommand, {
        cwd: workspaceDir,
        env: { ...process.env, PORT: String(port) },
        stdout: 'ignore',
        stderr: 'inherit',
      });

    const supervisor = new ProcessSupervisor({
      spawn,
      // 127.0.0.1 statt localhost: Windows löst localhost bevorzugt ::1 auf,
      // Dev-Server binden IPv4 — die Probe wäre dort nie „ready".
      probe: () => httpProbe(`http://127.0.0.1:${port}/`),
    });
    supervisor.start();

    return {
      previewHostPort: port,
      previewStatus: (): PreviewStatus => supervisor.getStatus(),
      stop: async () => {
        try {
          await supervisor.stop();
        } finally {
          // Erst NACH dem Stopp freigeben: vorher hält der Dev-Server den Port.
          this.ports.release(port);
        }
      },
    };
  }
}

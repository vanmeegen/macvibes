import type { PreviewStatus } from '../preview/status';

export type { PreviewStatus };

export type SandboxStatus = 'starting' | 'running' | 'stopping' | 'stopped';

/** Alles, was ein Provider braucht, um die Sandbox eines Projekts zu starten. */
export interface SandboxContext {
  projectId: string;
  branchName: string;
  workspaceDir: string;
  /** Aus templates.json übernommen — die Plattform kennt keine Template-Interna. */
  templateDir: string;
  devCommand: string;
  previewPort: number;
}

export interface SandboxHandle {
  /**
   * Host-Port, auf dem die Preview erreichbar ist. Jede laufende Sandbox hat
   * einen — „keine Preview" gibt es nur ohne Sandbox (SandboxManager liefert
   * dann null).
   */
  previewHostPort: number;
  /** Aktueller Zustand des Dev-Servers (für das UI-Overlay). */
  previewStatus(): PreviewStatus;
  stop(): Promise<void>;
}

export interface SandboxProvider {
  start(context: SandboxContext): Promise<SandboxHandle>;
}

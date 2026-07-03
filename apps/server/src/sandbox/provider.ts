export type SandboxStatus = 'starting' | 'running' | 'stopping' | 'stopped';

/** Alles, was ein Provider braucht, um die Sandbox eines Projekts zu starten. */
export interface SandboxContext {
  projectId: string;
  branchName: string;
  workspaceDir: string;
  /** Aus templates.json übernommen — die Plattform kennt keine Template-Interna. */
  devCommand: string;
  previewPort: number;
}

export interface SandboxHandle {
  /** URL, unter der die Preview vom Host aus erreichbar ist (null: keine Preview). */
  previewUrl: string | null;
  stop(): Promise<void>;
}

export interface SandboxProvider {
  start(context: SandboxContext): Promise<SandboxHandle>;
}

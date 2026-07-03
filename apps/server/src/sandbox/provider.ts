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
  /**
   * Host-Port, auf dem die Preview erreichbar ist (null: keine Preview).
   * Die URL baut der Client mit seinem eigenen Hostnamen (LAN, R7).
   */
  previewHostPort: number | null;
  stop(): Promise<void>;
}

export interface SandboxProvider {
  start(context: SandboxContext): Promise<SandboxHandle>;
}

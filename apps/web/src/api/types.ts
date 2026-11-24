/**
 * Typen des GraphQL-API-Vertrags (Server unter /graphql).
 */

/** Nutzerrolle (Server: db/schema/users). */
export type UserRole = 'user' | 'admin';

/** Lebenszyklus der Sandbox (Server: sandbox/provider). */
export type SandboxStatus = 'starting' | 'running' | 'stopping' | 'stopped';

/** Zustand des Dev-Servers in der Sandbox (Server: preview/status). */
export type PreviewStatus = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';

export interface User {
  id: string;
  username: string;
  role: UserRole;
  approved: boolean;
}

export interface Template {
  name: string;
  description: string;
  dir: string;
}

export interface Project {
  id: string;
  name: string;
  templateDir: string;
  owner: User;
  /** Gewähltes Agenten-Modell (Dropdown im Chat, pro Projekt). */
  agentModel: string;
  lastActivityAt: string;
  sandboxStatus: SandboxStatus;
  /** Läuft gerade ein Agent-Turn in diesem Projekt? */
  turnActive: boolean;
  previewStatus: PreviewStatus;
}

/** Wählbares Agenten-Modell (Katalog vom Server). */
export interface AgentModelInfo {
  id: string;
  label: string;
}

type ChatRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error';

export interface ChatMessage {
  id: string;
  projectId: string;
  turnId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

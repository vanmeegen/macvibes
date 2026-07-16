/**
 * Typen des GraphQL-API-Vertrags (Server unter /graphql).
 */

export interface User {
  id: string;
  username: string;
  role: string;
  approved: boolean;
  createdAt: string;
}

export interface Template {
  name: string;
  description: string;
  dir: string;
  devCommand: string;
  previewPort: number;
}

export interface Project {
  id: string;
  name: string;
  branchName: string;
  templateDir: string;
  owner: User;
  /** Gewähltes Agenten-Modell (Dropdown im Chat, pro Projekt). */
  agentModel: string;
  createdAt: string;
  lastActivityAt: string;
  sandboxStatus: string;
  /** Läuft gerade ein Agent-Turn in diesem Projekt? */
  turnActive: boolean;
  previewHostPort: number | null;
  previewStatus: string;
}

/** Wählbares Agenten-Modell (Katalog vom Server). */
export interface AgentModelInfo {
  id: string;
  label: string;
  /** Lokales (langsames) Modell — Hinweis im UI. */
  slow: boolean;
}

export type ChatRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error';

export interface ChatMessage {
  id: string;
  projectId: string;
  turnId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

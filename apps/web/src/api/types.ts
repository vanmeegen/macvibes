/**
 * Typen des GraphQL-API-Vertrags (Server unter /graphql).
 */

export interface User {
  id: string;
  username: string;
  role: string;
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
  sandboxStatus: string;
  /** Läuft gerade ein Agent-Turn in diesem Projekt? */
  turnActive: boolean;
  previewStatus: string;
}

/** Wählbares Agenten-Modell (Katalog vom Server). */
export interface AgentModelInfo {
  id: string;
  label: string;
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

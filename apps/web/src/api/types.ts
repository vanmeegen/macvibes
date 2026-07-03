/**
 * Typen des GraphQL-API-Vertrags (Server unter /graphql).
 */

export interface User {
  id: string;
  username: string;
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
  createdAt: string;
  lastActivityAt: string;
  sandboxStatus: string;
}

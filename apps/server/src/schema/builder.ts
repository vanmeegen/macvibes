import SchemaBuilder from '@pothos/core';
import type { Db } from '../db/client';
import type { ServerConfig } from '../config';
import type { UserRow } from '../db/schema';
import type { SandboxManager } from '../sandbox/sandboxManager';

export interface GraphQLContext {
  db: Db;
  config: ServerConfig;
  currentUser: UserRow | null;
  request: Request;
  sandboxManager: SandboxManager;
}

export const builder = new SchemaBuilder<{ Context: GraphQLContext }>({});

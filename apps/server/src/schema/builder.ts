import SchemaBuilder from '@pothos/core';
import type { Db } from '../db/client';
import type { ServerConfig } from '../config';
import type { UserRow } from '../db/schema';
import type { SandboxManager } from '../sandbox/sandboxManager';
import type { ChatService } from '../services/chatService';

export interface GraphQLContext {
  db: Db;
  config: ServerConfig;
  currentUser: UserRow | null;
  request: Request;
  sandboxManager: SandboxManager;
  chatService: ChatService;
}

export const builder = new SchemaBuilder<{ Context: GraphQLContext }>({});

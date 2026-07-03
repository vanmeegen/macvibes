import SchemaBuilder from '@pothos/core';
import type { Db } from '../db/client';
import type { ServerConfig } from '../config';
import type { UserRow } from '../db/schema';

export interface GraphQLContext {
  db: Db;
  config: ServerConfig;
  currentUser: UserRow | null;
  request: Request;
}

export const builder = new SchemaBuilder<{ Context: GraphQLContext }>({});

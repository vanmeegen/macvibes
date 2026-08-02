import SchemaBuilder from '@pothos/core';
import type { Db } from '../db/client';
import type { ServerConfig } from '../config';
import type { UserRow } from '../db/schema';
import type { SandboxManager } from '../sandbox/sandboxManager';
import type { ChatService } from '../services/chatService';

/**
 * Session-Cookie-Fähigkeiten, die der HTTP-Layer pro Request in den Context
 * hebt (B2): die Resolver (login/logout/register, chatEvents-Revalidierung)
 * brauchen Cookies, dürfen aber nichts über HTTP wissen — wie ein Cookie
 * geschrieben, gelöscht oder gelesen wird, entscheidet allein
 * `http/createAppYoga` (dort ist `http/cookies` zuhause).
 */
export interface SessionCookies {
  /** Setzt das Session-Cookie (Login/Erst-Registrierung). */
  write(token: string, expiresAt: Date): Promise<void>;
  /** Löscht das Session-Cookie (Logout). */
  clear(): Promise<void>;
  /** Liest das Session-Token; null = nicht (eindeutig) angemeldet, s. H2. */
  readToken(): Promise<string | null>;
}

export interface GraphQLContext {
  db: Db;
  config: ServerConfig;
  currentUser: UserRow | null;
  request: Request;
  session: SessionCookies;
  sandboxManager: SandboxManager;
  chatService: ChatService;
  /** Client-IP für das Rate-Limit auf login/register (F14); null = unbekannt. */
  clientIp: string | null;
}

export const builder = new SchemaBuilder<{ Context: GraphQLContext }>({});

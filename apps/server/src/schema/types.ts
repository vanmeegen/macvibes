import type { TemplateEntry } from '@macvibes/shared';
import type { AgentModelInfo } from '../agent/agentModel';
import type { ChatMessageRow, UserRow } from '../db/schema';
import type { ChatEventPayload } from '../services/chatService';
import type { ProjectWithOwner } from '../services/projectsService';
import { builder } from './builder';

/** GraphQL-Objekttypen — von den thematischen Schema-Dateien geteilt. */

export const UserRef = builder.objectRef<UserRow>('User');
UserRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    username: t.exposeString('username'),
    role: t.exposeString('role'),
    approved: t.exposeBoolean('approved'),
    createdAt: t.string({ resolve: (user) => user.createdAt.toISOString() }),
  }),
});

export const TemplateRef = builder.objectRef<TemplateEntry>('Template');
TemplateRef.implement({
  fields: (t) => ({
    name: t.exposeString('name'),
    description: t.exposeString('description'),
    dir: t.exposeString('dir'),
  }),
});

export const ProjectRef = builder.objectRef<ProjectWithOwner>('Project');
ProjectRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    templateDir: t.exposeString('templateDir'),
    owner: t.field({ type: UserRef, resolve: (project) => project.owner }),
    /** Gewähltes Agenten-Modell (Dropdown im Chat, pro Projekt). */
    agentModel: t.exposeString('agentModel'),
    createdAt: t.string({ resolve: (project) => project.createdAt.toISOString() }),
    lastActivityAt: t.string({ resolve: (project) => project.lastActivityAt.toISOString() }),
    sandboxStatus: t.string({
      resolve: (project, _args, ctx) => ctx.sandboxManager.status(project.id),
    }),
    /** Läuft gerade ein Agent-Turn? Fürs "arbeitet" auf der Projektkarte. */
    turnActive: t.boolean({
      resolve: (project, _args, ctx) => ctx.chatService.isTurnActive(project.id),
    }),
    previewStatus: t.string({
      resolve: (project, _args, ctx) => ctx.sandboxManager.previewStatus(project.id),
    }),
  }),
});

export const ChatMessageRef = builder.objectRef<ChatMessageRow>('ChatMessage');
ChatMessageRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    projectId: t.exposeString('projectId'),
    turnId: t.exposeString('turnId'),
    role: t.exposeString('role'),
    content: t.exposeString('content'),
    createdAt: t.string({ resolve: (message) => message.createdAt.toISOString() }),
  }),
});

export const ChatEventRef = builder.objectRef<ChatEventPayload>('ChatEvent');
ChatEventRef.implement({
  fields: (t) => ({
    message: t.field({ type: ChatMessageRef, resolve: (payload) => payload.message }),
    turnActive: t.exposeBoolean('turnActive'),
  }),
});

export const AgentModelRef = builder.objectRef<AgentModelInfo>('AgentModel');
AgentModelRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    label: t.exposeString('label'),
  }),
});

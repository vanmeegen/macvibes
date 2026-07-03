import { eq } from 'drizzle-orm';
import type { TemplateEntry } from '@macvibes/shared';
import type { Db } from '../db/client';
import { projects, type UserRow } from '../db/schema';
import { clearSessionCookie, readSessionToken, writeSessionCookie } from '../http/cookies';
import { login, logout, register } from '../services/authService';
import { DomainError } from '../services/errors';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  type ProjectWithOwner,
} from '../services/projectsService';
import { loadTemplates } from '../services/templatesService';
import { workspaceDirFor } from '../services/workspaceService';
import { builder, type GraphQLContext } from './builder';

const UserRef = builder.objectRef<UserRow>('User');
UserRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    username: t.exposeString('username'),
  }),
});

const TemplateRef = builder.objectRef<TemplateEntry>('Template');
TemplateRef.implement({
  fields: (t) => ({
    name: t.exposeString('name'),
    description: t.exposeString('description'),
    dir: t.exposeString('dir'),
    devCommand: t.exposeString('devCommand'),
    previewPort: t.exposeInt('previewPort'),
  }),
});

const ProjectRef = builder.objectRef<ProjectWithOwner>('Project');
ProjectRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    branchName: t.exposeString('branchName'),
    templateDir: t.exposeString('templateDir'),
    owner: t.field({ type: UserRef, resolve: (project) => project.owner }),
    createdAt: t.string({ resolve: (project) => project.createdAt.toISOString() }),
    lastActivityAt: t.string({ resolve: (project) => project.lastActivityAt.toISOString() }),
    sandboxStatus: t.string({
      resolve: (project, _args, ctx) => ctx.sandboxManager.status(project.id),
    }),
    previewUrl: t.string({
      nullable: true,
      resolve: (project, _args, ctx) => ctx.sandboxManager.previewUrl(project.id),
    }),
  }),
});

function requireUser(ctx: GraphQLContext): UserRow {
  if (!ctx.currentUser) {
    throw new DomainError('Nicht angemeldet');
  }
  return ctx.currentUser;
}

/** Lädt ein Projekt und stellt serverseitig die Ownership sicher (R10). */
async function getProjectOwned(
  ctx: GraphQLContext,
  user: UserRow,
  id: string,
): Promise<ProjectWithOwner> {
  const project = await getProject(ctx.db, id);
  if (!project) {
    throw new DomainError('Projekt nicht gefunden');
  }
  if (project.ownerId !== user.id) {
    throw new DomainError('Nur der Eigentümer kann mit diesem Projekt arbeiten');
  }
  return project;
}

async function touchProject(db: Db, id: string): Promise<void> {
  await db.update(projects).set({ lastActivityAt: new Date() }).where(eq(projects.id, id));
}

builder.queryType({
  fields: (t) => ({
    me: t.field({
      type: UserRef,
      nullable: true,
      resolve: (_root, _args, ctx) => ctx.currentUser,
    }),
    templates: t.field({
      type: [TemplateRef],
      resolve: (_root, _args, ctx) => loadTemplates(ctx.config.templatesDir),
    }),
    projects: t.field({
      type: [ProjectRef],
      resolve: (_root, _args, ctx) => {
        requireUser(ctx);
        return listProjects(ctx.db);
      },
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    register: t.field({
      type: UserRef,
      args: {
        username: t.arg.string({ required: true }),
        password: t.arg.string({ required: true }),
        inviteCode: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const result = await register(ctx.db, ctx.config, args);
        await writeSessionCookie(ctx.request, result.token, result.expiresAt);
        return result.user;
      },
    }),
    login: t.field({
      type: UserRef,
      args: {
        username: t.arg.string({ required: true }),
        password: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const result = await login(ctx.db, ctx.config, args.username, args.password);
        await writeSessionCookie(ctx.request, result.token, result.expiresAt);
        return result.user;
      },
    }),
    logout: t.boolean({
      resolve: async (_root, _args, ctx) => {
        const token = await readSessionToken(ctx.request);
        if (token) {
          await logout(ctx.db, token);
        }
        await clearSessionCookie(ctx.request);
        return true;
      },
    }),
    createProject: t.field({
      type: ProjectRef,
      args: {
        name: t.arg.string({ required: true }),
        templateDir: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) =>
        createProject(ctx.db, ctx.config, requireUser(ctx), {
          name: args.name,
          templateDir: args.templateDir,
        }),
    }),
    deleteProject: t.boolean({
      args: {
        id: t.arg.id({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        await deleteProject(ctx.db, requireUser(ctx), String(args.id));
        return true;
      },
    }),
    enterProject: t.field({
      type: ProjectRef,
      args: {
        id: t.arg.id({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const user = requireUser(ctx);
        const project = await getProjectOwned(ctx, user, String(args.id));
        await ctx.sandboxManager.enter({
          projectId: project.id,
          branchName: project.branchName,
          workspaceDir: workspaceDirFor(ctx.config.macvibesHome, project.id),
          devCommand: project.devCommand,
          previewPort: project.previewPort,
        });
        await touchProject(ctx.db, project.id);
        return project;
      },
    }),
    leaveProject: t.boolean({
      args: {
        id: t.arg.id({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const user = requireUser(ctx);
        await getProjectOwned(ctx, user, String(args.id));
        ctx.sandboxManager.leave(String(args.id));
        return true;
      },
    }),
  }),
});

export const schema = builder.toSchema();

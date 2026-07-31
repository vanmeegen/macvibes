import { eq } from 'drizzle-orm';
import type { TemplateEntry } from '@macvibes/shared';
import type { Db } from '../db/client';
import { projects, type ChatMessageRow, type UserRow } from '../db/schema';
import type { ChatEventPayload } from '../services/chatService';
import { clearSessionCookie, readSessionToken, writeSessionCookie } from '../http/cookies';
import {
  approveUser,
  listUsers,
  login,
  logout,
  register,
  rejectUser,
  resolveSession,
} from '../services/authService';
import { revalidateStream } from './revalidateStream';
import { DomainError } from '../services/errors';
import { createRateLimiter, rateLimitDisabled, type RateLimiter } from '../services/rateLimiter';
import { AGENT_MODELS, type AgentModelInfo } from '../agent/agentModel';
import {
  copyProject,
  createProject,
  assertCanDeleteProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
  setProjectAgentModel,
  type ProjectWithOwner,
} from '../services/projectsService';
import { loadTemplates } from '../services/templatesService';
import { viewerKey } from '../sandbox/sandboxManager';
import { workspaceDirFor } from '../services/workspaceService';
import { builder, type GraphQLContext } from './builder';

const UserRef = builder.objectRef<UserRow>('User');
UserRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    username: t.exposeString('username'),
    role: t.exposeString('role'),
    approved: t.exposeBoolean('approved'),
    createdAt: t.string({ resolve: (user) => user.createdAt.toISOString() }),
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
    previewHostPort: t.int({
      nullable: true,
      resolve: (project, _args, ctx) => ctx.sandboxManager.previewHostPort(project.id),
    }),
    previewStatus: t.string({
      resolve: (project, _args, ctx) => ctx.sandboxManager.previewStatus(project.id),
    }),
  }),
});

const ChatMessageRef = builder.objectRef<ChatMessageRow>('ChatMessage');
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

const ChatEventRef = builder.objectRef<ChatEventPayload>('ChatEvent');
ChatEventRef.implement({
  fields: (t) => ({
    message: t.field({ type: ChatMessageRef, resolve: (payload) => payload.message }),
    turnActive: t.exposeBoolean('turnActive'),
  }),
});

/**
 * Rate-Limit für die unauthentifizierte Fläche (F14): jeder Versuch kostet ein
 * argon2id-verify bzw. -hash. Zwei Schlüssel — pro IP gegen Dauerfeuer, pro
 * Username gegen verteiltes Raten auf ein einzelnes Konto.
 */
/**
 * Takt für die Session-Nachprüfung laufender Subscriptions (H6). 15 s ist der
 * Kompromiss: schnell genug, dass ein Logout spürbar greift, selten genug, dass
 * die Chat-Deltas keine DB-Abfrage pro Event auslösen.
 */
const SUBSCRIPTION_REVALIDATE_MS = 15_000;

const loginLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 20 });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 10 });

function assertWithinLimit(limiter: RateLimiter, keys: string[]): void {
  if (rateLimitDisabled()) return;
  for (const key of keys) {
    if (!limiter.check(key)) {
      throw new DomainError('Zu viele Versuche — bitte einige Minuten warten.');
    }
  }
}

function requireUser(ctx: GraphQLContext): UserRow {
  if (!ctx.currentUser) {
    throw new DomainError('Nicht angemeldet');
  }
  return ctx.currentUser;
}

function requireAdmin(ctx: GraphQLContext): UserRow {
  const user = requireUser(ctx);
  if (user.role !== 'admin') {
    throw new DomainError('Nur ein Admin darf das');
  }
  return user;
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

/** Lädt ein Projekt ohne Ownership-Prüfung (R10, lesender Zugriff). */
async function getProjectAny(ctx: GraphQLContext, id: string): Promise<ProjectWithOwner> {
  const project = await getProject(ctx.db, id);
  if (!project) {
    throw new DomainError('Projekt nicht gefunden');
  }
  return project;
}

async function touchProject(db: Db, id: string): Promise<void> {
  await db.update(projects).set({ lastActivityAt: new Date() }).where(eq(projects.id, id));
}

const AgentModelRef = builder.objectRef<AgentModelInfo>('AgentModel');
AgentModelRef.implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    label: t.exposeString('label'),
    /** Lokales (langsames) Modell — UI kann z. B. einen Hinweis anzeigen. */
    slow: t.exposeBoolean('slow'),
  }),
});

builder.queryType({
  fields: (t) => ({
    me: t.field({
      type: UserRef,
      nullable: true,
      resolve: (_root, _args, ctx) => ctx.currentUser,
    }),
    /** Wählbare Agenten-Modelle (Dropdown im Chat). */
    agentModels: t.field({
      type: [AgentModelRef],
      resolve: (_root, _args, ctx) => {
        requireUser(ctx);
        return [...AGENT_MODELS];
      },
    }),
    templates: t.field({
      type: [TemplateRef],
      resolve: (_root, _args, ctx) => loadTemplates(ctx.config.templatesDir),
    }),
    // Fester Port des Preview-Gateways — das Frontend baut daraus die iframe-URL
    // (`http://<host>:<port>/p/<projectId>/`) statt den dynamischen VM-Port zu
    // nutzen (Remote-/VPN-Erreichbarkeit).
    previewGatewayPort: t.int({
      resolve: (_root, _args, ctx) => ctx.config.sandbox.previewGatewayPort,
    }),
    /** HTTPS-Port des Preview-Gateways (Caddy-Terminierung) — null ohne TLS. */
    previewGatewayHttpsPort: t.int({
      nullable: true,
      resolve: (_root, _args, ctx) => ctx.config.sandbox.previewGatewayHttpsPort,
    }),
    users: t.field({
      type: [UserRef],
      resolve: (_root, _args, ctx) => {
        requireAdmin(ctx);
        return listUsers(ctx.db);
      },
    }),
    projects: t.field({
      type: [ProjectRef],
      resolve: (_root, _args, ctx) => {
        requireUser(ctx);
        return listProjects(ctx.db);
      },
    }),
    chatMessages: t.field({
      type: [ChatMessageRef],
      args: {
        projectId: t.arg.id({ required: true }),
      },
      resolve: (_root, args, ctx) => {
        // Lesen dürfen alle angemeldeten User (R10, Live-Mitlesen).
        requireUser(ctx);
        return ctx.chatService.listMessages(String(args.projectId));
      },
    }),
    turnActive: t.boolean({
      args: {
        projectId: t.arg.id({ required: true }),
      },
      resolve: (_root, args, ctx) => {
        requireUser(ctx);
        return ctx.chatService.isTurnActive(String(args.projectId));
      },
    }),
  }),
});

builder.subscriptionType({
  fields: (t) => ({
    chatEvents: t.field({
      type: ChatEventRef,
      args: {
        projectId: t.arg.id({ required: true }),
      },
      subscribe: (_root, args, ctx) => {
        const user = requireUser(ctx);
        // Eine Subscription ist EIN langlebiger Request: `requireUser` liefe
        // sonst nur beim Aufbau, und der Stream lebte nach Logout, Ablauf oder
        // Admin-rejectUser weiter (H6). Deshalb getaktete Nachprüfung.
        return revalidateStream(
          ctx.chatService.subscribe(String(args.projectId)),
          async () => {
            const token = await readSessionToken(ctx.request);
            if (token === null) return false;
            const aktuell = await resolveSession(ctx.db, ctx.config, token);
            return aktuell !== null && aktuell.id === user.id;
          },
          SUBSCRIPTION_REVALIDATE_MS,
        );
      },
      resolve: (payload: ChatEventPayload) => payload,
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
      },
      resolve: async (_root, args, ctx) => {
        assertWithinLimit(registerLimiter, [`ip:${ctx.clientIp ?? 'unbekannt'}`]);
        const result = await register(ctx.db, ctx.config, args);
        // Nur der erste (Admin-)Nutzer ist sofort freigeschaltet und bekommt eine
        // Session. Alle anderen sind pending und müssen zuerst zugelassen werden.
        if (result.session) {
          await writeSessionCookie(ctx.request, result.session.token, result.session.expiresAt);
        }
        return result.user;
      },
    }),
    approveUser: t.field({
      type: UserRef,
      args: {
        userId: t.arg.id({ required: true }),
      },
      resolve: (_root, args, ctx) => {
        requireAdmin(ctx);
        return approveUser(ctx.db, String(args.userId));
      },
    }),
    rejectUser: t.boolean({
      args: {
        userId: t.arg.id({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        requireAdmin(ctx);
        await rejectUser(ctx.db, String(args.userId));
        return true;
      },
    }),
    login: t.field({
      type: UserRef,
      args: {
        username: t.arg.string({ required: true }),
        password: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        // VOR dem argon2-Verify prüfen — das ist der teure Teil (F14).
        assertWithinLimit(loginLimiter, [
          `ip:${ctx.clientIp ?? 'unbekannt'}`,
          `user:${args.username.toLowerCase()}`,
        ]);
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
        const user = requireUser(ctx);
        // ERST autorisieren, DANN erst Seiteneffekte (F10): der Stopp löst
        // einen Auto-Commit im fremden Branch aus und wäre sonst auch für
        // Nicht-Eigentümer auslösbar.
        await assertCanDeleteProject(ctx.db, user, String(args.id));
        // Sandbox stoppen, bevor die Volumes entfernt werden (R2).
        await ctx.sandboxManager.stop(String(args.id));
        await deleteProject(ctx.db, user, String(args.id), ctx.config.macvibesHome);
        // Zustand freigeben: ohne das behalten SandboxManager und ChatService
        // Kontext, Timer, Queue und Subscriber eines Projekts, das es nicht
        // mehr gibt, für die Lebensdauer des Prozesses.
        ctx.sandboxManager.forget(String(args.id));
        ctx.chatService.forget(String(args.id));
        return true;
      },
    }),
    /**
     * „Kopieren und Anpassen": forkt ein beliebiges Projekt (auch fremde) auf
     * den eigenen Namen — der neue Branch setzt auf dem Entwicklungsstand des
     * Originals auf. Bewusst KEINE Ownership-Prüfung: jeder darf kopieren.
     */
    copyProject: t.field({
      type: ProjectRef,
      args: {
        sourceId: t.arg.id({ required: true }),
        name: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) =>
        copyProject(ctx.db, ctx.config, requireUser(ctx), {
          sourceProjectId: String(args.sourceId),
          name: args.name,
        }),
    }),
    /** Benennt ein Projekt um — nur der Anzeigename, der Git-Branch bleibt. */
    renameProject: t.field({
      type: ProjectRef,
      args: {
        id: t.arg.id({ required: true }),
        name: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) =>
        renameProject(ctx.db, requireUser(ctx), String(args.id), args.name),
    }),
    enterProject: t.field({
      type: ProjectRef,
      args: {
        id: t.arg.id({ required: true }),
        /**
         * Kennung der aufrufenden Verbindung (ein Wert pro Tab). Ohne sie
         * zaehlt der Refcount nur den Nutzer — dann haelt ein zweiter Tab die
         * Sandbox nicht offen (H11). Optional, damit aeltere Clients weiter
         * funktionieren.
         */
        viewerId: t.arg.string({ required: false }),
      },
      resolve: async (_root, args, ctx) => {
        // Auch Nur-Lese-Besucher starten die Sandbox — sonst gäbe es für
        // fremde Projekte keine Live-Preview (R10). Chatten bleibt Owner-only.
        const user = requireUser(ctx);
        const project = await getProjectAny(ctx, String(args.id));
        const workspaceDir = workspaceDirFor(ctx.config.macvibesHome, project.id);
        await ctx.sandboxManager.enter(
          {
            projectId: project.id,
            branchName: project.branchName,
            workspaceDir,
            templateDir: project.templateDir,
            devCommand: project.devCommand,
            previewPort: project.previewPort,
          },
          viewerKey(user.id, args.viewerId ?? null),
        );
        if (project.ownerId === user.id) {
          // Config-Warmup anstoßen (fire-and-forget), während der User tippt —
          // der erste echte Turn trägt dann nicht mehr den claude-First-Run.
          // Nur für den Owner: Besucher dürfen weder den Agent-Daemon belegen
          // noch die letzte Aktivität des Projekts verfälschen.
          // Kein nacktes `void` (F18): ohne Rejection-Handler beendet ein
          // Fehler hier den ganzen Serverprozess. prewarm fängt inzwischen
          // selbst ab — der Handler bleibt als zweite Sicherung.
          ctx.chatService.prewarm(project.id, workspaceDir).catch((error: unknown) => {
            console.error(`Config-Warmup für ${project.id} fehlgeschlagen:`, error);
          });
          await touchProject(ctx.db, project.id);
        }
        return project;
      },
    }),
    leaveProject: t.boolean({
      args: {
        id: t.arg.id({ required: true }),
        /** Dieselbe Kennung wie beim enterProject dieses Tabs (H11). */
        viewerId: t.arg.string({ required: false }),
      },
      resolve: async (_root, args, ctx) => {
        // Ownership bleibt bewusst außen vor (R10: Besucher dürfen fremde
        // Sandboxes starten und müssen sie deshalb auch freigeben können). Die
        // Absicherung sitzt im SandboxManager: `leave` zählt nur den eigenen
        // Betrachter ab, Grace greift erst beim letzten (H11). Sonst könnte ein
        // Fremder die VM des Eigentümers stoppen und dabei einen Auto-Commit in
        // dessen Branch auslösen — dieselbe Regel wie bei deleteProject.
        const user = requireUser(ctx);
        await getProjectAny(ctx, String(args.id));
        ctx.sandboxManager.leave(String(args.id), viewerKey(user.id, args.viewerId ?? null));
        return true;
      },
    }),
    /**
     * Modellwahl pro Chat/Projekt (Dropdown). Ein laufender Turn bleibt
     * unberührt; der NÄCHSTE Turn nutzt das neue Modell — die Claude-Session
     * startet dabei automatisch frisch (Reconciliation im chatService).
     */
    setProjectModel: t.field({
      type: ProjectRef,
      args: {
        projectId: t.arg.id({ required: true }),
        model: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const user = requireUser(ctx);
        const project = await getProjectOwned(ctx, user, String(args.projectId));
        await setProjectAgentModel(ctx.db, project.id, args.model);
        return { ...project, agentModel: args.model };
      },
    }),
    sendMessage: t.boolean({
      args: {
        projectId: t.arg.id({ required: true }),
        text: t.arg.string({ required: true }),
        interrupt: t.arg.boolean({ required: false }),
      },
      resolve: async (_root, args, ctx) => {
        const user = requireUser(ctx);
        const project = await getProjectOwned(ctx, user, String(args.projectId));
        const text = args.text.trim();
        if (text.length === 0) {
          throw new DomainError('Nachricht darf nicht leer sein');
        }
        const workspaceDir = workspaceDirFor(ctx.config.macvibesHome, project.id);
        // Chatten setzt eine laufende Sandbox voraus (R6).
        await ctx.sandboxManager.enter(
          {
            projectId: project.id,
            branchName: project.branchName,
            workspaceDir,
            templateDir: project.templateDir,
            devCommand: project.devCommand,
            previewPort: project.previewPort,
          },
          user.id,
        );
        await ctx.chatService.sendMessage({
          projectId: project.id,
          workspaceDir,
          resumeSessionId: project.claudeSessionId,
          text,
          interrupt: args.interrupt === true,
        });
        await touchProject(ctx.db, project.id);
        return true;
      },
    }),
    stopTurn: t.boolean({
      args: {
        projectId: t.arg.id({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        const user = requireUser(ctx);
        await getProjectOwned(ctx, user, String(args.projectId));
        ctx.chatService.stopTurn(String(args.projectId));
        return true;
      },
    }),
  }),
});

export const schema = builder.toSchema();

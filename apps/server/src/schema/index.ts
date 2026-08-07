import type { TemplateEntry } from '@macvibes/shared';
import type { ChatMessageRow, UserRow } from '../db/schema';
import type { ChatEventPayload } from '../services/chatService';
import {
  approveUser,
  listUsers,
  login,
  logout,
  register,
  rejectUser,
  resolveSession,
} from '../services/authService';
import { releaseOnClose } from './releaseOnClose';
import { revalidateStream } from './revalidateStream';
import { DomainError } from '../core/errors';
import { createRateLimiter, type RateLimiter } from '../services/rateLimiter';
import { AGENT_MODELS, type AgentModelInfo } from '../agent/agentModel';
import {
  copyProject,
  createProject,
  getProject,
  listProjects,
  renameProject,
  setProjectAgentModel,
  type ProjectWithOwner,
} from '../services/projectsService';
import { loadTemplates } from '../services/templatesService';
import {
  deleteProjectAndCleanup,
  enterProjectSession,
  sandboxContextFor,
  sendMessageToProject,
} from '../services/projectSessionService';
import { viewerKey } from '../sandbox/sandboxManager';
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

function assertWithinLimit(ctx: GraphQLContext, limiter: RateLimiter, keys: string[]): void {
  // MACVIBES_RATE_LIMIT_DISABLED=1 (nur E2E) — seit M6 über die Config.
  if (ctx.config.rateLimitDisabled) return;
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

/** Lädt ein Projekt ohne Ownership-Prüfung (R10, lesender Zugriff). */
async function getProjectAny(ctx: GraphQLContext, id: string): Promise<ProjectWithOwner> {
  const project = await getProject(ctx.db, id);
  if (!project) {
    throw new DomainError('Projekt nicht gefunden');
  }
  return project;
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
      subscribe: async (_root, args, ctx) => {
        const user = requireUser(ctx);
        // Betrachter = aktive Subscription (H11): Die Subscription ist der
        // einzige Kanal, der GENAU so lange lebt wie der Tab. Endet sie — Tab
        // zu, Reload, Crash, Netzabriss —, beendet Yoga den Iterator, und
        // `releaseOnClose` meldet den Betrachter ZUVERLÄSSIG ab. Die früheren
        // enter/leave-Mutationen hatten dieses Signal nicht: ohne leave blieb
        // der Schlüssel für immer im Refcount, die VM stoppte nie.
        const project = await getProjectAny(ctx, String(args.projectId));
        // Schlüssel SERVERSEITIG erzeugen: pro Subscription eindeutig (keine
        // Kollisionen, #12) und von außen nicht erratbar — niemand kann einen
        // fremden Betrachter austragen.
        const viewer = viewerKey(user.id, crypto.randomUUID());
        // Auch die Subscription selbst startet die Sandbox (nicht nur der
        // Eager-Start via enterProject): reconnectet der Client nach einem
        // Netzabriss, lebt die Preview weiter. Schlägt der Start fehl
        // (Kapazität, msb), scheitert die Subscription sichtbar — EventSource
        // versucht es von selbst erneut.
        await ctx.sandboxManager.enter(sandboxContextFor(project, ctx.config.macvibesHome), viewer);
        // Brach der Client WÄHREND des (bei kaltem Boot sekundenlangen) enter()
        // ab, existiert noch kein Iterator, auf dem Yoga `.return()` rufen
        // könnte — `releaseOnClose` griffe nie, der Betrachter bliebe für
        // immer gezählt. Deshalb hier prüfen und sofort wieder austragen.
        // Bewusst ein Fehler statt eines leeren Iterators: so entsteht gar
        // kein Stream (kein chatService-Subscriber, nichts zu disposen), und
        // ob Yoga einen erst nach dem Abort fertiggestellten Iterator noch
        // schließt, muss uns nicht kümmern. Beim Client kommt der Fehler
        // ohnehin nicht mehr an — die Verbindung ist weg.
        if (ctx.request.signal.aborted) {
          ctx.sandboxManager.leave(project.id, viewer);
          throw new DomainError('Verbindung während des Sandbox-Starts abgebrochen');
        }
        // Restfenster (Abort zwischen der Prüfung oben und der Übergabe des
        // Iterators an Yoga) defensiv schließen: der Abort-Listener trägt den
        // Betrachter aus. Eine Doppel-Freigabe mit releaseOnClose ist
        // ausgeschlossen, denn `leave` ist mengenbasiert und pro Schlüssel
        // idempotent (Set.delete) — der jeweils zweite Aufruf ist ein No-op.
        // Der Listener feuert auch beim regulären Verbindungsende nach einem
        // sauberen Subscription-Abschluss noch einmal; auch das ist aus
        // demselben Grund folgenlos.
        ctx.request.signal.addEventListener(
          'abort',
          () => ctx.sandboxManager.leave(project.id, viewer),
          { once: true },
        );
        // Eine Subscription ist EIN langlebiger Request: `requireUser` liefe
        // sonst nur beim Aufbau, und der Stream lebte nach Logout, Ablauf oder
        // Admin-rejectUser weiter (H6). Deshalb getaktete Nachprüfung.
        const stream = revalidateStream(
          ctx.chatService.subscribe(project.id),
          async () => {
            const token = await ctx.session.readToken();
            if (token === null) return false;
            const aktuell = await resolveSession(ctx.db, ctx.config, token);
            return aktuell !== null && aktuell.id === user.id;
          },
          SUBSCRIPTION_REVALIDATE_MS,
        );
        return releaseOnClose(stream, () => ctx.sandboxManager.leave(project.id, viewer));
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
        assertWithinLimit(ctx, registerLimiter, [`ip:${ctx.clientIp ?? 'unbekannt'}`]);
        const result = await register(ctx.db, ctx.config, args);
        // Nur der erste (Admin-)Nutzer ist sofort freigeschaltet und bekommt eine
        // Session. Alle anderen sind pending und müssen zuerst zugelassen werden.
        if (result.session) {
          await ctx.session.write(result.session.token, result.session.expiresAt);
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
        assertWithinLimit(ctx, loginLimiter, [
          `ip:${ctx.clientIp ?? 'unbekannt'}`,
          `user:${args.username.toLowerCase()}`,
        ]);
        const result = await login(ctx.db, ctx.config, args.username, args.password);
        await ctx.session.write(result.token, result.expiresAt);
        return result.user;
      },
    }),
    logout: t.boolean({
      resolve: async (_root, _args, ctx) => {
        const token = await ctx.session.readToken();
        if (token) {
          await logout(ctx.db, token);
        }
        await ctx.session.clear();
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
        await deleteProjectAndCleanup(
          {
            db: ctx.db,
            sandbox: ctx.sandboxManager,
            chat: ctx.chatService,
            macvibesHome: ctx.config.macvibesHome,
          },
          user,
          String(args.id),
        );
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
    /**
     * Eager-Start der Sandbox beim Öffnen der Chat-Page — damit die Preview
     * schon lädt, bevor die chatEvents-Subscription steht. Zählt bewusst
     * KEINEN Betrachter (H11): der Refcount hängt an der Lebensdauer der
     * Subscription, deren Ende der Server auch bei Reload/Crash/Netzabriss
     * sieht. Ein leaveProject gibt es deshalb nicht mehr — folgt dem
     * Eager-Start keine Subscription, stoppt Grace die Sandbox von selbst.
     */
    enterProject: t.field({
      type: ProjectRef,
      args: {
        id: t.arg.id({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        // Auch Nur-Lese-Besucher starten die Sandbox — sonst gäbe es für
        // fremde Projekte keine Live-Preview (R10). Chatten bleibt Owner-only.
        const user = requireUser(ctx);
        const project = await getProjectAny(ctx, String(args.id));
        await enterProjectSession(
          {
            db: ctx.db,
            sandbox: ctx.sandboxManager,
            chat: ctx.chatService,
            macvibesHome: ctx.config.macvibesHome,
          },
          user,
          project,
        );
        return project;
      },
    }),
    /**
     * Modellwahl pro Chat/Projekt (Dropdown). Ein laufender Turn bleibt
     * unberührt; der NÄCHSTE Turn nutzt das neue Modell — die Claude-Session
     * startet dabei automatisch frisch (Reconciliation im chatService).
     * Ownership prüft der Service selbst (M5, Owner-only ohne Admin-Ausnahme).
     */
    setProjectModel: t.field({
      type: ProjectRef,
      args: {
        projectId: t.arg.id({ required: true }),
        model: t.arg.string({ required: true }),
      },
      resolve: (_root, args, ctx) =>
        setProjectAgentModel(ctx.db, requireUser(ctx), String(args.projectId), args.model),
    }),
    sendMessage: t.boolean({
      args: {
        projectId: t.arg.id({ required: true }),
        text: t.arg.string({ required: true }),
        interrupt: t.arg.boolean({ required: false }),
      },
      resolve: async (_root, args, ctx) => {
        const user = requireUser(ctx);
        await sendMessageToProject(
          {
            db: ctx.db,
            sandbox: ctx.sandboxManager,
            chat: ctx.chatService,
            macvibesHome: ctx.config.macvibesHome,
          },
          user,
          {
            projectId: String(args.projectId),
            text: args.text,
            interrupt: args.interrupt === true,
          },
        );
        return true;
      },
    }),
    stopTurn: t.boolean({
      args: {
        projectId: t.arg.id({ required: true }),
      },
      // Ownership prüft der Service selbst (M5) — hier gibt es vor dem Aufruf
      // keine Seiteneffekte, also braucht es keine Vorab-Prüfung.
      resolve: async (_root, args, ctx) => {
        await ctx.chatService.stopTurn(requireUser(ctx), String(args.projectId));
        return true;
      },
    }),
  }),
});

export const schema = builder.toSchema();

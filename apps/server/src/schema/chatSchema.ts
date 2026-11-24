import { DomainError } from '../core/errors';
import { viewerKey } from '../sandbox/sandboxManager';
import { resolveSession } from '../services/authService';
import type { ChatEventPayload } from '../services/chatService';
import { sandboxContextFor, sendMessageToProject } from '../services/projectSessionService';
import { requireProject } from '../services/projectsService';
import { builder } from './builder';
import { requireUser, sessionDeps } from './guards';
import { releaseOnClose } from './releaseOnClose';
import { revalidateStream } from './revalidateStream';
import { ChatEventRef, ChatMessageRef } from './types';

/** Chat: Verlauf, Live-Events (Subscription = Betrachter), Senden und Stoppen. */

/**
 * Takt für die Session-Nachprüfung laufender Subscriptions (H6). 15 s ist der
 * Kompromiss: schnell genug, dass ein Logout spürbar greift, selten genug, dass
 * die Chat-Deltas keine DB-Abfrage pro Event auslösen.
 */
const SUBSCRIPTION_REVALIDATE_MS = 15_000;

builder.queryFields((t) => ({
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
}));

builder.subscriptionFields((t) => ({
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
      const project = await requireProject(ctx.db, String(args.projectId));
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
}));

builder.mutationFields((t) => ({
  sendMessage: t.boolean({
    args: {
      projectId: t.arg.id({ required: true }),
      text: t.arg.string({ required: true }),
      interrupt: t.arg.boolean({ required: false }),
    },
    resolve: async (_root, args, ctx) => {
      const user = requireUser(ctx);
      await sendMessageToProject(sessionDeps(ctx), user, {
        projectId: String(args.projectId),
        text: args.text,
        interrupt: args.interrupt === true,
      });
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
}));

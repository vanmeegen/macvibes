import { allAgentModels } from '../agent/agentModel';
import { deleteProjectAndCleanup, enterProjectSession } from '../services/projectSessionService';
import {
  copyProject,
  createProject,
  listProjects,
  renameProject,
  requireProject,
  setProjectAgentModel,
} from '../services/projectsService';
import { loadTemplates } from '../services/templatesService';
import { builder } from './builder';
import { requireUser, sessionDeps } from './guards';
import { AgentModelRef, ProjectRef, TemplateRef } from './types';

/** Projekte: Katalog (Templates, Modelle), Anlegen/Kopieren/Umbenennen/Löschen, Öffnen. */

builder.queryFields((t) => ({
  projects: t.field({
    type: [ProjectRef],
    resolve: (_root, _args, ctx) => {
      requireUser(ctx);
      return listProjects(ctx.db);
    },
  }),
  templates: t.field({
    type: [TemplateRef],
    resolve: (_root, _args, ctx) => loadTemplates(ctx.config.templatesDir),
  }),
  /** Wählbare Agenten-Modelle (Dropdown im Chat). */
  agentModels: t.field({
    type: [AgentModelRef],
    resolve: (_root, _args, ctx) => {
      requireUser(ctx);
      // Voller Katalog: eingebaute + Nutzer-Modelle (<macvibesHome>/models.json).
      return [...allAgentModels()];
    },
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
}));

builder.mutationFields((t) => ({
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
      await deleteProjectAndCleanup(sessionDeps(ctx), user, String(args.id));
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
      const project = await requireProject(ctx.db, String(args.id));
      await enterProjectSession(sessionDeps(ctx), user, project);
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
}));

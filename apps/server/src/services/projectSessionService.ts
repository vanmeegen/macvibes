import type { Db } from '../db/client';
import type { ProjectRow, UserRow } from '../db/schema';
import { DomainError } from '../core/errors';
import { workspaceDirFor } from '../core/workspaceService';
import {
  assertCanDeleteProject,
  deleteProject,
  getProjectOwned,
  touchProject,
} from './projectsService';
import type { ChatService } from './chatService';

/**
 * Projektübergreifende Sandbox-Lebenszyklus-Orchestrierung (koppelt
 * SandboxManager + ChatService + projectsService + db). Zog aus dem
 * GraphQL-Transport (schema/index.ts) hierher, damit die komplexeste
 * Orchestrierung des Systems in einer Service-Schicht liegt, nicht im
 * Transport.
 *
 * ── Architektur-Gate (services → sandbox ist TOT) ─────────────────────────
 * Die Kante services → sandbox wurde in eslint.config.js bewusst gestrichen.
 * Dieser Service hält sie tot: Statt den konkreten SandboxManager (aus
 * sandbox/) zu importieren, beschreibt er über `SandboxLifecycle` nur, WAS er
 * vom Manager braucht (Dependency Inversion). Auch der Sandbox-Startkontext
 * ist hier als `SandboxRunContext` NEU definiert statt aus sandbox/provider.ts
 * importiert — ein type-only Import über die Grenze bräche das Gate genauso.
 *
 * Der konkrete SandboxManager erfüllt `SandboxLifecycle` strukturell und wird
 * vom Transport (den Resolvern) injiziert. Driftet der echte SandboxContext
 * gegenüber `SandboxRunContext`, bricht das der Resolver beim Kompilieren an
 * der AUFRUFSTELLE `enter(sandboxContextFor(...))`: dort trifft der hier
 * erzeugte SandboxRunContext direkt auf den echten SandboxContext-Parameter
 * (Argument-Prüfung, kein Cast). Die bloße Zuweisung des Managers an
 * `SandboxLifecycle` allein trüge wegen TS-Parameter-Bivarianz nicht.
 */

/** Spiegelt SandboxContext (sandbox/provider.ts) strukturell — s. Kopfkommentar. */
export interface SandboxRunContext {
  projectId: string;
  branchName: string;
  workspaceDir: string;
  templateDir: string;
  devCommand: string;
  previewPort: number;
}

/**
 * Baut den Sandbox-Startkontext eines Projekts — die zuvor an DREI Stellen
 * (chatEvents-Subscription, enterProject, sendMessage) wortgleich duplizierte
 * Sechs-Felder-Konstruktion. `workspaceDir` leitet sich aus `macvibesHome` +
 * Projekt-ID ab (core/workspaceService), die übrigen fünf Felder stammen
 * unverändert aus der Projektzeile.
 */
export function sandboxContextFor(project: ProjectRow, macvibesHome: string): SandboxRunContext {
  return {
    projectId: project.id,
    branchName: project.branchName,
    workspaceDir: workspaceDirFor(macvibesHome, project.id),
    templateDir: project.templateDir,
    devCommand: project.devCommand,
    previewPort: project.previewPort,
  };
}

/**
 * Was der Service vom SandboxManager braucht (Dependency Inversion, s.
 * Kopfkommentar) — der konkrete Manager erfüllt es strukturell.
 */
export interface SandboxLifecycle {
  ensureRunning(context: SandboxRunContext): Promise<void>;
  stop(projectId: string): Promise<void>;
  forget(projectId: string): void;
}

/**
 * Was der Service vom ChatService braucht. Als `Pick` aus dem echten Typ
 * (gleiche Schicht, Import erlaubt) — keine duplizierten Signaturen, und der
 * konkrete ChatService erfüllt es unmittelbar.
 */
export type ChatSessionPort = Pick<
  ChatService,
  'resumeUnansweredTurn' | 'prewarm' | 'sendMessage' | 'forget'
>;

/** Injizierte Abhängigkeiten der Sandbox-Lebenszyklus-Use-Cases. */
export interface ProjectSessionDeps {
  db: Db;
  sandbox: SandboxLifecycle;
  chat: ChatSessionPort;
  macvibesHome: string;
}

/**
 * Löscht ein Projekt und räumt den flüchtigen Zustand (Sandbox + Chat) hinter
 * ihm auf — die vollständige Aufräumkette, die zuvor im deleteProject-Resolver
 * lag. Der Resolver behält nur requireUser + arg-mapping + den Aufruf.
 */
export async function deleteProjectAndCleanup(
  deps: ProjectSessionDeps,
  user: UserRow,
  projectId: string,
): Promise<void> {
  const { db, sandbox, chat, macvibesHome } = deps;
  // ERST autorisieren, DANN erst Seiteneffekte (F10): der Stopp löst
  // einen Auto-Commit im fremden Branch aus und wäre sonst auch für
  // Nicht-Eigentümer auslösbar.
  await assertCanDeleteProject(db, user, projectId);
  // Sandbox stoppen, bevor die Volumes entfernt werden (R2).
  await sandbox.stop(projectId);
  await deleteProject(db, user, projectId, macvibesHome);
  // Zustand freigeben: ohne das behalten SandboxManager und ChatService
  // Kontext, Timer, Queue und Subscriber eines Projekts, das es nicht
  // mehr gibt, für die Lebensdauer des Prozesses. Kein try/finally:
  // deleteProject wirft nur, solange noch NICHTS gelöscht ist (ab dem
  // DB-Delete ist die Volume-Entfernung best effort und wirft nicht
  // mehr) — wirft es, ist forget() hier in beiden möglichen Fällen
  // falsch bzw. überflüssig: Entweder existiert das Projekt weiter
  // (forget() verwürfe lebende Betrachter-Refcounts und Chat-Zustand),
  // oder eine PARALLELE deleteProject-Mutation war schneller
  // („Projekt nicht gefunden" aus assertCanDeleteProject) — dann hat
  // deren Resolver das forget() bereits erledigt, nichts leckt.
  sandbox.forget(projectId);
  chat.forget(projectId);
}

/**
 * Eager-Start-Kette beim Öffnen eines Projekts: Sandbox hochfahren (immer,
 * auch für Nur-Lese-Besucher), dann — nur für den Owner — einen unbeantworteten
 * Turn wiederaufnehmen ODER die Config vorwärmen und die Aktivität bumpen. Der
 * Resolver behält nur requireUser + getProjectAny + den Aufruf (und gibt das
 * Projekt zurück).
 *
 * Reihenfolge ist load-bearing; resume und prewarm schließen sich aus.
 */
export async function enterProjectSession(
  deps: ProjectSessionDeps,
  user: UserRow,
  project: ProjectRow,
): Promise<void> {
  const { db, sandbox, chat, macvibesHome } = deps;
  const context = sandboxContextFor(project, macvibesHome);
  const { workspaceDir } = context;
  await sandbox.ensureRunning(context);
  // Ownership prüfen resumeUnansweredTurn/prewarm inzwischen SELBST
  // (M5, Feature-Gating: bei fremdem Projekt stille Rückkehr statt
  // Wurf). Der Branch hier bleibt trotzdem — nicht als Authz (das wäre
  // wieder Transport-Disziplin), sondern weil er ETWAS ANDERES gated:
  // touchProject darf nur der Owner auslösen, sonst bumpte jeder
  // Nur-Lese-Besuch die Aktivitätssortierung des Projekts. Nebenbei
  // erspart er Besuchern zwei sinnlose DB-Reads pro enterProject.
  if (project.ownerId === user.id) {
    // Re-Entry-Resume (#34): Starb ein Turn beim Host-Neustart/Release,
    // bevor eine Antwort persistiert wurde, ist die letzte Chat-Zeile eine
    // unbeantwortete User-Nachricht. Beim Wieder-Öffnen genau diesen
    // Prompt automatisch erneut ausführen — für den User dasselbe
    // Ergebnis, ohne erneutes Tippen. Nur für den Owner: Besucher dürfen
    // weder den Agent-Daemon belegen noch Turns anstoßen.
    const resumed = await chat.resumeUnansweredTurn(user, project.id, workspaceDir);
    if (!resumed) {
      // Nur wenn NICHT wiederaufgenommen: stiller Config-Warmup
      // (fire-and-forget), während der User tippt — der erste echte Turn
      // trägt dann nicht mehr den claude-First-Run. Ein echter
      // wiederaufgenommener Turn wärmt die Config selbst.
      // Kein nacktes `void` (F18): ohne Rejection-Handler beendet ein
      // Fehler hier den ganzen Serverprozess. prewarm fängt inzwischen
      // selbst ab — der Handler bleibt als zweite Sicherung.
      chat.prewarm(user, project.id, workspaceDir).catch((error: unknown) => {
        console.error(`Config-Warmup für ${project.id} fehlgeschlagen:`, error);
      });
    }
    await touchProject(db, project.id);
  }
}

/**
 * Chat-Nachricht senden: Ownership prüfen (F10), Text validieren, Sandbox
 * hochfahren (R6), an den ChatService übergeben und die Aktivität bumpen. Der
 * Resolver behält nur requireUser + arg-mapping + den Aufruf.
 *
 * Reihenfolge ist load-bearing.
 */
export async function sendMessageToProject(
  deps: ProjectSessionDeps,
  user: UserRow,
  input: { projectId: string; text: string; interrupt: boolean },
): Promise<void> {
  const { db, sandbox, chat, macvibesHome } = deps;
  // ERST autorisieren, DANN Seiteneffekte (F10-Muster wie bei
  // deleteProject): ohne diese Vorab-Prüfung startete ein Nicht-Owner
  // über ensureRunning die Sandbox. Der ChatService prüft die Ownership
  // zusätzlich SELBST (M5) — hier ist es die zweite Sicherung plus die
  // Reihenfolge-Garantie.
  const project = await getProjectOwned(db, user, input.projectId);
  const text = input.text.trim();
  if (text.length === 0) {
    throw new DomainError('Nachricht darf nicht leer sein');
  }
  const context = sandboxContextFor(project, macvibesHome);
  const { workspaceDir } = context;
  // Chatten setzt eine laufende Sandbox voraus (R6). Kein Betrachter-
  // Eintrag (H11): der Owner zählt über seine chatEvents-Subscription;
  // ein Turn ohne Subscription bleibt über isBusy vor Grace geschützt.
  await sandbox.ensureRunning(context);
  await chat.sendMessage(user, {
    projectId: project.id,
    workspaceDir,
    text,
    interrupt: input.interrupt,
  });
  // N4: Zwischen dem ensureRunning oben und dem queue.push im ChatService
  // liegt ein await (Ownership-Read, M5) — in diesem Mikro-Fenster ist isBusy
  // noch false, ein Grace-/Idle-/Eviction-Stopp also möglich. Jetzt, wo der
  // Turn eingereiht ist (isBusy true, inkl. Warmup seit N9), die Sandbox
  // idempotent erneut zusichern: war sie im Fenster gestoppt worden, bootet
  // sie hier neu und der wartende DaemonRunner trifft den frischen Daemon.
  // (Vorbild: der „KEIN await mehr"-Kommentar in resumeUnansweredTurn.)
  await sandbox.ensureRunning(context);
  await touchProject(db, project.id);
}

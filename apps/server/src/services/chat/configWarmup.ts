import { isSlowAgentModel } from '../../agent/agentModel';
import type { AgentRunner } from '../../agent/runner';
import type { UserRow } from '../../db/schema';
import type { ChatMessageStore } from './chatMessageStore';

export interface ConfigWarmupOptions {
  /** Warmup überhaupt ausführen (s. ChatServiceOptions.prewarmEnabled). */
  enabled: boolean;
  /** Frist für den stillen Warmup — er blockiert sonst den echten Turn. */
  timeoutMs: number;
}

/**
 * Stiller Config-Warmup frisch geforkter VMs (s. `prewarm`). Hält die
 * laufenden Warmups pro Projekt, damit der echte Turn auf sie warten kann.
 */
export class ConfigWarmup {
  /** Laufende Config-Warmups pro Projekt. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ChatMessageStore,
    private readonly runner: AgentRunner,
    private readonly options: ConfigWarmupOptions,
  ) {}

  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  /** Der laufende Warmup des Projekts — der echte Turn wartet darauf. */
  pending(projectId: string): Promise<void> | undefined {
    return this.running.get(projectId);
  }

  forget(projectId: string): void {
    this.running.delete(projectId);
  }

  /**
   * Wärmt die claude-Config einer frisch geforkten VM vor: ein stiller
   * Wegwerf-Turn (Output verworfen, keine Chat-Nachricht), der beim Öffnen des
   * Projekts läuft, während der User seinen ersten Prompt tippt. Ohne dies
   * trägt der ERSTE echte Turn den ganzen claude-First-Run (~9s auf dem
   * gemounteten Volume) — mit Warmup ist er danach schnell. No-Op, wenn schon
   * ein Warmup läuft oder das Projekt bereits eine Session hat (Config warm).
   *
   * **Wirft nie.** Der Aufrufer (GraphQL-Resolver) startet den Warmup
   * fire-and-forget; eine Rejection hätte dort keinen Handler und beendete den
   * ganzen Serverprozess — eine SQLITE_BUSY beim Öffnen EINES Projekts risse
   * damit alle anderen Sitzungen und alle laufenden MicroVMs mit. Der Warmup
   * ist reine Beschleunigung: scheitert er, geht es ohne ihn weiter.
   *
   * Der Eintrag in `running` wird nach dem Lauf wieder entfernt. Er verhindert
   * nur einen ZWEITEN gleichzeitigen Warmup — bliebe er liegen, wäre `prewarm`
   * für dieses Projekt dauerhaft wirkungslos, auch nach erneutem Öffnen mit
   * einer frischen VM, deren Config wieder kalt ist.
   *
   * Owner-only, und die Prüfung hängt HIER am Service (M5) — aber als
   * FEATURE-GATING, nicht als Authz-Ablehnung: ein Besucher bekommt schlicht
   * keinen Warmup (stille Rückkehr). Ein Wurf wäre falsch — er machte
   * enterProject für Nur-Lese-Besucher (R10) kaputt, und es gibt nichts
   * abzulehnen: der Warmup ist ein Beschleuniger, kein Nutzerbefehl.
   */
  async prewarm(user: UserRow, projectId: string, workspaceDir: string): Promise<void> {
    if (!this.options.enabled) return;
    if (this.running.has(projectId)) return;
    let projectRow;
    try {
      projectRow = await this.store.projectRow(projectId);
    } catch (error) {
      console.error(`Config-Warmup für ${projectId} nicht gestartet (DB-Fehler):`, error);
      return;
    }
    // Feature-Gating (M5, s. Methodenkommentar): fremdes oder unbekanntes
    // Projekt → STILL zurück, kein Wurf. Vorwärmen dürfte sonst jeder
    // Transport, der den Resolver-Branch vergisst, für fremde Projekte —
    // und belegte damit deren Ein-Turn-Daemon.
    if (projectRow === undefined || projectRow.ownerId !== user.id) return;
    if (projectRow.claudeSessionId != null) return;
    const model = projectRow.agentModel;
    // Langsame lokale Modelle NICHT vorwärmen: der minutenlange Warmup belegt
    // den Ein-Turn-Daemon und der erste echte Prompt würde abgewiesen.
    if (isSlowAgentModel(model)) return;
    const run = this.run(projectId, workspaceDir, model).finally(() => {
      this.running.delete(projectId);
    });
    this.running.set(projectId, run);
  }

  private async run(projectId: string, workspaceDir: string, model: string): Promise<void> {
    try {
      const handle = this.runner.startTurn({
        projectId,
        prompt: 'Antworte nur mit dem Wort: bereit',
        workspaceDir,
        resumeSessionId: null,
        model,
      });
      // Der Warmup MUSS eine Frist haben: der echte Turn wartet auf ihn
      // (ChatService.runAttempt), bevor er in seine eigene Timeout-Schleife
      // kommt. Ohne Frist hängt ein stiller Warmup — etwa weil die Claude-API
      // nicht antwortet — das Projekt unbegrenzt auf, und im UI steht ewig
      // „Agent arbeitet", ohne dass je ein Fehler sichtbar wird.
      const deadline = Date.now() + this.options.timeoutMs;
      const consume = (async () => {
        // Events konsumieren und VERWERFEN — der Warmup initialisiert nur die
        // claude-Config in der VM, er erzeugt keine Chat-Nachrichten.
        for await (const event of handle.events) {
          void event;
        }
      })();
      const expired = await Promise.race([
        consume.then(() => false),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => true),
      ]);
      if (expired) {
        console.warn(
          `Config-Warmup für ${projectId} nach ${Math.round(this.options.timeoutMs / 1000)}s ` +
            'abgebrochen — der Agent antwortet nicht. Der nächste echte Turn läuft trotzdem.',
        );
        handle.abort();
      }
    } catch (error) {
      console.error(`Config-Warmup für ${projectId} fehlgeschlagen:`, error);
    }
  }
}

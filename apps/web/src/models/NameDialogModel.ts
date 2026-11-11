import { makeAutoObservable, runInAction } from 'mobx';
import { toErrorMessage } from '../api/errors';

/**
 * Präsentationsmodell eines „Namen eingeben"-Dialogs zu einem Projekt
 * (Kopieren, Umbenennen): vorgemerktes Projekt, Eingabewert und Fehler. Bei
 * einem Server-Fehler (z. B. doppelter Name) bleibt der Dialog offen, damit
 * der Name korrigiert werden kann.
 */
export class NameDialogModel {
  /** Projekt-ID, für die der Dialog gerade offen ist. */
  projectId: string | null = null;
  name = '';
  error: string | null = null;

  /** `logLabel` benennt die Aktion im Fehler-Log (z. B. „ProjectsStore.confirmCopy"). */
  constructor(private readonly logLabel: string) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get canConfirm(): boolean {
    return this.name.trim().length > 0;
  }

  open(projectId: string, prefill: string): void {
    this.projectId = projectId;
    this.name = prefill;
    this.error = null;
  }

  cancel(): void {
    this.projectId = null;
    this.error = null;
  }

  setName(name: string): void {
    this.name = name;
    this.error = null;
  }

  /**
   * Führt `action` mit Projekt-ID und getrimmtem Namen aus und schließt den
   * Dialog bei Erfolg. Liefert das Ergebnis der Aktion, sonst `null`
   * (nichts vorgemerkt, leerer Name oder Fehler — der steht dann in `error`).
   */
  async confirm<T>(action: (projectId: string, name: string) => Promise<T>): Promise<T | null> {
    const projectId = this.projectId;
    const name = this.name.trim();
    if (projectId === null || name.length === 0) {
      return null;
    }
    try {
      const result = await action(projectId, name);
      runInAction(() => {
        this.projectId = null;
        this.error = null;
      });
      return result;
    } catch (err) {
      console.error(`${this.logLabel} fehlgeschlagen`, err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
      return null;
    }
  }
}

/** Fehlertext für die Anzeige: Error-Message, sonst die String-Darstellung. */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

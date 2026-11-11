/**
 * Führt einen Aufräum-Schritt mit Frist aus (Shutdown-Sequenz und
 * Hot-Reload-Abräumen). Weder Fehler noch Hänger dürfen die übrigen Schritte
 * verhindern: beides wird gemeldet, das Promise löst trotzdem auf.
 *
 * `label` ist der Meldungs-Präfix samt Schritt-Bezeichnung, z. B.
 * `Abschaltschritt` oder `Hot-Reload: Abräum-Schritt`.
 */
export function runStepWithTimeout(
  label: string,
  name: string,
  run: () => Promise<void> | void,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log(`${label} „${name}" hängt (>${timeoutMs}ms) — übersprungen.`);
      resolve();
    }, timeoutMs);
    // async-Wrapper fängt auch synchrone Würfe; der Reject-Zweig fängt einen
    // späten Fehler nach dem Timeout ab, sodass keine unhandled rejection
    // entsteht.
    void (async () => run())().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        log(`${label} „${name}" schlug fehl: ${String(error)}`);
        resolve();
      },
    );
  });
}

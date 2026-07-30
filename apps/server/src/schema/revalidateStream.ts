/**
 * Prüft die Berechtigung während eines langlebigen Streams nach (H6).
 *
 * Eine GraphQL-Subscription ist ein einzelner, langlebiger Request: der
 * Yoga-Context — und damit `currentUser` — entsteht genau einmal, also lief die
 * `requireUser`-Prüfung nur beim Aufbau des Iterators. Danach empfing ein
 * Nutzer weiter Live-Agent-Output, obwohl seine Session längst weg war
 * (Logout, Ablauf, Admin-`rejectUser`) — genau das, was `resolveSession`
 * verhindern soll ("Ein zurückgezogenes Approval muss bestehende Sessions
 * kappen").
 *
 * Geprüft wird getaktet, nicht pro Event: Chat-Streams liefern viele kleine
 * Deltas, eine DB-Abfrage pro Delta wäre unverhältnismäßig.
 */
export async function* revalidateStream<T>(
  source: AsyncIterable<T>,
  isStillValid: () => Promise<boolean>,
  intervalMs: number,
  now: () => number = () => Date.now(),
): AsyncGenerator<T> {
  // Vor dem ersten Wert prüfen: eine bereits ungültige Session darf nicht
  // einmal das erste Event sehen.
  if (!(await isStillValid())) return;
  let zuletztGeprueft = now();

  // for await schließt die Quelle bei return/throw selbst (Generator-Protokoll),
  // auch wenn der Konsument den Stream vorzeitig verlässt.
  for await (const value of source) {
    const jetzt = now();
    if (jetzt - zuletztGeprueft >= intervalMs) {
      zuletztGeprueft = jetzt;
      if (!(await isStillValid())) return;
    }
    yield value;
  }
}

/**
 * Reicht einen Stream unveraendert durch und ruft `release` GARANTIERT genau
 * einmal auf, sobald er endet — egal wie: Quelle erschoepft, Fehler, oder der
 * Konsument bricht ab (`.return()`/`.throw()`). Yoga ruft bei Tab-Schliessen,
 * Reload, Crash und Netzabriss `.return()` auf dem Subscription-Iterator —
 * damit ist das hier das verlaessliche "Betrachter ist gegangen"-Signal (H11).
 *
 * ZWEI Fallstricke, deretwegen das ein handgebauter Iterator ist und die
 * Freigabe NICHT auf die Quelle wartet:
 *
 * 1. Nie gestarteter Generator: ein async-Generator mit try/finally, der noch
 *    nie mit `next()` angestossen wurde, fuehrt bei `.return()` sein finally
 *    NICHT aus — die Freigabe bliebe genau dann aus, wenn die Verbindung vor
 *    dem ersten Event abreisst.
 *
 * 2. Im await suspendierter Generator: haengt die Quelle (der async-Generator
 *    aus `revalidateStream`) in einem `await source.next()` — der Normalfall,
 *    Yoga hat immer ein next() in Flight —, dann wird ein `.return()` per Spec
 *    hinter den laufenden Request eingereiht und erst beim naechsten Erreichen
 *    eines yield verarbeitet, also erst beim NAECHSTEN Chat-Event. Bei einem
 *    ruhigen Projekt heisst das: nie. Ein `await inner.return()` VOR der
 *    Freigabe liesse den Betrachter deshalb fuer immer gezaehlt (Grace
 *    startet nie, die VM lebt bis zum Idle-Stopp). Darum feuert `release`
 *    hier SOFORT und synchron; das Schliessen der Quelle (chatService-
 *    Subscriber austragen) wird nur noch angestossen, nicht abgewartet.
 */
export function releaseOnClose<T>(
  source: AsyncIterable<T>,
  release: () => void,
): AsyncIterableIterator<T> {
  const inner = source[Symbol.asyncIterator]();
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release();
  };
  /**
   * Quelle schliessen, ohne darauf zu warten (Fallstrick 2). Der Aufruf darf
   * nicht verloren gehen (der innere Cleanup muss weiterhin passieren), aber
   * ein Fehler dabei darf weder die Freigabe blockieren noch als Unhandled
   * Rejection den Prozess treffen — also loggen, nicht verschlucken.
   */
  const closeInner = (value?: unknown): void => {
    try {
      const abschluss = inner.return?.(value);
      if (abschluss !== undefined) {
        void Promise.resolve(abschluss).catch((error: unknown) => {
          console.error('releaseOnClose: Schliessen der Quelle schlug fehl:', error);
        });
      }
    } catch (error) {
      console.error('releaseOnClose: Schliessen der Quelle schlug fehl:', error);
    }
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<T>> {
      try {
        const result = await inner.next();
        if (result.done === true) releaseOnce();
        return result;
      } catch (error) {
        releaseOnce();
        throw error;
      }
    },
    async return(value?: unknown): Promise<IteratorResult<T>> {
      // Freigabe ZUERST und synchron — bevor die (womoeglich fuer immer
      // haengende) Quelle auch nur angefasst wird.
      releaseOnce();
      closeInner(value);
      return { value: undefined, done: true };
    },
    async throw(error?: unknown): Promise<IteratorResult<T>> {
      // Auch im Fehlerpfad: Freigabe zuerst, dann erst an die Quelle
      // delegieren — haengt deren throw(), haengt zwar diese Promise, aber
      // die Freigabe ist bereits raus.
      releaseOnce();
      if (inner.throw) return inner.throw(error);
      throw error;
    },
  };
}

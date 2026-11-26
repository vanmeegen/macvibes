import { makeAutoObservable, runInAction } from 'mobx';
import { toErrorMessage } from '../api/errors';
import { gqlRequest } from '../api/graphqlClient';
import type { ChatMessage } from '../api/types';

interface ChatEventPayload {
  message: ChatMessage;
  turnActive: boolean;
}

/** Felder einer Chat-Nachricht — Verlaufs-Query und Subscription fragen dieselben ab. */
const MESSAGE_FIELDS = 'id projectId turnId role content createdAt';

const CHAT_STATE_QUERY = /* GraphQL */ `
  query ChatState($projectId: ID!) {
    chatMessages(projectId: $projectId) {
      ${MESSAGE_FIELDS}
    }
    turnActive(projectId: $projectId)
  }
`;

const SEND_MESSAGE_MUTATION = /* GraphQL */ `
  mutation SendMessage($projectId: ID!, $text: String!, $interrupt: Boolean) {
    sendMessage(projectId: $projectId, text: $text, interrupt: $interrupt)
  }
`;

const STOP_TURN_MUTATION = /* GraphQL */ `
  mutation StopTurn($projectId: ID!) {
    stopTurn(projectId: $projectId)
  }
`;

const TURN_ACTIVE_QUERY = /* GraphQL */ `
  query TurnActive($projectId: ID!) {
    turnActive(projectId: $projectId)
  }
`;

const CHAT_EVENTS_SUBSCRIPTION = /* GraphQL */ `
  subscription ChatEvents($projectId: ID!) {
    chatEvents(projectId: $projectId) {
      turnActive
      message {
        ${MESSAGE_FIELDS}
      }
    }
  }
`;

/** Präfix der optimistischen (noch nicht serverbestätigten) User-Bubbles. */
const OPTIMISTIC_PREFIX = 'optimistic-';
/** `EventSource.CLOSED` — als Zahl, weil Test-Umgebungen die Konstante nicht immer haben. */
const EVENTSOURCE_CLOSED = 2;

/** Liest das Steering-Flag aus der Vite-Env (Default: aus). */
function readSteerOnSendEnv(): boolean {
  return import.meta.env.VITE_MACVIBES_STEER_ON_SEND === 'true';
}

/** SSE-URL der chatEvents-Subscription (GraphQL über GET, Projekt als Variable). */
function chatEventsUrl(projectId: string): string {
  const params = new URLSearchParams({
    query: CHAT_EVENTS_SUBSCRIPTION,
    variables: JSON.stringify({ projectId }),
  });
  return `/graphql?${params.toString()}`;
}

/**
 * Chat eines Projekts: Verlauf, Streaming-Events (SSE via
 * GraphQL-Subscription), Eingabe-Entwurf, Turn-Status und Stop (R6).
 */
export class ChatStore {
  messages: ChatMessage[] = [];
  turnActive = false;
  error: string | null = null;
  draft = '';
  projectId: string | null = null;
  /** Zähler für eindeutige optimistische IDs. */
  optimisticCounter = 0;
  /** SSE-Verbindung — bewusst nicht observable. */
  eventSource: EventSource | null = null;
  /** Reconcile-Timer gegen verpasste Turn-Ende-Events — nicht observable. */
  reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Verbindungs-Generation — nicht observable. Jeder connect()/disconnect()
   * zählt hoch; ein laufender connect() prüft nach jedem await, ob er noch der
   * aktuelle ist. Ohne das überschreibt die verspätete History-Antwort eines
   * alten Projekts das neue und leakt SSE-Verbindungen (Projektwechsel,
   * StrictMode-Doppelmount) — ab ~6 offenen SSE-Streams blockiert der Browser
   * dann ALLE weiteren Requests an den Origin.
   */
  connectEpoch = 0;

  /**
   * Zählt jedes angewandte Live-Ereignis — nicht observable. Antworten auf
   * Abfragen (Verlauf, Turn-Status) sind Momentaufnahmen; kam seit ihrem Start
   * ein Ereignis, ist dieses neuer und gewinnt.
   */
  eventSeq = 0;
  /** Bei welchem `eventSeq` eine Zeile zuletzt per Ereignis geschrieben wurde. */
  readonly eventSeqVon = new Map<string, number>();
  /** Neuverbinden nach endgültig geschlossener Verbindung — nicht observable. */
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  reconnectVersuche = 0;
  /** Erneuter Versuch nach gescheiterter Verlaufsabfrage — nicht observable. */
  verlaufTimer: ReturnType<typeof setTimeout> | null = null;
  verlaufVersuche = 0;
  /** Entwürfe pro Projekt — ein in A getippter Text gehört nicht in B. */
  readonly entwuerfe = new Map<string, string>();

  /**
   * Laufender sendMessage-Roundtrip — bewusst nicht observable. Der Server
   * behandelt einen Stop ins Leere (nichts aktiv/eingereiht) als bewusstes
   * No-op („Stop heißt Stop": stopTurn wirkt nur auf den JETZT aktiven Turn);
   * das Race „stopTurn überholt sendMessage" ist damit erklärte
   * CLIENT-Verantwortung. stop() wartet deshalb einen laufenden Send ab,
   * bevor es die StopTurn-Mutation abschickt (E2E-belegt: SendMessage
   * 09:39:39.621, StopTurn .654 → stopTurn überholte serverseitig den
   * queue.push, Turn lief ungebremst durch).
   */
  sendInFlight: Promise<void> | null = null;

  /**
   * steerOnSend: unterbricht eine Nachricht während eines laufenden Turns den
   * Turn (altes Mid-Turn-Steering)? Default: aus — bei langsamen lokalen
   * Modellen killt ein schnelles „weiter" sonst den Turn, bevor er ein Tool
   * aufruft. Per VITE_MACVIBES_STEER_ON_SEND=true reaktivierbar.
   */
  constructor(private readonly steerOnSend: boolean = readSteerOnSendEnv()) {
    makeAutoObservable(
      this,
      {
        eventSource: false,
        reconcileTimer: false,
        connectEpoch: false,
        sendInFlight: false,
        eventSeq: false,
        eventSeqVon: false,
        reconnectTimer: false,
        reconnectVersuche: false,
        verlaufTimer: false,
        verlaufVersuche: false,
        entwuerfe: false,
      },
      { autoBind: true },
    );
  }

  setDraft(value: string): void {
    this.draft = value;
  }

  /** Senden nur mit nicht-leerem Entwurf. */
  get canSend(): boolean {
    return this.draft.trim().length > 0;
  }

  /**
   * „Agent arbeitet"-Bubble: solange ein Turn läuft und der Agent noch nichts
   * Sichtbares streamt (danach zeigt die wachsende Nachricht selbst den Fortschritt).
   */
  get showWorkingIndicator(): boolean {
    if (!this.turnActive) return false;
    const lastRole = this.messages[this.messages.length - 1]?.role;
    return lastRole !== 'assistant' && lastRole !== 'thinking';
  }

  /** Läuft ein Senden oder steht noch eine eigene, unbestätigte Zeile da? */
  private get sendetGerade(): boolean {
    return (
      this.sendInFlight !== null || this.messages.some((m) => m.id.startsWith(OPTIMISTIC_PREFIX))
    );
  }

  /**
   * Gleicht den Turn-Status mit dem Server ab — in BEIDE Richtungen.
   *
   * - Ein verpasstes Turn-Ende (SSE-Lücke) ließe die Anzeige sonst auf „Agent
   *   arbeitet" hängen; dann fehlen meist auch Zeilen, also wird der Verlauf
   *   nachgeladen.
   * - Ein Turn, den der Server ohne Ereignis begonnen hat (Wiederaufnahme nach
   *   einem Neustart), bliebe sonst unsichtbar: kein Indikator, kein Stopp.
   *
   * NICHT, solange ein eigenes Senden unterwegs ist: der Server reiht die
   * Nachricht erst ein, wenn die Sandbox läuft, und meldet bis dahin „kein
   * Turn" — der Abgleich löschte sonst die Anzeige mitten im VM-Start. Und
   * nicht, wenn die Antwort veraltet ist (Projektwechsel, neueres Ereignis).
   */
  async reconcileTurnActive(): Promise<void> {
    const projectId = this.projectId;
    const epoch = this.connectEpoch;
    if (projectId === null || this.sendetGerade) return;
    const seq = this.eventSeq;
    let data: { turnActive: boolean };
    try {
      data = await gqlRequest<{ turnActive: boolean }>(TURN_ACTIVE_QUERY, { projectId });
    } catch (err) {
      console.error('ChatStore.reconcileTurnActive fehlgeschlagen', err);
      return;
    }
    let nachladen = false;
    runInAction(() => {
      if (epoch !== this.connectEpoch || projectId !== this.projectId) return;
      if (this.sendetGerade || seq !== this.eventSeq) return;
      if (typeof data?.turnActive !== 'boolean' || data.turnActive === this.turnActive) return;
      nachladen = this.turnActive && this.eventSource !== null;
      this.turnActive = data.turnActive;
    });
    if (nachladen) await this.ladeVerlauf(epoch, projectId);
  }

  /**
   * Lädt den Verlauf und führt ihn mit dem lokalen Stand zusammen. Liefert
   * `false`, wenn die Abfrage scheiterte.
   *
   * Zusammenführen statt ersetzen: die Antwort ist eine Momentaufnahme vom
   * Beginn der Abfrage. Zeilen, die seither per Ereignis geschrieben wurden,
   * sind neuer und bleiben; eigene unbestätigte Zeilen bleiben ebenfalls.
   */
  private async ladeVerlauf(epoch: number, projectId: string): Promise<boolean> {
    const seq = this.eventSeq;
    let data: { chatMessages: ChatMessage[]; turnActive: boolean };
    try {
      data = await gqlRequest<{ chatMessages: ChatMessage[]; turnActive: boolean }>(
        CHAT_STATE_QUERY,
        { projectId },
      );
    } catch (err) {
      if (epoch === this.connectEpoch) console.error('ChatStore: Verlauf nicht ladbar', err);
      return false;
    }
    if (epoch !== this.connectEpoch || projectId !== this.projectId) return true;
    if (!Array.isArray(data?.chatMessages)) return false;
    runInAction(() => {
      const lokal = new Map(this.messages.map((m) => [m.id, m]));
      const serverIds = new Set(data.chatMessages.map((m) => m.id));
      const neuVomServer = data.chatMessages.filter((m) => !lokal.has(m.id));
      const zusammen: ChatMessage[] = data.chatMessages.map((vomServer) => {
        const hier = lokal.get(vomServer.id);
        if (hier === undefined) return vomServer;
        // Seit Abfragebeginn per Ereignis geschrieben → lokal ist neuer.
        if ((this.eventSeqVon.get(vomServer.id) ?? 0) > seq) return hier;
        Object.assign(hier, vomServer);
        return hier;
      });
      for (const hier of this.messages) {
        if (serverIds.has(hier.id)) continue;
        if (hier.id.startsWith(OPTIMISTIC_PREFIX)) {
          // Die eigene Zeile bleibt, bis ihre serverseitige Fassung da ist.
          const bestaetigt = neuVomServer.some(
            (m) => m.role === 'user' && m.content === hier.content,
          );
          if (!bestaetigt) zusammen.push(hier);
        } else if ((this.eventSeqVon.get(hier.id) ?? 0) > seq) {
          zusammen.push(hier);
        }
      }
      this.messages = zusammen;
      // Der Turn-Status der Momentaufnahme gilt nur, wenn nichts Neueres vorliegt.
      if (seq === this.eventSeq && !this.sendetGerade) this.turnActive = data.turnActive;
    });
    return true;
  }

  /** Upsert per Message-ID — Streaming-Deltas ersetzen die bestehende Zeile. */
  applyEvent(payload: ChatEventPayload): void {
    // Projekt-Trennung: Events fremder Projekte (z. B. aus einer noch nicht
    // abgeräumten alten Subscription) dürfen hier nie landen.
    if (payload.message.projectId !== this.projectId) return;
    // Ist es die serverseitige Fassung unserer optimistischen User-Bubble,
    // die eigene Bubble durch das echte Event ersetzen (kein Duplikat).
    if (payload.message.role === 'user') {
      const optimistic = this.messages.findIndex(
        (m) => m.id.startsWith(OPTIMISTIC_PREFIX) && m.content === payload.message.content,
      );
      if (optimistic >= 0) {
        this.messages.splice(optimistic, 1);
      }
    }
    // Von hinten suchen: die streamende Zeile ist praktisch immer die letzte.
    // Bestehende Zeilen werden IN PLACE fortgeschrieben — so rendert nur die
    // betroffene Bubble neu, nicht die ganze Liste.
    let existing: ChatMessage | undefined;
    for (let i = this.messages.length - 1; i >= 0 && existing === undefined; i--) {
      if (this.messages[i]?.id === payload.message.id) existing = this.messages[i];
    }
    if (existing !== undefined) {
      Object.assign(existing, payload.message);
    } else {
      this.messages.push(payload.message);
    }
    this.eventSeq += 1;
    this.eventSeqVon.set(payload.message.id, this.eventSeq);
    const turnEndet = this.turnActive && !payload.turnActive;
    this.turnActive = payload.turnActive;
    // Am Turn-Ende den Verlauf nachladen: einmalige Zeilen (Tool, System,
    // Fehler), die in einer Verbindungslücke geschrieben wurden, liefert der
    // Server nicht nach — ohne das fehlten sie bis zum Reload.
    if (turnEndet && this.eventSource !== null && this.projectId !== null) {
      void this.ladeVerlauf(this.connectEpoch, this.projectId);
    }
  }

  /** Lädt die Historie und abonniert Live-Events (auch read-only, R10). */
  async connect(projectId: string): Promise<void> {
    this.disconnect();
    const epoch = ++this.connectEpoch;
    this.projectId = projectId;
    this.messages = [];
    this.error = null;
    this.turnActive = false;
    this.draft = this.entwuerfe.get(projectId) ?? '';
    this.eventSeqVon.clear();

    const geladen = await this.ladeVerlauf(epoch, projectId);
    // Veraltet? Inzwischen lief ein neuer connect()/disconnect() — dessen
    // Zustand gilt, diese Antwort gehört zu einem verlassenen Projekt.
    if (epoch !== this.connectEpoch) return;
    if (!geladen) {
      runInAction(() => {
        this.error = 'Der Chat-Verlauf konnte nicht geladen werden — neuer Versuch läuft.';
      });
      this.planeVerlaufVersuch(epoch, projectId);
    }

    // Die Verbindung steht AUCH nach einer gescheiterten Verlaufsabfrage:
    // ohne sie kämen keine Ereignisse an („Agent arbeitet" für immer), und der
    // Tab zählte nicht als Betrachter — die VM stoppte unter ihm.
    this.oeffneVerbindung(epoch, projectId);

    // Sicherheitsnetz: regelmäßig mit dem echten Server-Status abgleichen.
    this.reconcileTimer = setInterval(() => void this.reconcileTurnActive(), 5000);
  }

  /** Wiederholt eine gescheiterte Verlaufsabfrage mit wachsendem Abstand. */
  private planeVerlaufVersuch(epoch: number, projectId: string): void {
    const warteMs = Math.min(15_000, 1000 * 2 ** this.verlaufVersuche);
    this.verlaufVersuche += 1;
    this.verlaufTimer = setTimeout(() => {
      this.verlaufTimer = null;
      if (epoch !== this.connectEpoch) return;
      void this.ladeVerlauf(epoch, projectId).then((geladen) => {
        if (epoch !== this.connectEpoch) return;
        if (!geladen) {
          this.planeVerlaufVersuch(epoch, projectId);
          return;
        }
        this.verlaufVersuche = 0;
        runInAction(() => {
          this.error = null;
        });
      });
    }, warteMs);
  }

  private oeffneVerbindung(epoch: number, projectId: string): void {
    const eventSource = new EventSource(chatEventsUrl(projectId));
    // GraphQL Yoga sendet benannte SSE-Events ("event: next"), nicht "message".
    eventSource.addEventListener('next', (event: MessageEvent<string>) => {
      // Nachzügler einer bereits ersetzten Verbindung ignorieren.
      if (epoch !== this.connectEpoch) return;
      try {
        const parsed = JSON.parse(event.data) as { data?: { chatEvents?: ChatEventPayload } };
        const payload = parsed.data?.chatEvents;
        if (payload) {
          this.applyEvent(payload);
        }
      } catch (err) {
        console.error('Chat-Event konnte nicht verarbeitet werden', err);
      }
    });
    // Bei JEDEM (Wieder-)Verbinden den Verlauf nachladen: der Server liefert
    // nur künftige Ereignisse. Was zwischen der ersten Abfrage und dem Abo
    // bzw. während eines Abrisses geschrieben wurde, käme sonst nie an.
    eventSource.addEventListener('open', () => {
      if (epoch !== this.connectEpoch) return;
      this.reconnectVersuche = 0;
      void this.ladeVerlauf(epoch, projectId);
    });
    eventSource.onerror = (err) => {
      if (epoch !== this.connectEpoch) return;
      // Bei einem Netzabriss verbindet sich EventSource selbst neu
      // (readyState CONNECTING). Antwortet aber z. B. ein Proxy mit 502 oder
      // falschem Content-Type, gibt der Browser endgültig auf (CLOSED) — dann
      // übernehmen wir, sonst bliebe der Tab ohne Ereignisse und ohne
      // Betrachter-Eintrag.
      if (eventSource.readyState !== EVENTSOURCE_CLOSED) {
        console.error('Chat-Subscription unterbrochen', err);
        return;
      }
      console.error('Chat-Subscription geschlossen — verbinde neu', err);
      eventSource.close();
      if (this.eventSource === eventSource) this.eventSource = null;
      const warteMs = Math.min(15_000, 1000 * 2 ** this.reconnectVersuche);
      this.reconnectVersuche += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (epoch !== this.connectEpoch) return;
        this.oeffneVerbindung(epoch, projectId);
      }, warteMs);
    };
    this.eventSource = eventSource;
  }

  disconnect(): void {
    // Entwertet auch einen noch laufenden connect() (siehe connectEpoch).
    this.connectEpoch++;
    this.eventSource?.close();
    this.eventSource = null;
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.verlaufTimer !== null) {
      clearTimeout(this.verlaufTimer);
      this.verlaufTimer = null;
    }
    this.reconnectVersuche = 0;
    this.verlaufVersuche = 0;
    // Ein noch laufendes Senden gehört zum verlassenen Projekt — es darf weder
    // den Abgleich noch einen Stopp im nächsten Projekt aufhalten.
    this.sendInFlight = null;
    // Den Entwurf beim Projekt lassen, zu dem er gehört.
    if (this.projectId !== null) {
      if (this.draft === '') this.entwuerfe.delete(this.projectId);
      else this.entwuerfe.set(this.projectId, this.draft);
    }
    this.projectId = null;
  }

  /**
   * Trennt und leert alles — für ein Projekt, das es nicht mehr gibt (gelöscht
   * bei offenem Tab). `disconnect` allein ließe „Agent arbeitet" und den
   * Stopp-Knopf stehen, obwohl Senden und Stoppen ins Leere gingen.
   */
  reset(): void {
    this.disconnect();
    this.messages = [];
    this.turnActive = false;
    this.error = null;
    this.draft = '';
  }

  async send(): Promise<void> {
    const projectId = this.projectId;
    const epoch = this.connectEpoch;
    const text = this.draft.trim();
    if (projectId === null || text.length === 0) return;
    const turnLiefSchon = this.turnActive;

    // Läuft schon ein Turn, wird die neue Nachricht standardmäßig EINGEREIHT
    // statt ihn abzubrechen (s. Konstruktor-Doku zu steerOnSend).
    const interrupt = this.steerOnSend && this.turnActive;
    this.draft = '';
    this.error = null;

    // Optimistisch: die eigene Bubble SOFORT anzeigen und den Turn als aktiv
    // markieren („Agent arbeitet…") — kein Warten auf den Server-Roundtrip.
    const optimisticId = `${OPTIMISTIC_PREFIX}${this.optimisticCounter++}`;
    this.messages.push({
      id: optimisticId,
      projectId,
      turnId: optimisticId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    });
    this.turnActive = true;

    // Roundtrip als in-flight merken, damit stop() ihn abwarten kann
    // (s. Doku an sendInFlight: Server-No-op bei „Stop ins Leere").
    const roundtrip = (async (): Promise<void> => {
      try {
        await gqlRequest<{ sendMessage: boolean }>(SEND_MESSAGE_MUTATION, {
          projectId,
          text,
          interrupt,
        });
      } catch (err) {
        console.error('ChatStore.send fehlgeschlagen', err);
        // Inzwischen ein anderes Projekt offen? Dann gehören Fehlermeldung,
        // Entwurf und Turn-Status nicht mehr hierher — der Text bleibt als
        // Entwurf beim Projekt, für das er gedacht war.
        if (epoch !== this.connectEpoch || projectId !== this.projectId) {
          if (!this.entwuerfe.has(projectId)) this.entwuerfe.set(projectId, text);
          return;
        }
        runInAction(() => {
          this.error = toErrorMessage(err);
          // Optimistische Bubble zurücknehmen und Entwurf wiederherstellen (R6)
          // — außer es wurde inzwischen etwas Neues getippt.
          this.messages = this.messages.filter((m) => m.id !== optimisticId);
          if (this.draft === '') this.draft = text;
          // Lief vorher schon ein Turn, läuft er weiter — den Status dann vom
          // Server holen statt hart auf „kein Turn" zu setzen.
          if (!this.messages.some((m) => m.id.startsWith(OPTIMISTIC_PREFIX)) && !turnLiefSchon) {
            this.turnActive = false;
          }
        });
      }
    })();
    this.sendInFlight = roundtrip;
    try {
      await roundtrip;
    } finally {
      // Nur zurücksetzen, wenn kein neuerer Send inzwischen übernommen hat —
      // stop() soll immer auf den ZULETZT gestarteten Send warten.
      if (this.sendInFlight === roundtrip) this.sendInFlight = null;
    }
  }

  async stop(): Promise<void> {
    const projectId = this.projectId;
    const epoch = this.connectEpoch;
    if (projectId === null) return;
    // Einen laufenden Send abwarten, BEVOR StopTurn rausgeht — sonst überholt
    // stopTurn den sendMessage-Resolver serverseitig, trifft ins Leere (No-op)
    // und der Turn läuft ungebremst durch (s. Doku an sendInFlight). Der
    // Roundtrip fängt seinen Fehler selbst (send meldet ihn in `error`) und
    // wirft nie — ein gescheiterter Send verhindert den Stop also nicht.
    if (this.sendInFlight) await this.sendInFlight;
    try {
      await gqlRequest<{ stopTurn: boolean }>(STOP_TURN_MUTATION, { projectId });
    } catch (err) {
      console.error('ChatStore.stop fehlgeschlagen', err);
      if (epoch !== this.connectEpoch || projectId !== this.projectId) return;
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    }
  }
}

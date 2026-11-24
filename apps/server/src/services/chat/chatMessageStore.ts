import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { chatMessages, projects, type ChatMessageRow, type ProjectRow } from '../../db/schema';

/**
 * Obergrenze pro Chat-Zeile (F16). Ohne Deckel wächst eine gestreamte Zeile
 * unbegrenzt, im Missbrauchsfall bis zur Sättigung von Speicher und Platte.
 */
export const MAX_MESSAGE_CHARS = 200_000;

/** Wie viele user/assistant-Zeilen der Kontext-Vorspann höchstens trägt. */
const HISTORY_CONTEXT_ROWS = 30;
/** Zeichen-Deckel des Kontext-Vorspanns (die jüngsten Zeichen gewinnen). */
const HISTORY_CONTEXT_CHARS = 8_000;

/**
 * Persistenz des Chats: Historie lesen, Zeilen schreiben, Agent-Session am
 * Projekt sichern. Reiner DB-Zugriff — das Verteilen an Abonnenten macht der
 * Aufrufer (ChatService), damit Schreiben und Senden getrennt bleiben.
 */
export class ChatMessageStore {
  constructor(private readonly db: Db) {}

  async list(projectId: string): Promise<ChatMessageRow[]> {
    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.projectId, projectId))
      .orderBy(sql`rowid`, asc(chatMessages.createdAt));
  }

  /** Die letzte Chat-Zeile des Projekts (gleiche Ordnung wie `list`). */
  async last(projectId: string): Promise<ChatMessageRow | undefined> {
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.projectId, projectId))
      .orderBy(desc(sql`rowid`), desc(chatMessages.createdAt))
      .limit(1);
    return rows[0];
  }

  async insert(
    projectId: string,
    turnId: string,
    role: ChatMessageRow['role'],
    content: string,
  ): Promise<ChatMessageRow> {
    // Zweiter Riegel gegen zu lange Inhalte: MAX_MESSAGE_CHARS greift auch im
    // Append-Pfad (TurnAttempt.appendDelta), aber eben nicht nur dort. Sonst
    // käme jede Nicht-Delta-Quelle — insbesondere tool-use/error aus der
    // untrusted VM — am Deckel vorbei. Die Protokoll-Schicht begrenzt die
    // Felder schon; das hier ist die Absicherung an der Senke, damit kein
    // künftiger Pfad sie umgeht.
    const capped =
      content.length > MAX_MESSAGE_CHARS ? `${content.slice(0, MAX_MESSAGE_CHARS)}…` : content;
    const inserted = await this.db
      .insert(chatMessages)
      .values({ id: crypto.randomUUID(), projectId, turnId, role, content: capped })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error('Chat-Insert lieferte keine Zeile zurück');
    }
    return row;
  }

  /** Überschreibt den Inhalt einer Zeile (gebündeltes Streaming). */
  async updateContent(messageId: string, content: string): Promise<void> {
    await this.db.update(chatMessages).set({ content }).where(eq(chatMessages.id, messageId));
  }

  async projectRow(projectId: string): Promise<ProjectRow | undefined> {
    const rows = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return rows[0];
  }

  /**
   * Sichert die Agent-Session samt Modell am Projekt (R9). Das Modell gehört
   * dazu: ein späterer Modellwechsel darf diese Session NICHT fortsetzen (ein
   * Session-Resume mit anderem Modell hängt, s. agent/agentModel.ts).
   */
  async saveSession(projectId: string, sessionId: string, model: string): Promise<void> {
    await this.db
      .update(projects)
      .set({ claudeSessionId: sessionId, claudeSessionModel: model })
      .where(eq(projects.id, projectId));
  }

  /**
   * Stellt dem Prompt den bisherigen Gesprächsverlauf voran, falls es einen gibt
   * (nur user/assistant, gekappt). Nur nötig, wenn OHNE Session-Resume gestartet
   * wird — sonst würde der Agent den Kontext der Konversation nicht kennen.
   */
  async withHistoryContext(
    projectId: string,
    currentTurnId: string,
    prompt: string,
  ): Promise<string> {
    // Nur user/assistant-Zeilen laden — und das Filtern schon in die DB legen,
    // NICHT erst danach. Sonst füllt ein tool-lastiger Turn die geholten Zeilen
    // mit `tool`/`system`/`error` und nach dem Filter bleibt fast nichts (im
    // schlimmsten Fall nichts) übrig: der Agent startete dann ohne Resume UND
    // ohne Kontext und beantwortete ein „weiter" gedächtnislos.
    const conversation = (
      await this.db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.projectId, projectId),
            ne(chatMessages.turnId, currentTurnId),
            inArray(chatMessages.role, ['user', 'assistant']),
          ),
        )
        .orderBy(desc(sql`rowid`))
        .limit(HISTORY_CONTEXT_ROWS)
    ).reverse();
    if (conversation.length === 0) return prompt;
    let history = conversation
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    if (history.length > HISTORY_CONTEXT_CHARS) {
      history = `…\n\n${history.slice(-HISTORY_CONTEXT_CHARS)}`;
    }
    return (
      'Bisheriger Gesprächsverlauf dieses Projekts (der Sitzungskontext wurde ' +
      'nach einem Abbruch neu aufgebaut; der aktuelle Stand des Codes liegt in ' +
      `den Dateien im Workspace):\n\n${history}\n\n---\n\nAktuelle Aufgabe:\n${prompt}`
    );
  }
}

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { projects } from '../../db/schema';
import { DEFAULT_AGENT_MODEL } from '../../agent/agentModel';
import { DomainError } from '../../core/errors';
import { setProjectAgentModel } from '../projectsService';
import { createTestDb, createUser } from '../../testing/testUtils';

async function setup() {
  const db = createTestDb();
  // Erster User wird Admin (Bootstrap) — als Owner hier trotzdem geeignet.
  const admin = await createUser(db, 'marco');
  const owner = await createUser(db, 'olivia');
  await db.insert(projects).values({
    id: 'p1',
    name: 'Testprojekt',
    branchName: 'olivia/testprojekt',
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
    ownerId: owner.id,
    // Wie der Service beim Anlegen: das Modell steht ausdrücklich in der Zeile
    // (der Spalten-Default ist Altbestand, s. db/schema/projects.ts).
    agentModel: DEFAULT_AGENT_MODEL,
  });
  return { db, admin, owner };
}

describe('setProjectAgentModel (Modellwahl pro Chat)', () => {
  test('setzt ein bekanntes Modell, persistiert es und liefert das Projekt zurück', async () => {
    const { db, owner } = await setup();
    const project = await setProjectAgentModel(db, owner, 'p1', 'Qwen3.8-27B-oQ4e-mtp');
    expect(project.agentModel).toBe('Qwen3.8-27B-oQ4e-mtp');
    expect(project.owner.id).toBe(owner.id);
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('Qwen3.8-27B-oQ4e-mtp');
  });

  test('weist unbekannte Modelle mit DomainError ab', async () => {
    const { db, owner } = await setup();
    await expect(setProjectAgentModel(db, owner, 'p1', 'gpt-5')).rejects.toThrow(DomainError);
    // Der alte Wert bleibt unangetastet.
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5-5');
  });

  // M5: Die Ownership-Regel hängt am SERVICE, nicht am Resolver — sie greift
  // also auch, wenn setProjectAgentModel direkt aufgerufen wird (Skript,
  // künftiger Transport, Test), ohne den GraphQL-Weg zu nehmen.
  test('weist einen fremden Nutzer ab — auch bei direktem Service-Aufruf (M5)', async () => {
    const { db } = await setup();
    const fremd = await createUser(db, 'eve');
    await expect(setProjectAgentModel(db, fremd, 'p1', 'Qwen3.8-27B-oQ4e-mtp')).rejects.toThrow(
      /Eigentümer/,
    );
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5-5');
  });

  test('auch ein Admin darf das Modell eines fremden Projekts NICHT setzen (R10: Owner-only)', async () => {
    // Bewusst strenger als delete/rename (dort Owner ODER Admin): die
    // Chat-Fläche — und dazu gehört die Modellwahl — bleibt Owner-only.
    const { db, admin } = await setup();
    await expect(setProjectAgentModel(db, admin, 'p1', 'Qwen3.8-27B-oQ4e-mtp')).rejects.toThrow(
      /Eigentümer/,
    );
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5-5');
  });

  test('unbekanntes Projekt wird mit DomainError abgewiesen', async () => {
    const { db, owner } = await setup();
    await expect(
      setProjectAgentModel(db, owner, 'gibt-es-nicht', 'Qwen3.8-27B-oQ4e-mtp'),
    ).rejects.toThrow(/nicht gefunden/);
  });
});

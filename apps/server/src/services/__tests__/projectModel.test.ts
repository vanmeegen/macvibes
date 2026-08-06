import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { projects } from '../../db/schema';
import { DomainError } from '../../core/errors';
import { setProjectAgentModel } from '../projectsService';
import { createTestDb, createUser } from './testUtils';

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
  });
  return { db, admin, owner };
}

describe('setProjectAgentModel (Modellwahl pro Chat)', () => {
  test('neue Projekte starten mit dem Default-Modell (Sonnet 5)', async () => {
    const { db } = await setup();
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5');
  });

  test('setzt ein bekanntes Modell, persistiert es und liefert das Projekt zurück', async () => {
    const { db, owner } = await setup();
    const project = await setProjectAgentModel(db, owner, 'p1', 'qwen3.6-moe');
    expect(project.agentModel).toBe('qwen3.6-moe');
    expect(project.owner.id).toBe(owner.id);
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('qwen3.6-moe');
  });

  test('weist unbekannte Modelle mit DomainError ab', async () => {
    const { db, owner } = await setup();
    await expect(setProjectAgentModel(db, owner, 'p1', 'gpt-5')).rejects.toThrow(DomainError);
    // Der alte Wert bleibt unangetastet.
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5');
  });

  // M5: Die Ownership-Regel hängt am SERVICE, nicht am Resolver — sie greift
  // also auch, wenn setProjectAgentModel direkt aufgerufen wird (Skript,
  // künftiger Transport, Test), ohne den GraphQL-Weg zu nehmen.
  test('weist einen fremden Nutzer ab — auch bei direktem Service-Aufruf (M5)', async () => {
    const { db } = await setup();
    const fremd = await createUser(db, 'eve');
    await expect(setProjectAgentModel(db, fremd, 'p1', 'qwen3.6-moe')).rejects.toThrow(
      /Eigentümer/,
    );
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5');
  });

  test('auch ein Admin darf das Modell eines fremden Projekts NICHT setzen (R10: Owner-only)', async () => {
    // Bewusst strenger als delete/rename (dort Owner ODER Admin): die
    // Chat-Fläche — und dazu gehört die Modellwahl — bleibt Owner-only.
    const { db, admin } = await setup();
    await expect(setProjectAgentModel(db, admin, 'p1', 'qwen3.6-moe')).rejects.toThrow(
      /Eigentümer/,
    );
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5');
  });

  test('unbekanntes Projekt wird mit DomainError abgewiesen', async () => {
    const { db, owner } = await setup();
    await expect(setProjectAgentModel(db, owner, 'gibt-es-nicht', 'qwen3.6-moe')).rejects.toThrow(
      /nicht gefunden/,
    );
  });
});

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { projects } from '../../db/schema';
import { DomainError } from '../errors';
import { setProjectAgentModel } from '../projectsService';
import { createTestDb, createUser } from './testUtils';

async function setup() {
  const db = createTestDb();
  const owner = await createUser(db, 'marco');
  await db.insert(projects).values({
    id: 'p1',
    name: 'Testprojekt',
    branchName: 'marco/testprojekt',
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
    ownerId: owner.id,
  });
  return { db };
}

describe('setProjectAgentModel (Modellwahl pro Chat)', () => {
  test('neue Projekte starten mit dem Default-Modell (Sonnet 5)', async () => {
    const { db } = await setup();
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5');
  });

  test('setzt ein bekanntes Modell und persistiert es', async () => {
    const { db } = await setup();
    await setProjectAgentModel(db, 'p1', 'qwen3.6-moe');
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('qwen3.6-moe');
  });

  test('weist unbekannte Modelle mit DomainError ab', async () => {
    const { db } = await setup();
    await expect(setProjectAgentModel(db, 'p1', 'gpt-5')).rejects.toThrow(DomainError);
    // Der alte Wert bleibt unangetastet.
    const row = (await db.select().from(projects).where(eq(projects.id, 'p1')))[0];
    expect(row?.agentModel).toBe('claude-sonnet-5');
  });
});

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ORDNER = join(import.meta.dir, '..', '..', '..', 'drizzle');

function wendeAn(db: Database, datei: string): void {
  const sql = readFileSync(join(ORDNER, datei), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim() !== '') db.run(statement);
  }
}

/**
 * Migration 0006 zieht bestehende Projekte von den abgelösten Modellen auf ihre
 * Nachfolger. Ohne sie fiele z. B. ein Opus-Projekt auf den Default (Sonnet)
 * zurück, weil „claude-opus-4-8" nicht mehr im Katalog steht.
 */
describe('Migration 0006 — Modelle auf die 5.5-Generation', () => {
  function dbVor0006(): Database {
    const db = new Database(':memory:');
    const dateien = readdirSync(ORDNER)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const datei of dateien.filter((f) => f < '0006')) wendeAn(db, datei);
    db.run(
      `INSERT INTO users (id, username, password_hash, role, approved, created_at) VALUES ('u1','marco','x','admin',1,0)`,
    );
    const projekt = db.prepare(
      `INSERT INTO projects (id, name, branch_name, template_dir, dev_command, preview_port, owner_id, created_at, last_activity_at, claude_session_id, claude_session_model, agent_model)
       VALUES (?, ?, ?, 'pwa', 'bun dev', 3000, 'u1', 0, 0, ?, ?, ?)`,
    );
    projekt.run('p-sonnet', 'a', 'm/a', 's1', 'claude-sonnet-5', 'claude-sonnet-5');
    projekt.run('p-haiku', 'b', 'm/b', null, null, 'claude-haiku-4-5');
    projekt.run('p-opus', 'c', 'm/c', 's3', 'claude-opus-4-8', 'claude-opus-4-8');
    projekt.run('p-qwen', 'd', 'm/d', 's4', 'Qwen3.8-27B-oQ4e-mtp', 'Qwen3.8-27B-oQ4e-mtp');
    return db;
  }

  function modelle(db: Database): Record<string, string> {
    const zeilen = db.query('SELECT id, agent_model FROM projects').all() as {
      id: string;
      agent_model: string;
    }[];
    return Object.fromEntries(zeilen.map((z) => [z.id, z.agent_model]));
  }

  test('bestehende Projekte wandern auf die Nachfolgemodelle, das lokale Modell bleibt', () => {
    const db = dbVor0006();
    wendeAn(db, readdirSync(ORDNER).find((f) => f.startsWith('0006')) as string);
    expect(modelle(db)).toEqual({
      'p-sonnet': 'claude-sonnet-5-5',
      'p-haiku': 'claude-haiku-5-5',
      'p-opus': 'claude-opus-5-5',
      'p-qwen': 'Qwen3.8-27B-oQ4e-mtp',
    });
  });

  test('das Modell der gespeicherten Session bleibt — der nächste Turn startet dadurch frisch', () => {
    // Eine Claude-Code-Session darf nicht über einen Modellwechsel hinweg
    // fortgesetzt werden (s. agentModel.ts); die Abweichung ist gewollt.
    const db = dbVor0006();
    wendeAn(db, readdirSync(ORDNER).find((f) => f.startsWith('0006')) as string);
    const zeile = db
      .query(`SELECT claude_session_id, claude_session_model FROM projects WHERE id='p-opus'`)
      .get() as { claude_session_id: string; claude_session_model: string };
    expect(zeile).toEqual({ claude_session_id: 's3', claude_session_model: 'claude-opus-4-8' });
  });

  test('die Chat-Nachrichten überleben die Migration', () => {
    // Regressionsschutz: eine von drizzle erzeugte Fassung baute die Tabelle
    // projects neu (für einen neuen Spalten-Default). Das DROP TABLE löschte
    // über ON DELETE CASCADE alle chat_messages — auf einer Kopie der
    // Produktionsdaten nachgestellt (3163 Nachrichten → 0).
    const db = dbVor0006();
    db.run('PRAGMA foreign_keys=ON');
    db.run(
      `INSERT INTO chat_messages (id, project_id, turn_id, role, content, created_at) VALUES ('m1','p-opus','t1','user','hallo',0)`,
    );
    db.run('BEGIN');
    wendeAn(db, readdirSync(ORDNER).find((f) => f.startsWith('0006')) as string);
    db.run('COMMIT');
    expect(db.query('SELECT count(*) AS n FROM chat_messages').get()).toEqual({ n: 1 });
  });
});

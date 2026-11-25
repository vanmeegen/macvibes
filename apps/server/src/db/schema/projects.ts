import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** Git-Branch im Bare-Repo, Schema `<username>/<slug>`. */
    branchName: text('branch_name').notNull().unique(),
    templateDir: text('template_dir').notNull(),
    devCommand: text('dev_command').notNull(),
    previewPort: integer('preview_port').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Claude-Session des Agenten — für --resume nach Sandbox-Neustart (R9). */
    claudeSessionId: text('claude_session_id'),
    /**
     * Modell, mit dem die Session erstellt wurde. Wird es geändert, darf die
     * Session NICHT fortgesetzt werden (--resume + anderes --model hängt) —
     * bei Abweichung/NULL startet der Turn frisch.
     */
    claudeSessionModel: text('claude_session_model'),
    /**
     * Vom Nutzer gewähltes Agenten-Modell (Dropdown im Chat, pro Projekt).
     *
     * Der Spalten-Default ist ein ALTBESTAND und wird nie wirksam: der Service
     * setzt das Modell beim Anlegen ausdrücklich (defaultAgentModel), gelesen
     * wird über effectiveAgentModel. Er bleibt stehen, weil SQLite einen
     * Default nur per Tabellen-Neubau ändert — und der löscht über die
     * Fremdschlüssel alle Chat-Nachrichten (s. drizzle/0006_modelle_5_5.sql).
     * NICHT anpassen.
     */
    agentModel: text('agent_model').notNull().default('claude-sonnet-5'),
  },
  (table) => ({
    // Projektnamen müssen nur pro User eindeutig sein.
    ownerNameUnique: uniqueIndex('projects_owner_name_unique').on(table.ownerId, table.name),
  }),
);

export type ProjectRow = typeof projects.$inferSelect;

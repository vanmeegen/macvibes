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
  },
  (table) => ({
    // Projektnamen müssen nur pro User eindeutig sein.
    ownerNameUnique: uniqueIndex('projects_owner_name_unique').on(table.ownerId, table.name),
  }),
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;

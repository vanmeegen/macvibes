import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';

/**
 * Chat-Historie, fortlaufend pro Event persistiert (R6) — übersteht
 * VM-Stopps, Crashes und Abbrüche. Text-Deltas eines Turns werden in der
 * jeweiligen assistant-Zeile fortgeschrieben.
 */
export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Gruppiert alle Nachrichten eines Agent-Turns. */
    turnId: text('turn_id').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'tool', 'system', 'error'] }).notNull(),
    content: text('content').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectIdx: index('chat_messages_project_idx').on(table.projectId, table.createdAt),
  }),
);

export type ChatMessageRow = typeof chatMessages.$inferSelect;

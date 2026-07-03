import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users';

export const sessions = sqliteTable('sessions', {
  /** Der Session-Token selbst (kryptografisch zufällig). */
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;

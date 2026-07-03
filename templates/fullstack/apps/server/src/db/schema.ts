import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
});

export type Note = typeof notes.$inferSelect;

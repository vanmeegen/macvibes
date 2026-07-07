import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Rolle: 'admin' darf andere Nutzer freischalten, sonst 'user'.
  role: text('role', { enum: ['user', 'admin'] })
    .notNull()
    .default('user'),
  // Freischaltung: neue Selbst-Registrierungen sind pending (false), bis ein
  // Admin sie zulässt. Erst dann ist ein Login möglich.
  approved: integer('approved', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

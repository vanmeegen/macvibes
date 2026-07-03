import SchemaBuilder from '@pothos/core';
import { desc } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { db } from '../db';
import { notes, type Note } from '../db/schema';

const builder = new SchemaBuilder({});

const NoteRef = builder.objectRef<Note>('Note');

NoteRef.implement({
  fields: (t) => ({
    id: t.exposeInt('id'),
    text: t.exposeString('text'),
    createdAt: t.exposeString('createdAt'),
  }),
});

builder.queryType({
  fields: (t) => ({
    notes: t.field({
      type: [NoteRef],
      resolve: () => db.select().from(notes).orderBy(desc(notes.id)).all(),
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    addNote: t.field({
      type: NoteRef,
      args: {
        text: t.arg.string({ required: true }),
      },
      resolve: (_root, args) => {
        const text = args.text.trim();
        if (text.length === 0) {
          throw new GraphQLError('Der Notiztext darf nicht leer sein.');
        }
        return db
          .insert(notes)
          .values({ text, createdAt: new Date().toISOString() })
          .returning()
          .get();
      },
    }),
  }),
});

export const schema = builder.toSchema();

import { builder } from './builder';

/**
 * Das GraphQL-Schema, nach Themen geschnitten. Die Wurzeltypen entstehen hier
 * leer; jede thematische Datei hängt ihre Felder per queryFields/
 * mutationFields/subscriptionFields an (Pothos sammelt sie beim Import ein —
 * deshalb MUSS jede Datei hier importiert sein, bevor toSchema() läuft).
 *
 * - types.ts          GraphQL-Objekttypen
 * - guards.ts         requireUser/requireAdmin, Rate-Limit, Session-Abhängigkeiten
 * - authSchema.ts     Konten und Sessions
 * - projectsSchema.ts Projekte, Templates, Modelle
 * - chatSchema.ts     Chat-Verlauf, Live-Events, Senden/Stoppen
 */
builder.queryType({});
builder.mutationType({});
builder.subscriptionType({});

import './authSchema';
import './projectsSchema';
import './chatSchema';

export const schema = builder.toSchema();

import { GraphQLError } from 'graphql';

/**
 * Fehler mit nutzer-präsentierbarer (deutscher) Message.
 *
 * Erbt von `GraphQLError`, damit die Meldung Yogas Fehlermaskierung übersteht
 * (F24): interne Fehler — git-/msb-stderr, Hostpfade, fs-Fehler — werden
 * maskiert, diese hier bewusst nicht. Ohne die Vererbung müsste man die
 * Maskierung ganz abschalten und würde alles durchreichen.
 */
export class DomainError extends GraphQLError {
  constructor(message: string) {
    super(message, { extensions: { code: 'DOMAIN_ERROR' } });
    this.name = 'DomainError';
  }
}

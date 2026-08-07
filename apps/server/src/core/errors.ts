/**
 * Fehler mit nutzer-präsentierbarer (deutscher) Message.
 *
 * Bewusst ein reiner `Error`-Abkömmling: core ist die Basisschicht und kennt
 * die Präsentationstechnik (GraphQL) nicht — die frühere Vererbung von
 * `GraphQLError` hängte das `graphql`-Paket an jeden Wurf in core, services
 * und sandbox. Dass diese Messages Yogas Fehlermaskierung (F24) überstehen —
 * interne Fehler (git-/msb-stderr, Hostpfade, fs-Fehler) werden maskiert,
 * DomainErrors bewusst nicht —, entscheidet allein die http-Schicht per
 * `instanceof DomainError` im maskError-Hook (http/createAppYoga).
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

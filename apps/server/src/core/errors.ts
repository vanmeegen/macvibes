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

/** Strukturelle Sicht auf ein Zod-Schema — core bleibt frei von der zod-Abhängigkeit. */
interface SafeParser<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
}

/**
 * Validiert `value` gegen ein Schema und liefert den geparsten Wert; bei
 * Verstoß fliegt ein DomainError mit der ersten Schema-Meldung (sonst `fallback`).
 */
export function parseOrThrow<T>(schema: SafeParser<T>, value: unknown, fallback: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError(result.error.issues[0]?.message ?? fallback);
  }
  return result.data;
}

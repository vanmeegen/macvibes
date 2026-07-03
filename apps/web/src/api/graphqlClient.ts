export interface GraphQLResponse<T> {
  data?: T;
  errors?: ReadonlyArray<{ message: string }>;
}

/**
 * Kleiner typisierter GraphQL-Client. Sendet immer Cookies mit
 * (Session-Auth via httpOnly-Cookie) und wirft bei GraphQL-Fehlern
 * einen Error mit der ersten (deutschsprachigen) Fehlermeldung.
 */
export async function gqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch('/graphql', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL-Anfrage fehlgeschlagen: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as GraphQLResponse<T>;
  if (body.errors && body.errors.length > 0) {
    const first = body.errors[0];
    throw new Error(first?.message ?? 'Unbekannter GraphQL-Fehler');
  }
  if (body.data === undefined) {
    throw new Error('GraphQL-Antwort enthielt keine Daten');
  }
  return body.data;
}

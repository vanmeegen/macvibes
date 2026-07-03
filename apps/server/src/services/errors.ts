/**
 * Fehler mit nutzer-präsentierbarer (deutscher) Message — wird unmaskiert
 * als GraphQL-Error an das UI durchgereicht.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Ein Token pro Sandbox statt eines Shared Secrets (F4, F12).
 *
 * Vorher authentifizierte EIN prozessweiter `proxyToken` gleichzeitig
 * Credential-Proxy, Egress-Proxy und Agent-Gateway — und steckte identisch in
 * jeder untrusted VM, unter anderem als Query-Parameter in der WS-URL. Eine
 * VM konnte sich damit als fremdes Projekt am Gateway anmelden, dessen Prompts
 * empfangen und gefälschte Agent-Events in fremde Chats schreiben.
 *
 * Die Registry hält nur Hashes: ein Speicherabzug gibt keine gültigen Tokens
 * her, und der Vergleich läuft konstantzeitig.
 */
export interface VmIdentity {
  /** Sandbox-Name, wie ihn der Provider vergibt (macvibes-<projectId>). */
  sandbox: string;
}

export interface VmTokenRegistry {
  /** Stellt ein frisches Token aus; ein älteres derselben Sandbox verfällt. */
  mint(sandbox: string): string;
  /** Entwertet das Token einer Sandbox (beim Stoppen). */
  revoke(sandbox: string): void;
  /** Löst ein Token in seine Identität auf; null = ungültig. */
  lookup(token: string | null | undefined): VmIdentity | null;
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createVmTokenRegistry(): VmTokenRegistry {
  /** hash → Identität. */
  const byHash = new Map<string, VmIdentity>();
  /** sandbox → hash, damit mint/revoke den Vorgänger findet. */
  const bySandbox = new Map<string, string>();

  return {
    mint(sandbox) {
      const previous = bySandbox.get(sandbox);
      if (previous !== undefined) byHash.delete(previous);
      const token = randomBytes(32).toString('hex');
      const digest = hash(token);
      byHash.set(digest, { sandbox });
      bySandbox.set(sandbox, digest);
      return token;
    },
    revoke(sandbox) {
      const digest = bySandbox.get(sandbox);
      if (digest === undefined) return;
      byHash.delete(digest);
      bySandbox.delete(sandbox);
    },
    lookup(token) {
      if (typeof token !== 'string' || token.length === 0) return null;
      const digest = hash(token);
      // Konstantzeitiger Vergleich gegen alle bekannten Hashes: der
      // Map-Lookup allein wäre zwar schnell, aber wir wollen kein
      // längenabhängiges Timing über die Kandidaten hinweg.
      const candidate = Buffer.from(digest, 'hex');
      for (const [known, identity] of byHash) {
        const knownBuf = Buffer.from(known, 'hex');
        if (knownBuf.length === candidate.length && timingSafeEqual(knownBuf, candidate)) {
          return identity;
        }
      }
      return null;
    },
  };
}

/**
 * Host↔VM-Vertrag (B5): Konstanten, die BEIDE Seiten der Sandbox-Grenze
 * kennen müssen und die deshalb keiner Implementierungsschicht gehören.
 *
 * Der Agent in der VM (agent/vmAgentEnv baut seine Umgebung) und die
 * Host-Implementierungen (http/anthropicProxy prüft den Token-Header,
 * sandbox/microsandboxProvider mountet das Config-Verzeichnis) müssen sich
 * auf exakt dieselben Werte einigen — driften sie, bricht der Vertrag
 * stillschweigend (Agent ohne Credentials bzw. ohne Session-Persistenz).
 * Deshalb liegen sie hier als Single Source of Truth in der Basisschicht;
 * die Implementierungen re-exportieren sie von hier, statt eigene Kopien
 * zu halten.
 */

/**
 * Header, mit dem sich die VM gegenüber dem Credential-Proxy des Hosts
 * authentifiziert (Shared Secret; die VM sieht nie einen echten API-Token).
 */
export const PROXY_TOKEN_HEADER = 'x-macvibes-proxy-token';

/**
 * Mountpunkt der persistenten Agent-Config (Claude-Code-Sessiondaten) IN der
 * VM: der Host mountet das Projekt-Volume dorthin, der Agent bekommt den
 * Pfad als CLAUDE_CONFIG_DIR — nur so übersteht `--resume` einen VM-Neustart.
 */
export const AGENT_CONFIG_GUEST_DIR = '/agent-config';

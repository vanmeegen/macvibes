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
 *
 * ACHTUNG: Dieses Modul wird vom Agent-Daemon importiert und damit ins
 * VM-Bundle gebündelt (wie preview/). Host-Code kann hier nicht hinein:
 * agent/daemon/__tests__/bundleGrenze.test.ts scannt die erlaubten Ziele
 * REKURSIV mit — ein Import aus services/, db/ oder sandbox/ bricht dort.
 * Fan-Out 0 ist damit nicht mehr erzwungen (ein Import aus preview/ wäre
 * zulässig), bleibt aber die Richtschnur: ein Vertrag ohne Abhängigkeiten
 * ist der einzige, den jede Seite ohne Beifang übernehmen kann.
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

/**
 * Arbeitsverzeichnis des Projekts IN der VM: der Host mountet den Workspace
 * dorthin (sandbox/microsandboxProvider), die generierten Service-Skripte
 * wechseln vor dem Start dorthin (sandbox/vmServices), und der Agent-Daemon
 * arbeitet dort (Default für MACVIBES_AGENT_CWD). Driftet eine der Stellen,
 * schreibt der Agent an der Live-Preview vorbei bzw. der Dev-Server startet
 * im falschen Verzeichnis — deshalb EINE Quelle statt vier Kopien.
 */
export const GUEST_WORKDIR = '/work';

/**
 * Port der monit-Status-API in der VM. Der Host schreibt ihn in die monitrc
 * (sandbox/vmServices) und reicht ihn dem Daemon als MACVIBES_MONIT_PORT
 * durch; der Daemon fällt ohne diese Env auf denselben Wert zurück. Zwei
 * unabhängige Defaults liefen bei einer Änderung stumm auseinander — der
 * Daemon fände monit dann nicht mehr und der Preview-Status-Push (ADR 0001)
 * fiele still auf die reine HTTP-Probe zurück.
 */
export const MONIT_HTTPD_PORT = 2812;

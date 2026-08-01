/**
 * Zustand des Dev-Servers einer Preview.
 *
 * Bewusst NEUTRAL abgelegt, nicht in `sandbox/provider.ts`: Der In-VM-Daemon
 * meldet diesen Status über das Host↔VM-Protokoll und braucht den Typ deshalb
 * genauso wie die Host-Sandbox-Schicht. Läge er weiter beim Provider, zöge das
 * VM-Bundle eine Abhängigkeit in genau die Schicht, die den Host verwaltet —
 * hinter der Sicherheitsgrenze, auf deren anderer Seite der Daemon läuft.
 */
export type PreviewStatus = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';

/**
 * Zugriff auf microsandbox über das offizielle SDK statt über die `msb`-CLI.
 *
 * Warum der Umstieg: Die CLI-Anbindung (`runMsb`) kannte nur einen Fehlertyp —
 * „irgendein msb-Aufruf ist fehlgeschlagen". Aufrufer mussten daraus raten, was
 * los war, und rieten falsch: `snapshotExists` deutete JEDEN Fehler als
 * „existiert nicht", sodass eine defekte msb-Installation als fehlende Baseline
 * erschien („bitte `bun run baselines` ausführen"). Dieselbe Klasse von
 * stillem Fehlschlag steckte im Shutdown-Skript.
 *
 * Das SDK typisiert Fehler — allerdings UNEINHEITLICH (Stand 0.6.8): Sandboxes
 * werfen `SandboxNotFoundError`, Snapshots dagegen ein generisches `Error` mit
 * der Kennung `[SnapshotNotFound]` im Text. Beides wird hier gekapselt, damit
 * der Rest der Anwendung nur noch eindeutige Begriffe sieht.
 */
import { realpathSync } from 'node:fs';
import { NetworkPolicy, Sandbox, SandboxNotFoundError, Snapshot } from 'microsandbox';

/** Fehlerbegriff der Sandbox-Schicht — ersetzt den CLI-weiten MicrosandboxError. */
export class SandboxRuntimeError extends Error {
  constructor(
    message: string,
    readonly ursache?: unknown,
  ) {
    super(message);
    this.name = 'SandboxRuntimeError';
  }
}

function fehlertext(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/** Ist das der Fehler „diese Sandbox gibt es nicht"? */
export function istSandboxNichtGefunden(error: unknown): boolean {
  return error instanceof SandboxNotFoundError;
}

/**
 * Ist das der Fehler „diesen Snapshot gibt es nicht"?
 *
 * Anders als bei Sandboxes gibt es dafür (noch) keine eigene Fehlerklasse; das
 * SDK liefert ein generisches `Error` mit `code = 'GenericFailure'` und der
 * Kennung im Text. Die Prüfung hängt damit an einer Zeichenkette — bewusst eng
 * gefasst, damit ein anderer Fehler nicht versehentlich als „fehlt" durchgeht.
 * Sobald das SDK eine `SnapshotNotFoundError`-Klasse mitbringt, gehört das hier
 * ersetzt.
 */
export function istSnapshotNichtGefunden(error: unknown): boolean {
  return fehlertext(error).includes('[SnapshotNotFound]');
}

/** Ist die microsandbox-Laufzeit benutzbar? */
export async function msbAvailable(): Promise<boolean> {
  try {
    await Sandbox.list();
    return true;
  } catch {
    return false;
  }
}

/**
 * Existiert ein Snapshot mit diesem Namen?
 *
 * Nur ein echtes „nicht gefunden" ergibt `false`. Jeder andere Fehler (defekte
 * Installation, Schema-Konflikt, fehlende Rechte) fliegt weiter — sonst
 * verwandelt sich ein kaputtes Werkzeug in eine irreführende Fachmeldung.
 */
export async function snapshotExists(name: string): Promise<boolean> {
  try {
    await Snapshot.get(name);
    return true;
  } catch (error) {
    if (istSnapshotNichtGefunden(error)) return false;
    throw new SandboxRuntimeError(
      `Snapshot „${name}" konnte nicht geprüft werden: ${fehlertext(error)}`,
      error,
    );
  }
}

/**
 * Stoppt eine Sandbox. Eine unbekannte Sandbox ist KEIN Fehler — der
 * Aufräumpfad läuft auch, wenn schon jemand aufgeräumt hat. Jeder andere
 * Fehler fliegt weiter, statt als „war halt schon weg" durchzugehen.
 */
export async function stopSandbox(name: string): Promise<void> {
  try {
    const handle = await Sandbox.get(name);
    await handle.stop();
  } catch (error) {
    if (istSandboxNichtGefunden(error)) return;
    throw new SandboxRuntimeError(
      `Sandbox „${name}" konnte nicht gestoppt werden: ${fehlertext(error)}`,
      error,
    );
  }
}

/** Entfernt eine Sandbox. Unbekannt = kein Fehler (siehe stopSandbox). */
export async function removeSandbox(name: string): Promise<void> {
  try {
    await Sandbox.remove(name);
  } catch (error) {
    if (istSandboxNichtGefunden(error)) return;
    throw new SandboxRuntimeError(
      `Sandbox „${name}" konnte nicht entfernt werden: ${fehlertext(error)}`,
      error,
    );
  }
}

export interface WaitForReadyOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Injizierbar für Tests; Default ist der Agent-Ping des SDK. */
  probe?: (name: string) => Promise<unknown>;
}

/**
 * Wartet, bis der Agent der Sandbox erreichbar ist.
 *
 * `msb run -d` kehrt zurück, bevor der Gast-Agent bereit ist — ohne dieses
 * Warten scheitern frühe Aufrufe („no agent endpoint found"). Als Probe dient
 * jetzt `ping()`, das genau diese Frage beantwortet; vorher wurde ersatzweise
 * `exec … true` ausgeführt, also ein ganzer Kommandostart nur als Lebenszeichen.
 */
export async function waitForSandboxReady(
  name: string,
  options: WaitForReadyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const probe =
    options.probe ??
    (async (n: string) => {
      const handle = await Sandbox.get(n);
      return handle.ping();
    });

  const start = Date.now();
  let letzterFehler: unknown = null;
  for (;;) {
    try {
      await probe(name);
      return;
    } catch (error) {
      letzterFehler = error;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new SandboxRuntimeError(
        `Sandbox „${name}" wurde nicht bereit (${timeoutMs} ms): ${fehlertext(letzterFehler)}`,
        letzterFehler,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Ein Mount in die Sandbox. `readonly` entspricht dem bisherigen `:ro`. */
export interface SandboxMount {
  host: string;
  guest: string;
  readonly?: boolean;
}

/** Alles, was macvibes zum Start einer Projekt-VM braucht. */
export interface SandboxSpec {
  name: string;
  /**
   * Baseline-Snapshot, aus dem geforkt wird — der Normalfall für Projekt-VMs.
   * Alternativ `image` für die Builder-VM, die den Snapshot erst erzeugt.
   */
  snapshot?: string;
  /** OCI-Image statt Snapshot (Baseline-Bau). Genau eines von beiden. */
  image?: string;
  workdir: string;
  cpus: number;
  memoryMib: number;
  previewHostPort: number;
  previewGuestPort: number;
  mounts: SandboxMount[];
  /** PID-1-Kommando, z. B. ['/bin/sh', '-c', '<bootstrap>; <supervisor>']. */
  command: string[];
  /**
   * Netzzugang. `projekt` = die gehärtete Egress-Policy (Default): Egress
   * gesperrt, erlaubt sind öffentliches Netz und Host-Gateway. `unbeschraenkt`
   * = keine Policy — nötig für die Baseline-Builder-VM, die apt und das
   * npm-Registry erreichen muss und die auch vorher (CLI ohne --net-rule)
   * keine Beschränkung hatte. Sie läuft ohne Agent und nur beim Baseline-Bau.
   */
  netzwerk?: 'projekt' | 'unbeschraenkt';
}

/**
 * Übersetzt eine SandboxSpec in die Startkonfiguration.
 *
 * Getrennt von `startSandbox`, weil `build()` die Konfiguration als Daten
 * liefert, ohne eine VM zu starten: die sicherheitskritischen Teile
 * (Egress-Policy, Loopback-Bindung des Preview-Ports, Nur-Lese-Mounts) sind
 * damit im Test prüfbar, statt nur im laufenden System.
 *
 * Die Netz-Policy bildet exakt das ab, was vorher
 * `--net-rule 'allow@public,allow@172.16.0.0/12'` erzeugte — abgeglichen mit
 * der Konfiguration einer per CLI gestarteten Sandbox: Egress standardmäßig
 * gesperrt (der Agent kommt nicht ins LAN und nicht ans Host-Loopback),
 * erlaubt sind das öffentliche Netz (bun/npm/Claude) und das Host-Gateway für
 * den Credential-Proxy.
 */
export async function buildSandboxConfig(spec: SandboxSpec): Promise<unknown> {
  return bauBuilder(spec).build();
}

/**
 * Egress-Policy der Projekt-VMs. Entspricht Zeichen für Zeichen der
 * Konfiguration, die vorher `--net-rule 'allow@public,allow@172.16.0.0/12'`
 * erzeugte (gegen configJson einer per CLI gestarteten Sandbox abgeglichen):
 * Egress standardmäßig gesperrt — der Agent erreicht weder LAN noch das
 * Host-Loopback —, erlaubt sind das öffentliche Netz (bun/npm/Claude) und das
 * Host-Gateway für den Credential-Proxy.
 */
function egressPolicy() {
  return (
    NetworkPolicy.builder()
      .defaultEgress('deny')
      .defaultIngress('allow')
      // DNS zum Host-Resolver. FEHLTE bisher — die alte CLI-Regel
      // `allow@public,allow@172.16.0.0/12` enthielt keine DNS-Ausnahme, damit
      // war „öffentliches Netz erlaubt" für Namen unbrauchbar: in einer
      // Projekt-VM scheiterte jede Namensauflösung (nachgemessen), also auch
      // das per ADR 0002 vorgesehene `bun add` des Agenten, sobald der
      // persistente Cache nicht traf. Die Regel entspricht Wort für Wort dem
      // Default, den die Laufzeit selbst setzt, wenn man keine Policy angibt —
      // sie öffnet nur Port 53 zum Host, nicht das LAN.
      .egress((r) =>
        r
          .tcp()
          .udp()
          .port(53)
          .allow((d) => d.group('host')),
      )
      .egress((r) => r.allowPublic())
      .egress((r) => r.allow((d) => d.cidr('172.16.0.0/12')))
  );
}

function bauBuilder(spec: SandboxSpec) {
  if ((spec.snapshot === undefined) === (spec.image === undefined)) {
    throw new SandboxRuntimeError(
      `Sandbox „${spec.name}": genau eines von snapshot oder image angeben`,
    );
  }
  const basis = Sandbox.builder(spec.name);
  let builder = (
    spec.snapshot !== undefined
      ? basis.fromSnapshot(spec.snapshot)
      : basis.image(spec.image as string)
  )
    .workdir(spec.workdir)
    .cpus(spec.cpus)
    .memory(spec.memoryMib)
    .detached(true)
    .replace()
    .quietLogs()
    // Port UND Policy müssen im SELBEN network()-Aufruf stehen: ein späteres
    // network() ersetzt die Netzkonfiguration, ein davor gesetzter portBind
    // ginge also stillschweigend verloren (im gebauten Config als ports: []
    // sichtbar — die Preview wäre nicht erreichbar).
    .network((n) => {
      // H1: ausschließlich ans Host-Loopback binden. Erreichbar ist die
      // Preview nur über das Gateway, das die Session prüft.
      const mitPort =
        spec.previewHostPort > 0
          ? n.portBind('127.0.0.1', spec.previewHostPort, spec.previewGuestPort)
          : n;
      return spec.netzwerk === 'unbeschraenkt' ? mitPort : mitPort.policy(egressPolicy());
    });

  for (const mount of spec.mounts) {
    builder = builder.volume(mount.guest, (b) => {
      // Quelle auflösen: msb folgt Symlinks im Quellpfad seit 0.6.8 nicht mehr.
      const gebunden = b.bind(realpathSync(mount.host));
      return mount.readonly === true ? gebunden.readonly() : gebunden;
    });
  }

  const [cmd, ...args] = spec.command;
  if (cmd === undefined) {
    throw new SandboxRuntimeError(`Sandbox „${spec.name}": leeres Startkommando`);
  }
  // init verlangt einen absoluten Pfad (oder `auto`) — 'sh' allein wird
  // abgelehnt. Die CLI nahm das noch entgegen.
  return builder.init(cmd, args);
}

/**
 * Startet eine Projekt-VM im Hintergrund und wartet NICHT auf ihre
 * Bereitschaft — dafür ist `waitForSandboxReady` da (der Agent-Endpunkt ist
 * erst später erreichbar).
 */
export async function startSandbox(spec: SandboxSpec): Promise<void> {
  try {
    await bauBuilder(spec).create();
  } catch (error) {
    throw new SandboxRuntimeError(
      `Sandbox „${spec.name}" konnte nicht gestartet werden: ${fehlertext(error)}`,
      error,
    );
  }
}

/**
 * Führt ein Shell-Skript in einer laufenden Sandbox aus und liefert stdout.
 * Ein Exit-Code ungleich 0 ist ein Fehler — vorher ging er im generischen
 * „msb exec schlug fehl" unter, ohne stderr.
 */
export async function execShell(name: string, script: string): Promise<string> {
  try {
    const handle = await Sandbox.get(name);
    const sandbox = await handle.connect();
    const out = await sandbox.shell(script);
    if (!out.success) {
      throw new SandboxRuntimeError(
        `Kommando in „${name}" endete mit Code ${out.code}: ${out.stderr().trim().slice(0, 500)}`,
      );
    }
    return out.stdout();
  } catch (error) {
    if (error instanceof SandboxRuntimeError) throw error;
    throw new SandboxRuntimeError(
      `Kommando in „${name}" fehlgeschlagen: ${fehlertext(error)}`,
      error,
    );
  }
}

/** Erzeugt einen Snapshot aus einer (gestoppten) Sandbox. */
export async function createSnapshot(name: string, fromSandbox: string): Promise<void> {
  try {
    await Snapshot.builder(name).fromSandbox(fromSandbox).force().create();
  } catch (error) {
    throw new SandboxRuntimeError(
      `Snapshot „${name}" konnte nicht erzeugt werden: ${fehlertext(error)}`,
      error,
    );
  }
}

/** Entfernt einen Snapshot. Nicht vorhanden = kein Fehler. */
export async function removeSnapshot(name: string): Promise<void> {
  try {
    await Snapshot.remove(name, { force: true });
  } catch (error) {
    if (istSnapshotNichtGefunden(error)) return;
    throw new SandboxRuntimeError(
      `Snapshot „${name}" konnte nicht entfernt werden: ${fehlertext(error)}`,
      error,
    );
  }
}

/** Namen aller bekannten Sandboxes (laufend und gestoppt). */
export async function listSandboxNames(): Promise<string[]> {
  try {
    const seite = await Sandbox.list();
    return seite.sandboxes.map((s) => s.name);
  } catch (error) {
    throw new SandboxRuntimeError(
      `Sandboxes konnten nicht aufgelistet werden: ${fehlertext(error)}`,
      error,
    );
  }
}

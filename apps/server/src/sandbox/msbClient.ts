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
 * Das SDK typisiert Fehler (`SandboxNotFoundError` u. a.). Das wird hier
 * gekapselt, damit der Rest der Anwendung nur noch eindeutige Begriffe sieht.
 *
 * Begriffe seit 0.8: Was macvibes „Snapshot" nennt (ein benannter
 * Plattenstand, aus dem Projekt-VMs entstehen), heißt im SDK `Checkpoint`;
 * `Snapshot` ist dort eine Gruppe von Checkpoints mit Verlauf. macvibes
 * braucht keinen Verlauf und bleibt bei benannten Einzelständen.
 */
import { realpathSync } from 'node:fs';
import {
  Checkpoint,
  NetworkPolicy,
  Sandbox,
  SandboxNotFoundError,
  SandboxNotRunningError,
  Snapshot,
  StopTimeoutError,
} from 'microsandbox';

/** Fehlerbegriff der Sandbox-Schicht — ersetzt den CLI-weiten MicrosandboxError. */
export class SandboxRuntimeError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SandboxRuntimeError';
  }
}

function fehlertext(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/**
 * Führt einen SDK-Aufruf aus und kapselt jeden Fehler als SandboxRuntimeError
 * (`<beschreibung>: <Fehlertext>`). Mit `nichtGefunden` wird genau dieser eine
 * Fehlerfall zum Rückgabewert — alles andere fliegt weiter, statt als „war
 * halt nicht da" durchzugehen.
 */
async function msbCall<T>(
  beschreibung: string,
  aufruf: () => Promise<T>,
  nichtGefunden?: { ist: (error: unknown) => boolean; wert: T },
): Promise<T> {
  try {
    return await aufruf();
  } catch (error) {
    if (nichtGefunden?.ist(error) === true) return nichtGefunden.wert;
    throw new SandboxRuntimeError(`${beschreibung}: ${fehlertext(error)}`, error);
  }
}

/** Ist das der Fehler „diese Sandbox gibt es nicht"? */
export function isSandboxNotFound(error: unknown): boolean {
  return error instanceof SandboxNotFoundError;
}

/**
 * Ist die microsandbox-Laufzeit benutzbar? Der Grund für ein „nein" wird
 * geloggt: sonst sieht eine DEFEKTE Installation genauso aus wie eine fehlende
 * — derselbe stille Fehlschlag, den der Kopfkommentar dieser Datei beschreibt.
 */
export async function msbAvailable(): Promise<boolean> {
  try {
    await Sandbox.list();
    return true;
  } catch (error) {
    console.warn(`microsandbox ist nicht benutzbar: ${fehlertext(error) || String(error)}`);
    return false;
  }
}

/**
 * Wo liegt der Snapshot mit diesem Namen — als Angabe, aus der `Sandbox.restore`
 * starten kann? `null`, wenn es ihn nicht gibt.
 *
 * Seit 0.8 gibt es zwei Formen:
 * - **Gruppe** (alles, was macvibes ab 0.8 baut): der Name ist der Gruppenname,
 *   gestartet wird ihr aktueller Stand (Head).
 * - **Einzelstand ohne Gruppe** (Baselines aus 0.6.x): die Laufzeit findet sie
 *   nicht mehr über den Namen, nur über den Pfad. Sie starten weiter, bis
 *   `bun run baselines` sie durch eine Gruppe ersetzt.
 *
 * Bewusst über die Listen statt über „get + Fehler deuten": ein alter
 * Einzelstand meldet sich bei `get` als InvalidConfig, eine fehlende Gruppe als
 * IoError — beides taugt nicht als eindeutiges „fehlt".
 */
async function findeSnapshot(name: string): Promise<string | null> {
  const gruppen = await Snapshot.list();
  const gruppe = gruppen.find((g) => g.name === name);
  if (gruppe !== undefined && (await gruppe.head()) !== null) return name;
  const staende = await Checkpoint.list();
  return staende.find((c) => c.group === null && c.name === name)?.path ?? null;
}

/**
 * Existiert ein Snapshot mit diesem Namen?
 *
 * Jeder Fehler der Laufzeit (defekte Installation, Schema-Konflikt, fehlende
 * Rechte) fliegt weiter — sonst verwandelt sich ein kaputtes Werkzeug in eine
 * irreführende Fachmeldung („bitte `bun run baselines` ausführen").
 */
export async function snapshotExists(name: string): Promise<boolean> {
  return msbCall(
    `Snapshot „${name}" konnte nicht geprüft werden`,
    async () => (await findeSnapshot(name)) !== null,
  );
}

/** Frist für das geordnete Herunterfahren, danach wird die VM beendet. */
const STOPP_FRIST_MS = 10_000;

/**
 * Stoppt eine Sandbox. Eine unbekannte Sandbox ist KEIN Fehler — der
 * Aufräumpfad läuft auch, wenn schon jemand aufgeräumt hat. Jeder andere
 * Fehler fliegt weiter, statt als „war halt schon weg" durchzugehen.
 *
 * Seit 0.7 hat das geordnete Stoppen keine eigene Frist mehr und beendet die
 * VM auch nicht von sich aus. Reagiert PID 1 nicht rechtzeitig, wird sie
 * deshalb hier beendet — sonst bliebe sie im Zustand „draining" stehen und
 * ließe sich weder entfernen noch als Snapshot einfrieren.
 */
export async function stopSandbox(name: string): Promise<void> {
  await msbCall(
    `Sandbox „${name}" konnte nicht gestoppt werden`,
    async () => {
      const sandbox = await Sandbox.get(name);
      try {
        await sandbox.stopWithTimeout(STOPP_FRIST_MS);
      } catch (error) {
        if (!(error instanceof StopTimeoutError)) throw error;
        console.warn(`Sandbox „${name}" reagiert nicht auf das Stoppen — wird beendet.`);
        await sandbox.killWithTimeout(STOPP_FRIST_MS);
      }
    },
    { ist: isSandboxNotFound, wert: undefined },
  );
}

/** Entfernt eine Sandbox. Unbekannt = kein Fehler (siehe stopSandbox). */
export async function removeSandbox(name: string): Promise<void> {
  await msbCall(`Sandbox „${name}" konnte nicht entfernt werden`, () => Sandbox.remove(name), {
    ist: isSandboxNotFound,
    wert: undefined,
  });
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
      // `get` + `ping` startet eine gestoppte Sandbox NICHT (anders als
      // `getRunning` oder ein Kommando) — die Probe bleibt eine reine Frage.
      const sandbox = await Sandbox.get(n);
      return sandbox.ping();
    });

  const start = Date.now();
  let letzterFehler: unknown;
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
    await Bun.sleep(intervalMs);
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
   * Netzzugang. `project` = die gehärtete Egress-Policy (Default): Egress
   * gesperrt, erlaubt sind öffentliches Netz und Host-Gateway. `unrestricted`
   * = keine Policy — nötig für die Baseline-Builder-VM, die apt und das
   * npm-Registry erreichen muss und die auch vorher (CLI ohne --net-rule)
   * keine Beschränkung hatte. Sie läuft ohne Agent und nur beim Baseline-Bau.
   */
  network?: 'project' | 'unrestricted';
  /**
   * Idle-Frist der VM in Sekunden (ADR 0003) — Auffangnetz, falls der Host
   * stirbt und niemand mehr die Frist zurücksetzt. Ohne Angabe: keine Frist.
   */
  idleTimeoutSecs?: number;
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
  if (spec.image === undefined) {
    throw new SandboxRuntimeError(
      `Sandbox „${spec.name}": die Startkonfiguration lässt sich nur für Image-Starts vorab bauen — für Snapshot-Starts liefert sie readSandboxConfig() an der laufenden VM`,
    );
  }
  pruefeSpec(spec);
  return bauImageBuilder(spec, spec.image).build();
}

/**
 * Liest die wirksame Konfiguration einer vorhandenen Sandbox. Für
 * Snapshot-Starts der einzige Weg, Egress-Policy, Port-Bindung und
 * Nur-Lese-Mounts zu prüfen: der Restore-Builder (seit 0.7) gibt seine
 * Konfiguration nicht vorab heraus.
 */
export async function readSandboxConfig(name: string): Promise<unknown> {
  return msbCall(`Konfiguration von „${name}" konnte nicht gelesen werden`, async () => {
    const sandbox = await Sandbox.get(name);
    const inspektion = (await sandbox.config()) as unknown as { spec: unknown };
    return inspektion.spec;
  });
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

function pruefeSpec(spec: SandboxSpec): [string, string[]] {
  if ((spec.snapshot === undefined) === (spec.image === undefined)) {
    throw new SandboxRuntimeError(
      `Sandbox „${spec.name}": genau eines von snapshot oder image angeben`,
    );
  }
  const [cmd, ...args] = spec.command;
  if (cmd === undefined) {
    throw new SandboxRuntimeError(`Sandbox „${spec.name}": leeres Startkommando`);
  }
  return [cmd, args];
}

/** Start aus einem OCI-Image — nur die Builder-VM des Baseline-Baus. */
function bauImageBuilder(spec: SandboxSpec, image: string) {
  const [cmd, args] = pruefeSpec(spec);
  let builder = Sandbox.builder(spec.name)
    .image(image)
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
      return spec.network === 'unrestricted' ? mitPort : mitPort.policy(egressPolicy());
    });

  for (const mount of spec.mounts) {
    builder = builder.volume(mount.guest, (b) => {
      // Quelle auflösen: msb folgt Symlinks im Quellpfad seit 0.6.8 nicht mehr.
      const gebunden = b.bind(realpathSync(mount.host));
      return mount.readonly === true ? gebunden.readonly() : gebunden;
    });
  }

  if (spec.idleTimeoutSecs !== undefined) {
    builder = builder.idleTimeoutSeconds(spec.idleTimeoutSecs);
  }

  // init verlangt einen absoluten Pfad (oder `auto`) — 'sh' allein wird
  // abgelehnt. Die CLI nahm das noch entgegen.
  return builder.init(cmd, args);
}

/**
 * Start aus einem Snapshot — der Normalfall für Projekt-VMs. Seit 0.7 ein
 * eigener Builder (`Sandbox.restore`): er startet immer im Hintergrund und
 * kennt kein „ersetzen" (siehe `startSandbox`).
 */
function bauRestore(spec: SandboxSpec, quelle: string) {
  const [cmd, args] = pruefeSpec(spec);
  let builder = Sandbox.restore(quelle)
    .name(spec.name)
    .workdir(spec.workdir)
    .cpus(spec.cpus)
    .memory(spec.memoryMib)
    // Die Baseline merkt sich die Mounts ihrer Builder-VM (Templates,
    // Daemon-Bundle). Eine Projekt-VM bringt eigene Mounts mit und braucht
    // die der Builder-VM nicht — ohne diese Angabe verweigert die Laufzeit
    // den Start, solange nicht jeder gemerkte Mount wieder zugeordnet ist.
    .allowMissingResources();

  // H1: ausschließlich ans Host-Loopback binden (wie beim Image-Start).
  if (spec.previewHostPort > 0) {
    builder = builder.portBind('127.0.0.1', spec.previewHostPort, spec.previewGuestPort);
  }
  // Ohne eigene Policy gilt der Default der Laufzeit; die gehärtete
  // Egress-Policy ist der Normalfall und muss ausdrücklich abgewählt werden.
  if (spec.network !== 'unrestricted') {
    builder = builder.networkPolicy(egressPolicy());
  }

  for (const mount of spec.mounts) {
    builder = builder.volume(mount.guest, (b) => {
      const gebunden = b.bind(realpathSync(mount.host));
      return mount.readonly === true ? gebunden.readonly() : gebunden;
    });
  }

  if (spec.idleTimeoutSecs !== undefined) {
    builder = builder.idleTimeoutSeconds(spec.idleTimeoutSecs);
  }

  return builder.init(cmd, args);
}

/**
 * Startet eine VM im Hintergrund und wartet NICHT auf ihre Bereitschaft —
 * dafür ist `waitForSandboxReady` da (der Agent-Endpunkt ist erst später
 * erreichbar). Eine vorhandene Sandbox gleichen Namens wird ersetzt.
 */
export async function startSandbox(spec: SandboxSpec): Promise<void> {
  pruefeSpec(spec);
  if (spec.image !== undefined) {
    const image = spec.image;
    await msbCall(`Sandbox „${spec.name}" konnte nicht gestartet werden`, async () => {
      await bauImageBuilder(spec, image).create();
    });
    return;
  }
  const snapshot = spec.snapshot as string;
  const quelle = await msbCall(`Snapshot „${snapshot}" konnte nicht geprüft werden`, () =>
    findeSnapshot(snapshot),
  );
  if (quelle === null) {
    throw new SandboxRuntimeError(
      `Sandbox „${spec.name}" konnte nicht gestartet werden: Snapshot „${snapshot}" fehlt`,
    );
  }
  // Der Restore-Builder kennt kein replace(): ein Rest gleichen Namens (z. B.
  // nach einem Host-Absturz) muss vorher weg, sonst scheitert der Start an
  // „sandbox already exists".
  await stopSandbox(spec.name);
  await removeSandbox(spec.name);
  await msbCall(`Sandbox „${spec.name}" konnte nicht gestartet werden`, async () => {
    await bauRestore(spec, quelle).restore();
  });
}

/**
 * Führt ein Shell-Skript in einer laufenden Sandbox aus und liefert stdout.
 * Ein Exit-Code ungleich 0 ist ein Fehler — vorher ging er im generischen
 * „msb exec schlug fehl" unter, ohne stderr.
 *
 * Seit 0.8 würde ein Kommando eine GESTOPPTE Sandbox von sich aus starten.
 * macvibes will das nicht (eine gestoppte VM ist Absicht des Lebenszyklus),
 * deshalb wird der Zustand vorher geprüft.
 */
export async function execShell(name: string, script: string): Promise<string> {
  try {
    const sandbox = await Sandbox.get(name);
    const status = await sandbox.status();
    if (status !== 'running') {
      throw new SandboxRuntimeError(`Sandbox „${name}" läuft nicht (Zustand: ${status})`);
    }
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

/**
 * Erzeugt einen Snapshot aus einer (gestoppten) Sandbox und ersetzt dabei einen
 * vorhandenen gleichen Namens.
 *
 * Seit 0.7 sind Stände in einer Gruppe unveränderlich, das frühere
 * Überschreiben (`force`) gibt es nicht mehr. Der Name wird zur Gruppe mit
 * genau einem Stand: erst weg, dann neu.
 */
export async function createSnapshot(name: string, fromSandbox: string): Promise<void> {
  await removeSnapshot(name);
  await msbCall(`Snapshot „${name}" konnte nicht erzeugt werden`, async () => {
    await Checkpoint.builder().group(name).fromSandbox(fromSandbox).create();
  });
}

/**
 * Entfernt einen Snapshot — die Gruppe dieses Namens UND einen gleichnamigen
 * Einzelstand aus 0.6.x. Nicht vorhanden = kein Fehler.
 */
export async function removeSnapshot(name: string): Promise<void> {
  await msbCall(`Snapshot „${name}" konnte nicht entfernt werden`, async () => {
    const gruppen = await Snapshot.list();
    await gruppen.find((g) => g.name === name)?.remove();
    const staende = await Checkpoint.list();
    for (const alt of staende.filter((c) => c.group === null && c.name === name)) {
      await Checkpoint.remove(alt.path, { force: true });
    }
  });
}

/** Namen aller bekannten Sandboxes (laufend und gestoppt). */
export async function listSandboxNames(): Promise<string[]> {
  return msbCall('Sandboxes konnten nicht aufgelistet werden', async () => {
    const seite = await Sandbox.list();
    return seite.sandboxes.map((s) => s.name);
  });
}

/**
 * Setzt die Idle-Frist einer Sandbox zurück (ADR 0003).
 *
 * Eine unbekannte Sandbox ist kein Fehler, aber auch kein Geheimnis mehr (M2):
 * Zwischen dem Auslösen und dem Eintreffen kann sie regulär gestoppt worden
 * sein — oder sie ist gestorben, während der Manager sie noch für `running`
 * hält. Deshalb `false` statt stillem Schlucken: der SandboxManager markiert
 * den Eintrag und heilt beim nächsten Wieder-Öffnen.
 */
export async function touchSandbox(name: string): Promise<boolean> {
  return msbCall(
    `Idle-Frist von „${name}" konnte nicht zurückgesetzt werden`,
    async () => {
      const sandbox = await Sandbox.get(name);
      await sandbox.touch();
      return true;
    },
    // Gestoppt zählt wie unbekannt: seit 0.8 meldet die Laufzeit das als
    // eigenen Fehler, für den Manager ist es dieselbe Auskunft.
    { ist: (e) => isSandboxNotFound(e) || e instanceof SandboxNotRunningError, wert: false },
  );
}

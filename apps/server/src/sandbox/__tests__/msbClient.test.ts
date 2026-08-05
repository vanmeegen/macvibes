import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { SandboxNotFoundError } from 'microsandbox';
import {
  buildSandboxConfig,
  istSandboxNichtGefunden,
  istSnapshotNichtGefunden,
  msbAvailable,
  removeSandbox,
  snapshotExists,
  stopSandbox,
  waitForSandboxReady,
} from '../msbClient';

const available = await msbAvailable();
// Zustands-Gates statt Maschinen-Annahmen (P8): Diese Snapshots existieren
// nur, wo `bun run baselines` gelaufen ist (Entwickler-Mac). Ohne sie werden
// die Laufzeit-Tests ÜBERSPRUNGEN statt irreführend rot — z. B. auf einem
// frischen Windows-Rechner, wo der Baseline-Bau bis zum msb#1218-Fix-Release
// ohnehin blockiert ist (windows-portierung.md).
const msbtestSnapshotDa = available && (await snapshotExists('macvibes-tpl-msbtest-v2'));
const pwaSnapshotDa = available && (await snapshotExists('macvibes-tpl-pwa'));

/**
 * Die Fehlerklassifikation ist der Kern des Umstiegs auf das SDK: vorher wurde
 * JEDER msb-Fehler als „existiert nicht" gedeutet (runMsb warf für alles
 * denselben MicrosandboxError). War msb kaputt, meldete macvibes deshalb
 * „Keine Baseline — bitte bun run baselines" statt des echten Fehlers.
 */
describe('Fehlerklassifikation', () => {
  test('erkennt eine fehlende Sandbox am typisierten Fehler', () => {
    expect(istSandboxNichtGefunden(new SandboxNotFoundError('sandbox not found: x'))).toBe(true);
  });

  test('deutet andere Fehler NICHT als „fehlt"', () => {
    // Genau der Fall, der die Baseline-Meldung vorher verfälscht hat.
    const schema = new Error('runtime error: database schema is newer than this msb binary');
    expect(istSandboxNichtGefunden(schema)).toBe(false);
    expect(istSnapshotNichtGefunden(schema)).toBe(false);
    expect(istSandboxNichtGefunden(new Error('permission denied'))).toBe(false);
    expect(istSnapshotNichtGefunden(new Error('permission denied'))).toBe(false);
  });

  test('erkennt einen fehlenden Snapshot an der Kennung im Text', () => {
    // Das SDK typisiert Snapshot-Fehler (noch) nicht: Snapshot.get wirft ein
    // generiches Error mit code=GenericFailure und der Kennung im Text.
    // Empirisch geprüft gegen microsandbox 0.6.8.
    expect(
      istSnapshotNichtGefunden(new Error('[SnapshotNotFound] snapshot not found: gibtsnicht')),
    ).toBe(true);
  });

  test('verträgt Nicht-Fehler ohne zu werfen', () => {
    for (const wert of [null, undefined, 'text', 42, {}]) {
      expect(istSandboxNichtGefunden(wert)).toBe(false);
      expect(istSnapshotNichtGefunden(wert)).toBe(false);
    }
  });
});

describe.skipIf(!available)('snapshotExists (gegen die echte Laufzeit)', () => {
  test.skipIf(!msbtestSnapshotDa)('findet einen vorhandenen Snapshot', async () => {
    expect(await snapshotExists('macvibes-tpl-msbtest-v2')).toBe(true);
  });

  test('meldet einen fehlenden Snapshot als false', async () => {
    expect(await snapshotExists('macvibes-gibt-es-nicht-xyz')).toBe(false);
  });
});

describe.skipIf(!available)('Stoppen und Entfernen (gegen die echte Laufzeit)', () => {
  test('stopSandbox einer unbekannten Sandbox ist folgenlos', async () => {
    // Idempotenz: der Aufräumpfad läuft auch, wenn schon jemand aufgeräumt hat.
    await expect(stopSandbox('macvibes-gibt-es-nicht-xyz')).resolves.toBeUndefined();
  });

  test('removeSandbox einer unbekannten Sandbox ist folgenlos', async () => {
    await expect(removeSandbox('macvibes-gibt-es-nicht-xyz')).resolves.toBeUndefined();
  });
});

describe('waitForSandboxReady', () => {
  test('kehrt zurück, sobald die Probe gelingt', async () => {
    let versuche = 0;
    await waitForSandboxReady('egal', {
      timeoutMs: 1000,
      intervalMs: 5,
      probe: async () => {
        versuche += 1;
        if (versuche < 3) throw new Error('noch nicht bereit');
      },
    });
    expect(versuche).toBe(3);
  });

  test('meldet nach der Frist einen Fehler, der die letzte Ursache nennt', async () => {
    // Vorher stand hier nur „wurde nicht exec-bereit" plus String(error) —
    // die eigentliche Ursache ging im Text unter.
    const versuch = waitForSandboxReady('kaputt', {
      timeoutMs: 30,
      intervalMs: 5,
      probe: async () => {
        throw new Error('agent nicht erreichbar');
      },
    });
    await expect(versuch).rejects.toThrow(/kaputt/);
    await expect(versuch).rejects.toThrow(/agent nicht erreichbar/);
  });
});

/**
 * Die Startkonfiguration ist der sicherheitskritischste Teil des Umstiegs:
 * Egress-Policy, Port-Bindung und Nur-Lese-Mounts hängen daran. `build()`
 * liefert sie als Daten, ohne eine VM zu starten — deshalb ist sie hier
 * vollständig prüfbar.
 *
 * Die Erwartungswerte stammen NICHT aus dem Kopf, sondern aus der
 * Konfiguration, die die CLI mit `--net-rule 'allow@public,allow@172.16.0.0/12'`
 * erzeugt hat (per configJson ausgelesen und verglichen).
 */
describe.skipIf(!pwaSnapshotDa)(
  'Startkonfiguration (Übersetzung der bisherigen CLI-Aufrufe)',
  () => {
    // tmpdir() statt '/private/tmp': muss auf JEDER Plattform real existieren,
    // weil bauBuilder die Mount-Quelle mit realpathSync auflöst.
    const spec = {
      name: 'macvibes-test',
      snapshot: 'macvibes-tpl-pwa',
      workdir: '/work',
      cpus: 2,
      memoryMib: 1024,
      previewHostPort: 43210,
      previewGuestPort: 5173,
      mounts: [
        { host: tmpdir(), guest: '/work' },
        { host: tmpdir(), guest: '/etc/macvibes', readonly: true },
      ],
      command: ['/bin/sh', '-c', 'echo hallo'],
    };

    test('sperrt Egress per Default und erlaubt nur öffentlich + Host-Gateway', async () => {
      const cfg = JSON.parse(JSON.stringify(await buildSandboxConfig(spec)));
      const policy = cfg.network.policy;
      expect(policy.defaultEgress).toBe('deny');
      expect(policy.defaultIngress).toBe('allow');
      expect(policy.rules).toHaveLength(3);
      // DNS zum Host — fehlte in der alten CLI-Regel, wodurch Namensauflösung in
      // Projekt-VMs unmöglich war (nachgemessen). Öffnet nur Port 53, kein LAN.
      expect(policy.rules[0].destination).toEqual({ group: 'host' });
      expect(policy.rules[0].ports).toEqual([{ start: 53, end: 53 }]);
      expect(policy.rules[0].action).toBe('allow');
      expect(policy.rules[1].destination).toEqual({ group: 'public' });
      expect(policy.rules[1].action).toBe('allow');
      expect(policy.rules[2].destination).toEqual({ cidr: '172.16.0.0/12' });
      expect(policy.rules[2].action).toBe('allow');
    });

    test('bindet den Preview-Port ausschließlich ans Loopback (H1)', async () => {
      const cfg = JSON.parse(JSON.stringify(await buildSandboxConfig(spec)));
      // Der Port MUSS im selben network()-Aufruf gesetzt werden wie die Policy —
      // sonst ersetzt der spätere Aufruf die Netzkonfiguration und die Bindung
      // verschwindet stillschweigend (ports: []), die Preview wäre tot.
      const ports = cfg.network.ports;
      expect(ports).toHaveLength(1);
      expect(ports[0].hostBind).toBe('127.0.0.1');
      expect(ports[0].hostPort).toBe(43210);
      expect(ports[0].guestPort).toBe(5173);
    });

    test('übernimmt Nur-Lese-Mounts als solche', async () => {
      const cfg = JSON.parse(JSON.stringify(await buildSandboxConfig(spec)));
      const nurLesend = cfg.mounts.filter(
        (m: { options: { readonly: boolean } }) => m.options.readonly,
      );
      expect(nurLesend).toHaveLength(1);
      expect(nurLesend[0].guest).toBe('/etc/macvibes');
      expect(cfg.mounts).toHaveLength(2);
    });

    test('übernimmt Snapshot, Arbeitsverzeichnis und Ressourcen', async () => {
      const cfg = JSON.parse(JSON.stringify(await buildSandboxConfig(spec)));
      // Der Snapshot-Name steht nicht mehr im gebauten Config — er ist zum
      // Image des Snapshots aufgelöst. Dass er angewandt wurde, zeigt genau das:
      // ohne fromSnapshot hätte der Builder ein explizites Image gebraucht.
      expect(cfg.image.Oci.reference).toContain('oven/bun');
      expect(cfg.runtime.workdir).toBe('/work');
      expect(cfg.resources.cpus).toBe(2);
      expect(cfg.resources.memoryMib).toBe(1024);
      expect(cfg.init).toEqual({ cmd: '/bin/sh', args: ['-c', 'echo hallo'], env: [] });
    });
  },
);

/**
 * Regressionsschutz für die Egress-Grenze. Sie ist der Kern von Restrisiko 2
 * („die VM darf ins öffentliche Netz, LAN und Loopback des Hosts sind
 * gesperrt"): fiele sie weg, käme der untrusted Agent an den Credential-Proxy,
 * das Agent-Gateway und alles im LAN. Der Default MUSS deshalb die gehärtete
 * Policy sein, und die Ausnahme muss man ausdrücklich hinschreiben.
 */
describe.skipIf(!pwaSnapshotDa)('Egress-Grenze ist der Default', () => {
  const basis = {
    name: 'macvibes-x',
    snapshot: 'macvibes-tpl-pwa',
    workdir: '/work',
    cpus: 1,
    memoryMib: 512,
    previewHostPort: 40001,
    previewGuestPort: 5173,
    mounts: [],
    command: ['/bin/sh', '-c', 'true'],
  };

  test('ohne Angabe gilt die gehärtete Policy', async () => {
    const cfg = JSON.parse(JSON.stringify(await buildSandboxConfig(basis)));
    expect(cfg.network.policy.defaultEgress).toBe('deny');
  });

  test('unbeschränkt lässt die Host-Gateway-Regel weg', async () => {
    // Ohne eigene Policy greift der Default der Laufzeit: Egress ebenfalls
    // gesperrt, erlaubt sind DNS zum Host und das öffentliche Netz — aber NICHT
    // das Host-Gateway-Netz 172.16/12. Die Builder-VM braucht es nicht.
    const cfg = JSON.parse(
      JSON.stringify(await buildSandboxConfig({ ...basis, netzwerk: 'unbeschraenkt' })),
    );
    const ziele = cfg.network.policy.rules.map((r: { destination: unknown }) => r.destination);
    expect(ziele).not.toContainEqual({ cidr: '172.16.0.0/12' });
    expect(cfg.network.policy.defaultEgress).toBe('deny');
  });

  test('ohne Preview-Port entsteht kein Port-Mapping (Builder-VM)', async () => {
    const cfg = JSON.parse(
      JSON.stringify(await buildSandboxConfig({ ...basis, previewHostPort: 0 })),
    );
    expect(cfg.network.ports).toHaveLength(0);
  });
});

/**
 * Beendet alles, was `bun run dev` startet: Web (Vite), Server, Egress-Proxy
 * und alle laufenden macvibes-MicroVMs. Idempotent — mehrfaches Ausführen ist
 * ok. Bun-TS-Fassung von scripts/shutdown.sh (P6): Port-Prüfung per
 * TCP-Connect, PID-Suche gekapselt in lib/prozesse — die frühere harte
 * lsof-Abhängigkeit entfällt.
 */
import { portKonfiguration } from './lib/ports';
import { istPortBelegt, pidsAufPort, pidsMitKommandozeile, beende } from './lib/prozesse';

// Ports respektieren die Env-Overrides (mit denselben Defaults wie der
// Server) — gemeinsame Quelle mit dem Preflight: lib/ports.
// Das Preview-Gateway hält einen eigenen festen Port. Heute ist es derselbe
// Prozess wie der Server, es fiele also mit ihm — aber das ist eine Annahme
// über die Prozessstruktur, nicht über den Vertrag. Explizit aufführen.
const {
  web: WEB_PORT,
  server: SERVER_PORT,
  egress: EGRESS_PORT,
  gateway: GATEWAY_PORT,
} = portKonfiguration();

// ZUERST den `bun run dev`-Elternprozess beenden — sonst startet er die eben
// gekillten Kinder (Web/Server) sofort neu (Race). Nur DIESER Elternprozess
// startet Kinder neu; `bun run start` (Produktion) tut das nicht, deshalb
// genügt dort das Beenden über die Ports weiter unten.
for (const pid of await pidsMitKommandozeile(/run --filter.* dev/)) beende(pid);

// Wie lange der Server für seinen geordneten Abgang bekommt: er stoppt bei
// SIGTERM ERST alle Sandboxes samt Auto-Commit (index.ts: shutdown → stopAll →
// onBeforeStop, R9) — das dauert pro VM Sekunden. Ein zu frühes kill -9 riss
// ihn früher mitten aus dem Stoppen, und der msb-Sweep unten löst KEINEN
// Auto-Commit aus: mit laufenden VMs ging so bei jedem Shutdown der letzte
// Commit verloren.
const GRACE_SECONDS = Number(process.env['MACVIBES_SHUTDOWN_GRACE'] ?? 45);

console.log(
  `→ Beende Ports (${WEB_PORT} Web, ${SERVER_PORT} Server, ${EGRESS_PORT} Egress, ${GATEWAY_PORT} Gateway) …`,
);

async function beendePort(port: number): Promise<void> {
  const pids = await pidsAufPort(port);
  if (pids.length === 0) return;
  for (const pid of pids) beende(pid);

  // Auf den geordneten Abgang warten, statt ihn abzuschneiden.
  for (let gewartet = 0; gewartet < GRACE_SECONDS; gewartet += 1) {
    if (!(await istPortBelegt(port))) {
      console.log(`  :${port} beendet (nach ${gewartet}s)`);
      return;
    }
    await Bun.sleep(1000);
  }

  console.log(`  :${port} reagiert nach ${GRACE_SECONDS}s nicht — hart beenden (kill -9)`);
  console.log('     Achtung: ein noch laufender Auto-Commit wird dadurch abgebrochen.');
  for (const pid of await pidsAufPort(port)) beende(pid, true);
}

for (const port of [WEB_PORT, SERVER_PORT, EGRESS_PORT, GATEWAY_PORT]) {
  await beendePort(port);
}

// Sicherheitsnetz für verwaiste VMs. Im Normalfall ist hier nichts mehr zu
// tun: der Server hat seine Sandboxes beim SIGTERM oben selbst gestoppt, MIT
// Auto-Commit. Findet dieser Sweep noch etwas, ist genau das misslungen — er
// stoppt dann hart und ohne Commit. Deshalb wird es hier deutlich gemeldet,
// statt als Erfolg durchzulaufen.
//
// ACHTUNG: Dieser Teil ist NICHT auf die Ports oben eingegrenzt — er stoppt
// jede macvibes-VM auf dem Host.
console.log('→ Prüfe auf verwaiste macvibes-MicroVMs …');
if (Bun.which('msb') !== null) {
  // `--running -q` liefert nur Namen — kein Parsen von Spalten, und der
  // Exit-Code ist auswertbar. Ein FEHLGESCHLAGENES Listing sah früher exakt
  // aus wie „keine VMs" und wurde als Erfolg gemeldet, während ungeprüft VMs
  // weiterliefen.
  const listing = Bun.spawn(['msb', 'list', '--running', '-q'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [ausgabe, fehlerausgabe, exitCode] = await Promise.all([
    new Response(listing.stdout).text(),
    new Response(listing.stderr).text(),
    listing.exited,
  ]);
  if (exitCode !== 0) {
    console.error("  ✗ 'msb list' schlug fehl — verwaiste VMs konnten NICHT geprüft werden:");
    console.error(`    ${(ausgabe + fehlerausgabe).trim().split('\n').slice(0, 3).join('\n    ')}`);
    console.error('    Bitte selbst nachsehen:  msb list');
    process.exit(1);
  }
  const vms = ausgabe.split('\n').filter((zeile) => zeile.startsWith('macvibes-'));
  if (vms.length > 0) {
    console.log('  ⚠ Diese VMs liefen noch, obwohl der Server beendet ist —');
    console.log('    sie werden OHNE Auto-Commit gestoppt (uncommittete Änderungen');
    console.log('    bleiben im Workspace, landen aber nicht im Branch):');
    for (const vm of vms) {
      // Fehlschlag NICHT verschlucken: eine VM, die sich nicht stoppen lässt,
      // muss sichtbar bleiben — sonst ist „fehlt in der Liste" nicht von
      // „schon gestoppt" unterscheidbar.
      const stop = Bun.spawn(['msb', 'stop', vm], { stdout: 'ignore', stderr: 'ignore' });
      if ((await stop.exited) === 0) {
        console.log(`    ${vm} gestoppt`);
      } else {
        console.log(`    ${vm}: msb stop schlug fehl — Status prüfen mit: msb list`);
      }
    }
  } else {
    console.log('  keine verwaisten VMs (der Server hat selbst aufgeräumt)');
  }
} else {
  console.log('  (msb nicht installiert — übersprungen)');
}

// Erfolg belegen statt behaupten: hängt noch etwas an einem der Ports, ist
// der nächste `bun run dev` schon am Preflight gescheitert — dann lieber hier
// ein klarer Fehler als später eine verwirrende Meldung.
const rest: number[] = [];
for (const port of [WEB_PORT, SERVER_PORT, EGRESS_PORT, GATEWAY_PORT]) {
  if (await istPortBelegt(port)) rest.push(port);
}
if (rest.length > 0) {
  console.error(`✗ Diese Ports sind weiterhin belegt: ${rest.map((p) => `:${p}`).join(' ')}`);
  for (const port of rest) {
    console.error(
      `  Wer draufsitzt:  lsof -nP -iTCP:${port} -sTCP:LISTEN  (macOS)  bzw.  netstat -ano | findstr :${port}  (Windows)`,
    );
  }
  process.exit(1);
}

console.log('✓ macvibes heruntergefahren.');

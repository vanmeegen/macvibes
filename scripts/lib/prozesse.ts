/**
 * Prozess-/Port-Helfer für die Repo-Skripte. Enthält die EINZIGE bewusste
 * Plattform-Weiche der Skripte (docs/windows-portierung-plan.md, P6): „welche PID
 * lauscht auf Port X" und „welche PIDs passen auf ein Kommandozeilen-Muster"
 * sind ohne Systemwerkzeuge nicht neutral zu beantworten. Alles andere
 * (Belegt-Probe, Kill) ist plattformneutral.
 */
import { createConnection } from 'node:net';

/** TCP-Connect-Probe auf 127.0.0.1 — ersetzt lsof für die Belegt-Frage. */
export async function istPortBelegt(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, timeout: 500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function ausgabeVon(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/** PIDs, die auf dem TCP-Port LAUSCHEN (nicht: verbunden sind). */
export async function pidsAufPort(port: number): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      // Get-NetTCPConnection statt netstat: dessen Status-Spalte ist
      // LOKALISIERT („ABHÖREN" auf Deutsch) und damit nicht parsebar.
      const out = await ausgabeVon([
        'powershell',
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`,
      ]);
      return [...new Set(out.split('\n').map((zeile) => Number(zeile.trim())))].filter(
        (pid) => Number.isFinite(pid) && pid > 0,
      );
    }
    const out = await ausgabeVon(['lsof', `-ti:${port}`, '-sTCP:LISTEN']);
    return out
      .split('\n')
      .map((zeile) => Number(zeile.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch (fehler) {
    console.warn(`PID-Suche auf Port ${port} fehlgeschlagen:`, fehler);
    return [];
  }
}

/** PIDs, deren Kommandozeile das Muster enthält (Ersatz für pkill -f). */
export async function pidsMitKommandozeile(muster: RegExp): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      // CIM statt wmic (in neuen Windows-11-Builds entfernt).
      const out = await ausgabeVon([
        'powershell',
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
      ]);
      const pids: number[] = [];
      for (const zeile of out.split('\n')) {
        const tab = zeile.indexOf('\t');
        if (tab < 1) continue;
        const pid = Number(zeile.slice(0, tab).trim());
        const cmdline = zeile.slice(tab + 1);
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && muster.test(cmdline)) {
          pids.push(pid);
        }
      }
      return pids;
    }
    const out = await ausgabeVon(['ps', '-eo', 'pid=,command=']);
    const pids: number[] = [];
    for (const zeile of out.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(zeile);
      if (match && muster.test(match[2] ?? '') && Number(match[1]) !== process.pid) {
        pids.push(Number(match[1]));
      }
    }
    return pids;
  } catch (fehler) {
    console.warn('Prozessliste nicht lesbar:', fehler);
    return [];
  }
}

/** SIGTERM (bzw. Windows-Terminate) — best effort, Fehler nur melden. */
export function beende(pid: number, hart = false): void {
  try {
    process.kill(pid, hart ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // Prozess ist schon weg — genau das wollten wir.
  }
}

/**
 * Kommando als Vordergrund-Subprozess starten und auf seinen Exit-Code warten.
 * stdio 'inherit': Ein-/Ausgabe laufen direkt über das Terminal, und Ctrl+C
 * erreicht als Konsolen-Signal die ganze Vordergrund-Gruppe (POSIX wie
 * Windows) — der Aufrufer muss nur noch den Exit-Code durchreichen.
 */
export async function starteImVordergrund(argv: string[], cwd?: string): Promise<number> {
  const proc = Bun.spawn(argv, {
    ...(cwd === undefined ? {} : { cwd }),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env as Record<string, string>,
  });
  return proc.exited;
}

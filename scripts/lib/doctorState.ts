/**
 * Zustands-Erhebung + Ausgabe für den Doctor — die EINE Quelle für `bun run
 * setup` (Schritt 1) und `macvibes doctor`. Vorher lebte das in scripts/
 * setup.ts; die Extraktion verhindert, dass CLI und Setup zwei driftende
 * Prüfungen pflegen. Hier stehen die Syscalls (Bun.which, sysctl, TCP-Probe);
 * die reine Auswertung bleibt in scripts/lib/setup.ts (doctor()).
 */
import { portKonfiguration } from './ports';
import { istPortBelegt } from './prozesse';
import type { DoctorInput, DoctorReport, DoctorStatus } from './setup';

/** Erwartete Bun-Version (CLAUDE.md: gepinnt, VM-Image + @types/bun identisch). */
export const BUN_PIN = '1.3.14';

/** Hypervisor-Check: auf macOS via sysctl kern.hv_support; sonst nicht geprüft. */
async function hypervisorVerfuegbar(): Promise<boolean | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const proc = Bun.spawn(['sysctl', '-n', 'kern.hv_support'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out === '1';
  } catch {
    return null;
  }
}

/**
 * Echte Zustände einsammeln (bun-Version, git/msb via Bun.which, Hypervisor,
 * belegte Ports) → DoctorInput für die reine doctor()-Auswertung. Die Ports
 * respektieren dieselben Env-Overrides wie Server/Preflight (lib/ports).
 */
export async function erhebeDoctorInput(): Promise<DoctorInput> {
  const ports = portKonfiguration();
  const zuPruefen = [ports.server, ports.egress, ports.web, ports.gateway];
  const belegtePorts: number[] = [];
  for (const port of zuPruefen) if (await istPortBelegt(port)) belegtePorts.push(port);

  const msbAvailable = Bun.which('msb') !== null;
  return {
    bunVersion: Bun.version,
    bunPin: BUN_PIN,
    gitAvailable: Bun.which('git') !== null,
    msbAvailable,
    // Ohne msb bootet ohnehin keine VM — der sysctl-Aufruf wäre nur Rauschen.
    hypervisorAvailable: msbAvailable ? await hypervisorVerfuegbar() : null,
    belegtePorts,
  };
}

/** Symbol pro Status — knappe, lesbare Doctor-Ausgabe. */
function symbol(status: DoctorStatus): string {
  return status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✗';
}

export function druckeDoctorReport(report: DoctorReport): void {
  console.log('\n── Doctor ─────────────────────────────────────────────');
  for (const check of report.checks) {
    const zeile = `${symbol(check.status)} ${check.label}`;
    console.log(check.hinweis ? `${zeile}: ${check.hinweis}` : zeile);
  }
  console.log('───────────────────────────────────────────────────────\n');
}

/**
 * Reine Auswertung des Doctors (`macvibes doctor`, Schritt 1 von `bun run
 * setup`): injizierte Prüf-Ergebnisse → Report. Bewusst OHNE Syscalls, damit
 * sie ohne echte Umgebung getestet werden kann; die Erhebung der Zustände
 * (Bun.which, sysctl, TCP-Probe) und die Ausgabe leben in lib/doctorState.
 */

/** Injizierte Prüf-Ergebnisse für den Doctor (keine Syscalls in doctor()). */
export interface DoctorInput {
  /** Laufende Bun-Version (Bun.version) oder null, wenn bun fehlt. */
  bunVersion: string | null;
  /** Erwarteter Pin (CLAUDE.md: 1.3.14). */
  bunPin: string;
  gitAvailable: boolean;
  msbAvailable: boolean;
  /**
   * Ist ein Hypervisor (HVF auf Apple Silicon) nutzbar? null = nicht geprüft.
   * Nur relevant, wenn msb da ist — ohne msb bootet ohnehin keine VM.
   */
  hypervisorAvailable: boolean | null;
  /** Belegte der geprüften Ports (Server/Egress/Web/Gateway). */
  belegtePorts: number[];
}

export type DoctorStatus = 'ok' | 'warn' | 'fail';

interface DoctorCheck {
  id: 'bun' | 'git' | 'msb' | 'hypervisor' | 'ports';
  label: string;
  status: DoctorStatus;
  /** Umsetzbarer Hinweis (was tun?) — bei 'ok' knapp/leer. */
  hinweis: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** Mindestens ein 'fail' — das Setup darf nicht weiterlaufen. */
  hatFehler: boolean;
  /** Mindestens ein 'warn' — Setup läuft weiter, aber mit Hinweisen. */
  hatWarnung: boolean;
}

/**
 * Reine Auswertung der Doctor-Eingaben. Leitregel (docs/installer-plan.md): nur
 * echte Blocker sind `fail` (ohne bun/git geht gar nichts). Fehlendes msb/
 * Hypervisor ist `warn`, weil der Prozess-Fallback existiert — das Setup soll
 * niemanden aussperren.
 */
export function doctor(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];

  // bun
  if (input.bunVersion === null) {
    checks.push({
      id: 'bun',
      label: 'Bun-Laufzeit',
      status: 'fail',
      hinweis: `bun nicht gefunden — installieren und auf ${input.bunPin} pinnen (mac: brew install oven-sh/bun/bun && brew pin bun).`,
    });
  } else if (input.bunVersion !== input.bunPin) {
    checks.push({
      id: 'bun',
      label: 'Bun-Laufzeit',
      status: 'warn',
      hinweis: `Bun ${input.bunVersion} weicht vom Pin ${input.bunPin} ab — macvibes ist auf ${input.bunPin} getestet (Sandbox-/Agent-Pfade). Nur bewusst upgraden.`,
    });
  } else {
    checks.push({ id: 'bun', label: 'Bun-Laufzeit', status: 'ok', hinweis: input.bunVersion });
  }

  // git
  checks.push(
    input.gitAvailable
      ? { id: 'git', label: 'git', status: 'ok', hinweis: '' }
      : {
          id: 'git',
          label: 'git',
          status: 'fail',
          hinweis:
            'git fehlt — für die Projekt-Branches im Bare-Repo nötig (mac: brew install git).',
        },
  );

  // msb (microsandbox)
  checks.push(
    input.msbAvailable
      ? { id: 'msb', label: 'microsandbox (msb)', status: 'ok', hinweis: '' }
      : {
          id: 'msb',
          label: 'microsandbox (msb)',
          status: 'warn',
          hinweis:
            'msb fehlt — Setup nutzt den Prozess-Modus (ohne VM-Isolat, nur Dev). Voller VM-Modus: brew install superradcompany/tap/microsandbox, dann bun run baselines.',
        },
  );

  // Hypervisor — nur relevant, wenn msb da ist.
  if (!input.msbAvailable) {
    checks.push({
      id: 'hypervisor',
      label: 'Hypervisor (HVF)',
      status: 'ok',
      hinweis: 'übersprungen (kein msb — es bootet ohnehin keine VM).',
    });
  } else if (input.hypervisorAvailable === true) {
    checks.push({ id: 'hypervisor', label: 'Hypervisor (HVF)', status: 'ok', hinweis: '' });
  } else {
    checks.push({
      id: 'hypervisor',
      label: 'Hypervisor (HVF)',
      status: 'warn',
      hinweis:
        input.hypervisorAvailable === false
          ? 'Kein Hypervisor (HVF) verfügbar — MicroVMs können nicht booten; es greift der Prozess-Fallback.'
          : 'Hypervisor-Status unbekannt — falls MicroVMs nicht booten, hilft der Prozess-Modus (MACVIBES_SANDBOX=process).',
    });
  }

  // Ports
  checks.push(
    input.belegtePorts.length === 0
      ? { id: 'ports', label: 'Ports frei', status: 'ok', hinweis: '' }
      : {
          id: 'ports',
          label: 'Ports frei',
          status: 'warn',
          hinweis: `Belegt: ${input.belegtePorts.map((p) => `:${p}`).join(' ')} — läuft macvibes schon? Erst: bun run shutdown. Ports (${input.belegtePorts.join(', ')}) freimachen.`,
        },
  );

  return {
    checks,
    hatFehler: checks.some((c) => c.status === 'fail'),
    hatWarnung: checks.some((c) => c.status === 'warn'),
  };
}

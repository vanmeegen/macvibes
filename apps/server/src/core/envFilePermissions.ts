import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { supportsPosixModes } from './fsCapabilities';

/**
 * Meldet eine group/other-lesbare .env — dort steht der Claude-Token im
 * Klartext (F26). Nicht automatisch korrigieren (es ist eine Nutzerdatei),
 * aber unübersehbar melden.
 */
export function warnIfEnvFileReadable(
  envPath: string,
  warn: (message: string) => void = console.warn,
): void {
  if (!existsSync(envPath)) return;
  try {
    // Feature-Detection (P5): ohne durchsetzbare POSIX-Modes wäre der
    // Mode-Check immer „lesbar" und der chmod-Rat sinnlos — stattdessen
    // EINE ehrliche Warnung über die dokumentierte Abschwächung.
    if (!supportsPosixModes(dirname(envPath))) {
      warn(
        `WARNUNG: Das Dateisystem von ${envPath} setzt keine POSIX-Dateirechte ` +
          `durch — die Datei (enthält den Claude-Token) ist für andere lokale ` +
          `Konten dieses Rechners lesbar (F26 abgeschwächt).`,
      );
      return;
    }
    if ((statSync(envPath).mode & 0o077) !== 0) {
      warn(
        `WARNUNG: ${envPath} ist auch für andere lokale Konten lesbar und enthält ` +
          `den Claude-Token. Bitte "chmod 600 ${envPath}" ausführen.`,
      );
    }
  } catch (error) {
    // Kein Grund, den Start zu stören — aber auch nicht verschweigen.
    warn(`Dateirechte von ${envPath} nicht ermittelbar: ${String(error)}`);
  }
}

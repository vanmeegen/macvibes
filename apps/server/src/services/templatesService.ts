import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { templatesFileSchema, type TemplateEntry } from '@macvibes/shared';

export interface TemplatesLogger {
  warn(message: string): void;
}

/**
 * Liest templates.json bei jedem Aufruf frisch (dynamisch, R3) und liefert
 * nur Einträge, deren Ordner tatsächlich existiert. Inkonsistenzen werden
 * als Warnung geloggt, niemals verschluckt.
 */
export async function loadTemplates(
  templatesDir: string,
  logger: TemplatesLogger = console,
): Promise<TemplateEntry[]> {
  const manifestPath = join(templatesDir, 'templates.json');
  const manifestFile = Bun.file(manifestPath);
  if (!(await manifestFile.exists())) {
    logger.warn(`templates.json fehlt unter ${manifestPath} — keine Templates verfügbar`);
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await manifestFile.text());
  } catch (error) {
    logger.warn(`templates.json ist kein gültiges JSON: ${String(error)}`);
    return [];
  }

  const parsed = templatesFileSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(`templates.json entspricht nicht dem Schema: ${parsed.error.message}`);
    return [];
  }

  const valid: TemplateEntry[] = [];
  for (const entry of parsed.data.templates) {
    const dirPath = join(templatesDir, entry.dir);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      logger.warn(`Template "${entry.name}": Ordner ${dirPath} fehlt — wird nicht angeboten`);
      continue;
    }
    valid.push(entry);
  }

  const knownDirs = new Set(parsed.data.templates.map((t) => t.dir));
  for (const dirent of readdirSync(templatesDir, { withFileTypes: true })) {
    if (dirent.isDirectory() && !knownDirs.has(dirent.name)) {
      logger.warn(`Template-Ordner "${dirent.name}" hat keinen Eintrag in templates.json`);
    }
  }

  return valid;
}

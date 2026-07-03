/**
 * Baut die Template-Baseline-Snapshots (bun install in der MicroVM, dann
 * Disk-Snapshot). Aufruf: `bun run baselines` — nach jeder Template-Änderung
 * erneut ausführen (PRD, offener Punkt „Rebuild-Strategie").
 */
import { buildTemplateBaseline } from '../src/sandbox/baselineService';
import { msbAvailable } from '../src/sandbox/msb';
import { loadConfig } from '../src/config';
import { loadTemplates } from '../src/services/templatesService';

const config = loadConfig();

if (!(await msbAvailable())) {
  console.error('msb ist nicht installiert — Baselines brauchen microsandbox.');
  process.exit(1);
}

const templates = await loadTemplates(config.templatesDir);
if (templates.length === 0) {
  console.error(`Keine Templates unter ${config.templatesDir} gefunden.`);
  process.exit(1);
}

for (const template of templates) {
  console.log(`Baue Baseline für "${template.dir}" (${config.sandbox.image}) …`);
  const start = Date.now();
  await buildTemplateBaseline({
    templatesDir: config.templatesDir,
    templateDir: template.dir,
    image: config.sandbox.image,
  });
  console.log(`✓ ${template.dir} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}
console.log('Alle Baselines gebaut.');

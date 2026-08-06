/**
 * `bun run dev` — Preflight, Env-Default und der eigentliche Workspace-Start
 * in EINEM plattformneutralen Bun-Skript (P6): keine bash-Abhängigkeit, keine
 * `${VAR:-…}`-Shell-Syntax mehr in package.json.
 */
import { PORT_DEFAULTS } from './lib/ports';
import { preflight } from './preflight';

if (!(await preflight())) process.exit(1);

process.env['MACVIBES_WEB_PORT'] ??= String(PORT_DEFAULTS.web);

const kind = Bun.spawn(['bun', 'run', '--filter=*', 'dev'], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  env: process.env as Record<string, string>,
});
// Ctrl+C erreicht als Konsolen-Signal die ganze Vordergrund-Gruppe (POSIX wie
// Windows) — hier nur noch den Exit-Code durchreichen.
process.exit(await kind.exited);

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bündelt den Agent-Daemon (daemon/main.ts) zu einer einzelnen Datei, die
 * read-only in die VM gemountet wird (VM_BIN_DIR). Das Agent SDK bleibt
 * extern — es liegt (mit Linux-Binary) im Baseline-Snapshot unter
 * /opt/macvibes/node_modules und wird dort zur Laufzeit aufgelöst.
 */
export async function buildDaemonBundle(outDir: string): Promise<string> {
  const entrypoint = fileURLToPath(new URL('./daemon/main.ts', import.meta.url));
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: outDir,
    target: 'bun',
    external: ['@anthropic-ai/claude-agent-sdk'],
  });
  if (!result.success) {
    const messages = result.logs.map((log) => String(log.message)).join('; ');
    throw new Error(`Daemon-Bundle konnte nicht gebaut werden: ${messages}`);
  }
  return join(outDir, 'main.js');
}

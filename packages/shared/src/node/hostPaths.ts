import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Das macvibes-Home: `MACVIBES_HOME`, sonst `~/macvibes` (Bare-Repo, Volumes,
 * DB, Logs, nutzereigene `.env`). EINE Regel für Server, Repo-Skripte und die
 * LiteLLM-Bridge — vorher stand sie an jeder Stelle einzeln.
 */
export function macvibesHomeDir(env: Record<string, string | undefined> = process.env): string {
  return env['MACVIBES_HOME'] ?? join(homedir(), 'macvibes');
}

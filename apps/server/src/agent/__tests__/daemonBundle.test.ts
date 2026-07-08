import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { buildDaemonBundle } from '../daemonBundle';
import { createTempDir, removeDir } from '../../services/__tests__/testUtils';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

describe('buildDaemonBundle', () => {
  test('bündelt den Daemon zu einer Datei — Agent SDK bleibt externer Import', async () => {
    const outDir = await createTempDir('daemon-bundle-');
    tempDirs.push(outDir);

    const bundlePath = await buildDaemonBundle(outDir);

    expect(existsSync(bundlePath)).toBe(true);
    const content = readFileSync(bundlePath, 'utf8');
    // Daemon-Logik ist einkompiliert …
    expect(content).toContain('MACVIBES_AGENT_GATEWAY_URL');
    // … das SDK aber NICHT (liegt im Baseline-Snapshot der VM).
    expect(content).toContain('@anthropic-ai/claude-agent-sdk');
    expect(content).not.toContain('claude-agent-sdk-darwin');
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { msbAvailable, runMsb } from '../../sandbox/msb';
import { msbExecSpawner } from '../msbExecSpawner';

const available = await msbAvailable();
const SANDBOX = 'macvibes-exec-test';

async function readAll(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe.skipIf(!available)('msbExecSpawner (B5c, echte VM-Naht)', () => {
  beforeAll(async () => {
    await runMsb([
      'run',
      '-d',
      '--no-tty',
      '--replace',
      '-q',
      '--name',
      SANDBOX,
      '-m',
      '512M',
      'oven/bun',
      '--',
      'sleep',
      'infinity',
    ]);
  }, 120_000);

  afterAll(async () => {
    try {
      await runMsb(['stop', SANDBOX]);
      await runMsb(['rm', SANDBOX]);
    } catch {
      // Aufräumen darf den Testlauf nicht scheitern lassen.
    }
  });

  test(
    'Env mit Doppelpunkt und Leerzeichen übersteht die -e-Übergabe (ANTHROPIC_CUSTOM_HEADERS)',
    async () => {
      const proc = msbExecSpawner({
        sandboxName: SANDBOX,
        args: ['sh', '-c', 'printenv ANTHROPIC_CUSTOM_HEADERS && printenv ANTHROPIC_BASE_URL'],
        env: {
          ANTHROPIC_CUSTOM_HEADERS: 'x-macvibes-proxy-token: geheim mit leerzeichen-123',
          ANTHROPIC_BASE_URL: 'http://host.microsandbox.internal:4000/anthropic',
        },
        cwd: '/',
      });
      const stdout = await readAll(proc.stdout);
      expect(await proc.exited).toBe(0);
      expect(stdout).toContain('x-macvibes-proxy-token: geheim mit leerzeichen-123');
      expect(stdout).toContain('http://host.microsandbox.internal:4000/anthropic');
    },
    { timeout: 60_000 },
  );

  test(
    'tötet verwaiste claude-Prozesse vor dem Start (msb-Stream-Crossing-Schutz)',
    async () => {
      // Fake-"claude" (langlebig) im Gast starten — simuliert den Orphan eines
      // abgebrochenen Turns, der weiterläuft und exec-Streams durcheinanderbringt.
      await runMsb([
        'exec',
        SANDBOX,
        '--',
        'sh',
        '-c',
        'cp /bin/sleep /tmp/claude && (/tmp/claude 300 >/dev/null 2>&1 &) && echo orphan-da',
      ]);

      const proc = msbExecSpawner({
        sandboxName: SANDBOX,
        args: ['sh', '-c', 'echo neu-gestartet'],
        env: {},
        cwd: '/',
      });
      expect(await readAll(proc.stdout)).toContain('neu-gestartet');
      expect(await proc.exited).toBe(0);

      // Der Orphan muss weg sein.
      const check = await runMsb([
        'exec',
        SANDBOX,
        '--',
        'sh',
        '-c',
        'n=0; for d in /proc/[0-9]*; do case "$(readlink "$d/exe" 2>/dev/null)" in *claude*) n=$((n+1));; esac; done; echo "orphans=$n"',
      ]);
      expect(check).toContain('orphans=0');
    },
    { timeout: 60_000 },
  );

  test(
    'stdout wird als Stream durchgereicht, stderr getrennt erfasst, Exit-Code stimmt',
    async () => {
      const proc = msbExecSpawner({
        sandboxName: SANDBOX,
        args: ['sh', '-c', 'echo zeile-eins; echo fehler-detail >&2; exit 7'],
        env: {},
        cwd: '/',
      });
      const [stdout, stderr, exit] = await Promise.all([
        readAll(proc.stdout),
        readAll(proc.stderr),
        proc.exited,
      ]);
      expect(stdout).toContain('zeile-eins');
      expect(stderr).toContain('fehler-detail');
      expect(exit).not.toBe(0);
    },
    { timeout: 60_000 },
  );
});

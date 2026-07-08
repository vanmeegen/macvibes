import { describe, expect, test } from 'bun:test';
import { MicrosandboxError, waitForExecReady } from '../msb';

describe('waitForExecReady (no-agent-endpoint-Race)', () => {
  test('kehrt sofort zurück, wenn die VM direkt exec-bereit ist', async () => {
    let calls = 0;
    await waitForExecReady('vm', {
      intervalMs: 1,
      probe: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(1);
  });

  test('wiederholt die Probe, bis die VM bereit ist (die Race-Kernlogik)', async () => {
    let calls = 0;
    await waitForExecReady('vm', {
      intervalMs: 1,
      timeoutMs: 2000,
      probe: async () => {
        calls += 1;
        if (calls < 4) throw new Error('no agent endpoint found');
      },
    });
    expect(calls).toBe(4);
  });

  test('wirft nach Timeout, wenn die VM nie bereit wird', async () => {
    await expect(
      waitForExecReady('vm', {
        intervalMs: 5,
        timeoutMs: 30,
        probe: async () => {
          throw new Error('sandbox not found');
        },
      }),
    ).rejects.toThrow(MicrosandboxError);
  });
});

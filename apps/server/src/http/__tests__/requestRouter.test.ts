import { describe, expect, test } from 'bun:test';
import { createRequestRouter } from '../requestRouter';

function setup(staticHit: Response | null = null) {
  const calls: string[] = [];
  const route = createRequestRouter<{ ip: string | null }>({
    gatewayPath: '/agent',
    upgradeGateway: () => {
      calls.push('gateway');
      return undefined;
    },
    graphql: async (_request, server) => {
      calls.push(`graphql:${server.ip}`);
      return new Response('gql');
    },
    anthropicProxy: async (_request, upstreamPath) => {
      calls.push(`anthropic:${upstreamPath}`);
      return new Response('proxy');
    },
    serveStatic: async (pathname) => {
      calls.push(`static:${pathname}`);
      return staticHit;
    },
  });
  const go = (path: string) => route(new Request(`http://host${path}`), { ip: '10.0.0.7' });
  return { calls, go };
}

/**
 * Das Routing des Haupt-Ports stand als Closure in index.ts und war damit nur
 * über einen kompletten Serverstart prüfbar.
 */
describe('createRequestRouter — Routing des Haupt-Ports', () => {
  test('Gateway-Pfad geht an das Agent-Gateway (WebSocket-Upgrade, keine Response)', async () => {
    const t = setup();
    expect(await t.go('/agent?sandbox=x&token=y')).toBeUndefined();
    expect(t.calls).toEqual(['gateway']);
  });

  test('/graphql bekommt den Server durchgereicht (Client-IP fürs Rate-Limit)', async () => {
    const t = setup();
    expect(await (await t.go('/graphql'))?.text()).toBe('gql');
    expect(t.calls).toEqual(['graphql:10.0.0.7']);
  });

  test('/anthropic/* geht an den Credential-Proxy — Präfix ab, Query bleibt', async () => {
    const t = setup();
    await t.go('/anthropic/v1/messages?beta=true');
    expect(t.calls).toEqual(['anthropic:/v1/messages?beta=true']);
  });

  test('/anthropic ohne Schrägstrich ist KEIN Proxy-Pfad', async () => {
    const t = setup();
    await t.go('/anthropicx');
    expect(t.calls).toEqual(['static:/anthropicx']);
  });

  test('alles andere liefert die Web-UI, sonst einen 404-Hinweis', async () => {
    const hit = setup(new Response('<html>'));
    expect(await (await hit.go('/projekte'))?.text()).toBe('<html>');
    const miss = setup(null);
    const response = await miss.go('/gibt-es-nicht');
    expect(response?.status).toBe(404);
    expect(await response?.text()).toContain('macvibes-Server läuft');
  });
});

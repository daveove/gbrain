/**
 * DAV-7074: every /mcp request-log row records how the request arrived
 * (`params->>'ingress'`), so an audit can count public Tailscale Funnel calls
 * separately from tailnet and local ones.
 *
 * Fails when: a log path (tools/list, tools/call success, unknown tool) drops
 * the ingress class, or the Tailscale serve headers stop deciding it.
 * The pure classification rules are pinned in test/request-ingress.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildServeHttpApp } from '../src/commands/serve-http.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

let engine: PGLiteEngine;
let server: Server;
let base: string;
let clientId: string;
let token: string;

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 500)).toBe(200);
  const data = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(data ? data.slice('data:'.length) : text) as T;
}

async function mcp(method: string, params: Record<string, unknown> | undefined, headers: Record<string, string> = {}): Promise<void> {
  await json(await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  }));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const app = express();
  const listening = Promise.withResolvers<Server>();
  const s = app.listen(0, '127.0.0.1', () => listening.resolve(s));
  server = await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  const port = address.port;
  base = `http://127.0.0.1:${port}`;
  await buildServeHttpApp(app, engine, { port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const reg = await provider.registerClientManual('ingress-client', ['client_credentials'], 'read');
  if (!reg.clientSecret) throw new Error('client_credentials registration returned no secret');
  clientId = reg.clientId;
  token = (await json<{ access_token: string }>(await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: reg.clientId, client_secret: reg.clientSecret, scope: 'read' }),
  }))).access_token;
}, 120_000);

afterAll(async () => {
  if (server) {
    const closed = Promise.withResolvers<void>();
    server.closeAllConnections();
    server.close(() => closed.resolve());
    await closed.promise;
  }
  await engine?.disconnect();
});

test('tools/list, tools/call and unknown-tool rows carry the ingress class from the Tailscale serve headers', async () => {
  // The test client connects over loopback, the same hop Tailscale serve uses.
  await mcp('tools/list', undefined);
  await mcp('tools/call', { name: 'search', arguments: { query: 'ingress', limit: 1 } }, { 'Tailscale-Funnel-Request': '?1' });
  await mcp('tools/call', { name: 'no_such_tool_dav_7074', arguments: {} }, { 'Tailscale-User-Login': 'someone@example.com' });

  const rows = await engine.executeRaw<{ operation: string; ingress: string | null; tool_count: string | null }>(
    `SELECT operation, params->>'ingress' AS ingress, params->>'tool_count' AS tool_count
       FROM mcp_request_log WHERE token_name = $1 ORDER BY id`,
    [clientId],
  );
  const byOp = new Map(rows.map(r => [r.operation, r]));
  expect(byOp.get('tools/list')?.ingress).toBe('loopback');
  // The existing tools/list params survive next to the new key.
  expect(Number(byOp.get('tools/list')?.tool_count)).toBeGreaterThan(0);
  expect(byOp.get('search')?.ingress).toBe('funnel');
  // The unknown-tool row used to carry NULL params; it now carries the ingress class alone.
  expect(byOp.get('no_such_tool_dav_7074')?.ingress).toBe('tailnet');
}, 60_000);

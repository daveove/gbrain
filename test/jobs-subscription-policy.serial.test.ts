import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { MinionWorker } from '../src/core/minions/worker.ts';
import type { MinionHandler, MinionJobContext } from '../src/core/minions/types.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PaidModelApiDisabledError } from '../src/core/ai/billing-policy.ts';
import { saveConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

test('a running worker refuses its legacy subagent API after a file-plane billing opt-out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'worker-billing-optout-'));
  const engine = new PGLiteEngine();
  let networkRequests = 0;
  const apiFixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    networkRequests++;
    return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'local fixture only' } }, { status: 401 });
  } });
  try {
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AI_BILLING: undefined,
      ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: apiFixture.url.toString(), OPENAI_API_KEY: undefined }, async () => {
      const fileConfig = { engine: 'pglite' as const, database_path: join(home, 'unused') };
      saveConfig({ ...fileConfig, ai_billing: 'api' });
      configureGateway({ ai_billing: 'api', chat_model: 'anthropic:claude-sonnet-4-6',
        env: {} });
      const handlers = new Map<string, MinionHandler>();
      const worker = { register(name: string, handler: MinionHandler) { handlers.set(name, handler); } } as unknown as MinionWorker;
      await registerBuiltinHandlers(worker, engine, { quiet: true });
      const data = { prompt: 'Return done.', model: 'anthropic:claude-sonnet-4-6', allowed_tools: [], max_turns: 1 };
      const job = await new MinionQueue(engine).add('subagent', data, {}, { allowProtectedSubmit: true });
      const ctx: MinionJobContext = { id: job.id, name: job.name, data, attempts_made: 0,
        signal: new AbortController().signal, shutdownSignal: new AbortController().signal,
        deadlineAtMs: null, async updateProgress() {}, async updateTokens() {}, async log() {},
        async isActive() { return true; }, async readInbox() { return []; } };
      // The worker and its handler were created while APIs were allowed.
      saveConfig({ ...fileConfig, ai_billing: 'subscription' });
      await expect(handlers.get('subagent')!(ctx)).rejects.toBeInstanceOf(PaidModelApiDisabledError);
      expect(networkRequests).toBe(0);
    });
  } finally {
    apiFixture.stop(true);
    resetGateway();
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

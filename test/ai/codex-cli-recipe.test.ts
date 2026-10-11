/**
 * codex-cli LanguageModelV2 against a POSIX stub at GBRAIN_CODEX_CLI_BIN.
 * The stub records argv, env and the --output-schema file, answers
 * `login status` per CODEX_STUB_LOGIN, and prints scripted `exec --json`
 * events. No Codex install, login or network is used.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { withEnv } from '../helpers/with-env.ts';
import {
  CodexCliLanguageModel,
  CodexCliProcessError,
  __resetCodexLoginCacheForTests,
  codexChildEnv,
} from '../../src/core/ai/providers/codex-cli-language-model.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

const dir = join(tmpdir(), `codex-cli-stub-${process.pid}`);
const bin = join(dir, 'codex');
const eventsPath = join(dir, 'events.jsonl');

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(bin, [
    '#!/bin/sh',
    `D="${dir}"`,
    // The provider passes the child an env allowlist, so stub modes ride in files.
    'LOGIN=$(cat "$D/stub-login" 2>/dev/null); SLEEP=$(cat "$D/stub-sleep" 2>/dev/null); CODE=$(cat "$D/stub-exit" 2>/dev/null)',
    'if [ "$1" = "login" ]; then',
    '  echo "$*" > "$D/login-argv"',
    '  case "$LOGIN" in',
    '    apikey) echo "Logged in using an API key - sk-***"; exit 0 ;;',
    '    none) echo "Not logged in" >&2; exit 1 ;;',
    '    *) echo "Logged in using ChatGPT"; exit 0 ;;',
    '  esac',
    'fi',
    'printf "%s\\n" "$@" > "$D/exec-argv"',
    'env > "$D/exec-env"',
    'cat > "$D/exec-stdin"',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--output-schema" ]; then cp "$a" "$D/exec-schema"; fi',
    '  prev="$a"',
    'done',
    'if [ -n "$SLEEP" ]; then sleep "$SLEEP"; fi',
    `cat "${eventsPath}"`,
    'exit "${CODE:-0}"',
  ].join('\n'));
  chmodSync(bin, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  __resetCodexLoginCacheForTests();
  for (const f of ['exec-argv', 'exec-env', 'exec-stdin', 'exec-schema', 'login-argv', 'stub-login', 'stub-sleep', 'stub-exit']) {
    rmSync(join(dir, f), { force: true });
  }
});

function stage(events: Array<Record<string, unknown>>): void {
  writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

const ok = (text: string) => [
  { type: 'thread.started', thread_id: 't' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
];

function call(extra: Partial<LanguageModelV2CallOptions> = {}): LanguageModelV2CallOptions {
  return {
    prompt: [
      { role: 'system', content: 'Extract facts.' },
      { role: 'user', content: [{ type: 'text', text: 'Alice joined Acme.' }] },
    ],
    ...extra,
  } as LanguageModelV2CallOptions;
}

/** Real env for the provider; CODEX_STUB_LOGIN/SLEEP/EXIT become stub mode files. */
function stubEnv(env: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const rest: Record<string, string | undefined> = { GBRAIN_CODEX_CLI_BIN: bin };
  for (const [k, v] of Object.entries(env)) {
    const mode = k.match(/^CODEX_STUB_(LOGIN|SLEEP|EXIT)$/)?.[1];
    if (mode && v !== undefined) writeFileSync(join(dir, `stub-${mode.toLowerCase()}`), v);
    else rest[k] = v;
  }
  return rest;
}

describe('codex-cli recipe', () => {
  test('declares text touchpoints only, structured output, no tools', () => {
    const recipe = getRecipe('codex-cli')!;
    expect(recipe.implementation).toBe('codex-cli');
    expect(recipe.auth_env?.required).toEqual([]);
    expect(recipe.touchpoints.chat!.supports_tools).toBe(false);
    expect(recipe.touchpoints.chat!.supports_structured_outputs).toBe(true);
    expect(recipe.touchpoints.chat!.models).toContain('gpt-5.6-terra');
    expect(recipe.touchpoints.expansion).toBeDefined();
    expect(recipe.touchpoints.embedding).toBeUndefined();
    expect(recipe.touchpoints.reranker).toBeUndefined();
  });
});

describe('CodexCliLanguageModel', () => {
  test('text round trip: ChatGPT-only flags, isolation flags, system as developer instructions, usage', async () => {
    stage(ok('hello'));
    await withEnv(stubEnv(), async () => {
      const r = await new CodexCliLanguageModel('codex-cli:gpt-5.6-terra').doGenerate(call());
      expect(r.content).toEqual([{ type: 'text', text: 'hello' }]);
      expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 7, totalTokens: 107, cachedInputTokens: 40 });
    });
    const argv = readFileSync(join(dir, 'exec-argv'), 'utf8').split('\n');
    for (const flag of ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', 'forced_login_method="chatgpt"',
      'model_provider="openai"', 'web_search="disabled"', 'shell_tool', 'unified_exec', '-']) {
      expect(argv).toContain(flag);
    }
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5.6-terra');
    expect(argv).not.toContain('--output-schema');
    expect(readFileSync(join(dir, 'login-argv'), 'utf8')).toContain('forced_login_method="chatgpt"');
    // Role boundary: system text rides in developer_instructions; stdin is the user turn only.
    const instructions = argv.find(a => a.startsWith('developer_instructions='))!;
    expect(JSON.parse(instructions.slice('developer_instructions='.length))).toContain('Extract facts.');
    expect(readFileSync(join(dir, 'exec-stdin'), 'utf8')).toBe('Alice joined Acme.');
  });

  test('json responseFormat is passed as --output-schema', async () => {
    const schema = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'], additionalProperties: false };
    stage(ok('{"facts":["Alice joined Acme"]}'));
    await withEnv(stubEnv(), async () => {
      const r = await new CodexCliLanguageModel('gpt-5.6-terra').doGenerate(call({ responseFormat: { type: 'json', schema: schema as never } }));
      expect(r.content[0]).toEqual({ type: 'text', text: '{"facts":["Alice joined Acme"]}' });
    });
    expect(readFileSync(join(dir, 'exec-argv'), 'utf8').split('\n')).toContain('--output-schema');
    expect(JSON.parse(readFileSync(join(dir, 'exec-schema'), 'utf8'))).toEqual(schema);
  });

  test('the child never inherits API keys or other credentials', async () => {
    stage(ok('x'));
    await withEnv(stubEnv({ OPENAI_API_KEY: 'sk-leak', CODEX_API_KEY: 'ck-leak', OPENAI_BASE_URL: 'https://example.invalid',
      DATABASE_URL: 'postgres://u:p@h/db', ANTHROPIC_API_KEY: 'a-leak', CODEX_HOME: join(dir, 'home') }), async () => {
      await new CodexCliLanguageModel('gpt-5.6-terra').doGenerate(call());
    });
    const env = readFileSync(join(dir, 'exec-env'), 'utf8');
    for (const leaked of ['sk-leak', 'ck-leak', 'example.invalid', 'postgres://', 'a-leak']) expect(env).not.toContain(leaked);
    expect(env).toContain(`CODEX_HOME=${join(dir, 'home')}`);
    expect(Object.keys(codexChildEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', GITHUB_TOKEN: 'y' }))).toEqual(['PATH']);
  });

  for (const login of ['apikey', 'none'] as const) {
    test(`login ${login}: refused before exec, no API fallback`, async () => {
      stage(ok('never'));
      await withEnv(stubEnv({ CODEX_STUB_LOGIN: login, OPENAI_API_KEY: 'sk-present' }), async () => {
        const err = await new CodexCliLanguageModel('gpt-5.6-terra').doGenerate(call()).catch(e => e);
        expect(err).toBeInstanceOf(AIConfigError);
        expect(String(err.message)).toContain('ChatGPT login');
      });
      expect(existsSync(join(dir, 'exec-argv'))).toBe(false);
    });
  }

  test('turn.failed usage limit surfaces a typed 429', async () => {
    stage([{ type: 'turn.started' }, { type: 'turn.failed', error: { message: "You've hit your usage limit." } }]);
    await withEnv(stubEnv({ CODEX_STUB_EXIT: '1' }), async () => {
      const err = await new CodexCliLanguageModel('gpt-5.6-terra').doGenerate(call()).catch(e => e);
      expect(err).toBeInstanceOf(CodexCliProcessError);
      expect(err.apiErrorStatus).toBe(429);
    });
  });

  test('a run with no agent message is an error, never an empty answer', async () => {
    stage([{ type: 'turn.started' }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 0 } }]);
    await withEnv(stubEnv(), async () => {
      await expect(new CodexCliLanguageModel('gpt-5.6-terra').doGenerate(call())).rejects.toBeInstanceOf(CodexCliProcessError);
    });
  });

  test('abort kills the running child and rejects with the abort reason', async () => {
    stage(ok('late'));
    await withEnv(stubEnv({ CODEX_STUB_SLEEP: '30' }), async () => {
      const controller = new AbortController();
      // Abort once the stub has started `exec` (it writes exec-argv first).
      const watcher = watch(dir, (_event, name) => { if (name === 'exec-argv') controller.abort(); });
      try {
        const started = Date.now();
        const err = await new CodexCliLanguageModel('gpt-5.6-terra').doGenerate(call({ abortSignal: controller.signal })).catch(e => e);
        expect((err as Error).name).toBe('AbortError');
        expect(Date.now() - started).toBeLessThan(20_000);
      } finally {
        watcher.close();
      }
    });
  });

  test('tools and image parts are refused before any subprocess', async () => {
    await withEnv(stubEnv(), async () => {
      const model = new CodexCliLanguageModel('gpt-5.6-terra');
      await expect(model.doGenerate(call({ tools: [{ type: 'function', name: 't', inputSchema: { type: 'object' } }] as never })))
        .rejects.toBeInstanceOf(AIConfigError);
      await expect(model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: 'AA==' }] }] } as never))
        .rejects.toBeInstanceOf(AIConfigError);
    });
    expect(existsSync(join(dir, 'login-argv'))).toBe(false);
  });
});

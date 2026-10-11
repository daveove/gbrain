/**
 * ai-sdk LanguageModelV2 that runs one `codex exec` subprocess per call,
 * billed to the user's ChatGPT subscription. Used by the `codex-cli` recipe.
 *
 * Subscription-only, by construction:
 *   - The child env is an allowlist (path, home, locale, temp, terminal,
 *     proxy/CA settings, CODEX_HOME). No OPENAI_* / CODEX_API_KEY / other
 *     credential variable can reach it, so nothing inherited can switch the
 *     CLI to API billing.
 *   - `-c forced_login_method="chatgpt"` makes the CLI refuse API-key auth,
 *     and `--ignore-user-config` + `-c model_provider="openai"` ignore any
 *     user-configured provider (a custom `model_provider` could carry an
 *     `env_key`).
 *   - `codex login status` must report a ChatGPT login before the first call
 *     (re-checked every 10 minutes). Anything else is an AIConfigError with
 *     the fix; there is no fallback to the `openai` API recipe.
 *
 * Raw-model isolation: `--sandbox read-only`, `--ephemeral` (no session
 * files, so transcript discovery never re-ingests these calls), no rules,
 * no web search, and the shell/exec/apps/plugins/browser/image/hook tools
 * disabled, run from an empty per-call scratch dir. System messages become
 * `-c developer_instructions=...`; stdin carries only the user turn(s).
 *
 * Structured output: an ai-sdk `responseFormat: {type:'json', schema}` is
 * written to a file and passed as `--output-schema` (OpenAI strict schema).
 * `maxOutputTokens` / `temperature` are not settable through `codex exec`
 * and are ignored. Tools, file/image parts and streaming are refused.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2Message,
  LanguageModelV2Prompt,
} from '@ai-sdk/provider';
import { AIConfigError } from '../errors.ts';

const LOGIN_RECHECK_MS = 10 * 60_000;

/** Tool surfaces a raw text call must never reach (codex 0.162 feature names). */
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'image_generation',
  'browser_use', 'computer_use', 'hooks', 'view_image', 'goals',
];

/** Non-credential variables the CLI needs; everything else is dropped. */
const CHILD_ENV_ALLOW: Record<string, true> = {
  PATH: true, HOME: true, USER: true, LOGNAME: true, SHELL: true, TMPDIR: true, TERM: true, LANG: true,
  CODEX_HOME: true, SSL_CERT_FILE: true, SSL_CERT_DIR: true, NODE_EXTRA_CA_CERTS: true,
  HTTPS_PROXY: true, HTTP_PROXY: true, NO_PROXY: true, https_proxy: true, http_proxy: true, no_proxy: true,
};

/**
 * Typed failure for a `codex exec` run. `apiErrorStatus` (429 usage limit,
 * 401 auth) is the same field name the claude-cli provider uses, so
 * normalizeAIError and classifyGlobalLlmError branch on it without parsing.
 */
export class CodexCliProcessError extends Error {
  readonly apiErrorStatus: number | undefined;
  readonly exitCode: number | undefined;
  constructor(message: string, opts: { apiErrorStatus?: number; exitCode?: number } = {}) {
    super(message);
    this.name = 'CodexCliProcessError';
    this.apiErrorStatus = opts.apiErrorStatus;
    this.exitCode = opts.exitCode;
  }
}

/** The env the child runs with: the allowlist plus LC_* locale variables. */
export function codexChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (CHILD_ENV_ALLOW[k] || k.startsWith('LC_'))) out[k] = v;
  }
  return out;
}

interface RunResult { code: number | null; stdout: string; stderr: string }

function run(args: string[], opts: { cwd: string; stdin?: string; signal?: AbortSignal }): Promise<RunResult> {
  opts.signal?.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const child = spawn(process.env.GBRAIN_CODEX_CLI_BIN ?? 'codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd, env: codexChildEnv(),
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const onAbort = () => {
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3_000).unref?.();
    if (settled) return;
    settled = true;
    const reason = opts.signal?.reason;
    reject(reason instanceof Error ? reason : new DOMException('codex-cli adapter aborted', 'AbortError'));
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  child.on('error', err => {
    opts.signal?.removeEventListener('abort', onAbort);
    if (settled) return;
    settled = true;
    reject(new AIConfigError(
      `codex-cli spawn failed: ${err.message}`,
      'Install the Codex CLI or set GBRAIN_CODEX_CLI_BIN to its path.',
    ));
  });
  child.on('close', code => {
    opts.signal?.removeEventListener('abort', onAbort);
    if (settled) return;
    settled = true;
    resolve({ code, stdout, stderr });
  });
  // EPIPE from a child that died before reading stdin surfaces via 'close'.
  child.stdin.on('error', () => {});
  child.stdin.end(opts.stdin ?? '');
  return promise;
}

let _loginVerifiedAt = 0;
let _loginVerifiedBin: string | undefined;

/** @internal test seam: forget the cached login check. */
export function __resetCodexLoginCacheForTests(): void {
  _loginVerifiedAt = 0;
  _loginVerifiedBin = undefined;
}

/** One cached `codex login status` check; exported for callers that must refuse before claiming work. */
export async function assertCodexChatGptLogin(cwd: string = tmpdir(), signal?: AbortSignal): Promise<void> {
  const bin = process.env.GBRAIN_CODEX_CLI_BIN ?? 'codex';
  if (_loginVerifiedBin === bin && Date.now() - _loginVerifiedAt < LOGIN_RECHECK_MS) return;
  const status = await run(['login', 'status', '-c', 'forced_login_method="chatgpt"'], { cwd, signal });
  if (status.code !== 0 || !/logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr}`)) {
    throw new AIConfigError(
      'codex-cli requires a ChatGPT login; `codex login status` did not report one (API-key auth is refused).',
      'Run `codex login` and sign in with the ChatGPT account. Do not use `codex login --with-api-key`.',
    );
  }
  _loginVerifiedAt = Date.now();
  _loginVerifiedBin = bin;
}

function textOf(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts.map(p => {
    if (p.type === 'text') return p.text ?? '';
    if (p.type === 'reasoning') return ''; // dropped on replay, like the claude-cli adapter
    throw new AIConfigError(`codex-cli accepts text only; a ${p.type} part cannot be sent.`);
  }).filter(Boolean).join('\n');
}

const RAW_MODEL_POLICY =
  'You are a plain text-generation backend. Do not run commands, read or write files, browse, or call tools. ' +
  'Answer only from the user turn.';

/**
 * Role boundary: system text becomes the CLI's developer instructions
 * (`-c developer_instructions=...`), never part of the user turn, so page
 * text in a user message cannot pose as policy. stdin carries the turns only.
 */
export function renderCodexPrompt(prompt: LanguageModelV2Prompt): { instructions: string; input: string } {
  const system: string[] = [RAW_MODEL_POLICY];
  const turns: string[] = [];
  for (const msg of prompt as ReadonlyArray<LanguageModelV2Message>) {
    if (msg.role === 'system') system.push(msg.content);
    else if (msg.role === 'user') turns.push(`User: ${textOf(msg.content)}`);
    else if (msg.role === 'assistant') turns.push(`Assistant: ${textOf(msg.content)}`);
    else throw new AIConfigError('codex-cli has no tool round-trip; a tool message cannot be sent.');
  }
  // A single user turn goes verbatim; a multi-turn history keeps its role labels.
  const only = turns.length === 1 && turns[0].startsWith('User: ') ? turns[0].slice('User: '.length) : null;
  return { instructions: system.join('\n\n'), input: only ?? turns.join('\n\n') };
}

interface CodexEvent {
  type?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

function statusFor(message: string): number | undefined {
  if (/usage limit|rate.?limit|too many requests|\b429\b/i.test(message)) return 429;
  if (/unauthori[sz]ed|\b401\b|not logged in|login required|token (has )?expired/i.test(message)) return 401;
  return undefined;
}

function normalizeModel(model: string): string {
  const idx = model.indexOf(':');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

export class CodexCliLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'codex-cli';
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(modelId: string) {
    this.modelId = normalizeModel(modelId);
  }

  async doGenerate(options: LanguageModelV2CallOptions): Promise<{
    content: LanguageModelV2Content[];
    finishReason: 'stop';
    usage: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined; cachedInputTokens: number | undefined };
    warnings: never[];
  }> {
    if (options.tools && options.tools.length > 0) {
      throw new AIConfigError('codex-cli has no tool round-trip; use a tool-capable model for tool loops.');
    }
    const { instructions, input } = renderCodexPrompt(options.prompt);
    options.abortSignal?.throwIfAborted();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-cli-'));
    try {
      await assertCodexChatGptLogin(dir, options.abortSignal);
      const schema = options.responseFormat?.type === 'json' ? options.responseFormat.schema : undefined;
      const schemaPath = join(dir, 'schema.json');
      if (schema) writeFileSync(schemaPath, JSON.stringify(schema));
      const args = [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--color', 'never', '-C', dir, '-m', this.modelId,
        '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'web_search="disabled"',
        // JSON string literals are valid TOML basic strings.
        '-c', `developer_instructions=${JSON.stringify(instructions)}`,
        ...DISABLED_FEATURES.flatMap(f => ['--disable', f]),
        ...(schema ? ['--output-schema', schemaPath] : []),
        '-',
      ];
      const result = await run(args, { cwd: dir, stdin: input, signal: options.abortSignal });
      const events: CodexEvent[] = [];
      for (const line of result.stdout.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line) as CodexEvent); } catch { /* non-JSON progress line */ }
      }
      // `error` events can be transient reconnect notices before a turn that
      // still completes; only a failed turn, a bad exit or no answer fails.
      const failure = events.filter(e => e.type === 'turn.failed' || e.type === 'error')
        .map(e => e.message ?? e.error?.message).filter((m): m is string => !!m).pop();
      const turnFailed = events.some(e => e.type === 'turn.failed');
      const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
      const text = messages.at(-1)?.item?.text;
      if (result.code !== 0 || turnFailed || text === undefined) {
        const detail = failure ?? (result.stderr.trim() || 'no agent message');
        // Raw CLI text goes after the marker: classifyGlobalLlmError's phrase
        // regexes only scan the text before it (see claude-cli provider).
        throw new CodexCliProcessError(
          `codex-cli exited ${result.code}${failure ? `: ${failure}` : ''}\n--- raw ---\n${detail.slice(0, 2000)}`,
          { apiErrorStatus: statusFor(detail), exitCode: result.code ?? undefined },
        );
      }
      const usage = events.filter(e => e.type === 'turn.completed').at(-1)?.usage;
      const inputTokens = usage?.input_tokens;
      const outputTokens = usage?.output_tokens;
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined,
          cachedInputTokens: usage?.cached_input_tokens,
        },
        warnings: [],
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async doStream(): Promise<never> {
    throw new Error('codex-cli LanguageModel does not support streaming; gateway chat() is non-streaming.');
  }
}

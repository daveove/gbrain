import type { Recipe } from '../types.ts';

/**
 * OpenAI models through the local `codex` CLI, billed to the user's ChatGPT
 * subscription (`codex login`), never to an API key. The gateway dispatches
 * each call as one `codex exec` subprocess (providers/codex-cli-language-model.ts):
 * API keys are stripped from the child env, `forced_login_method="chatgpt"`
 * refuses API-key auth, and a ChatGPT login is verified before the first
 * call. There is no fallback to the `openai` recipe.
 *
 * Text only. Chat and expansion are declared; structured replies use
 * `codex exec --output-schema`. No tools (gbrain's tool loop cannot round-trip
 * through `codex exec`), no embedding, no rerank: a ChatGPT subscription is
 * not an embedding, speech, image or rerank API entitlement.
 *
 * Model ids are the ChatGPT-login catalog the installed CLI serves
 * (~/.codex/models_cache.json on 2026-10-11). An unlisted id is passed
 * through and fails at the CLI if the subscription does not serve it.
 */
export const codexCli: Recipe = {
  id: 'codex-cli',
  name: 'OpenAI (via Codex CLI, ChatGPT subscription)',
  tier: 'native',
  implementation: 'codex-cli',
  // The CLI owns auth (ChatGPT login); the gateway forwards no key.
  auth_env: {
    required: [],
  },
  touchpoints: {
    expansion: {
      // Cheap model first: init / `providers explain` advertise models[0].
      models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.5'],
      // Subscription-billed: no per-token API charge.
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-10-11',
      // One Codex CLI process per call; allow for subscription startup.
      default_timeout_ms: 60_000,
    },
    chat: {
      models: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.5'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_structured_outputs: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-10-11',
      default_timeout_ms: 60_000,
    },
  },
  setup_hint:
    'Install the Codex CLI and run `codex login` with your ChatGPT account (not an API key). ' +
    'Set GBRAIN_CODEX_CLI_BIN if the binary is not on PATH.',
};

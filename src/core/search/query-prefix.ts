/**
 * #5691 / #3783: the opt-in query instruction for instruction-style embedding
 * models. `embedding_query_prefix` lives in the brain's database config
 * (`gbrain config set embedding_query_prefix …`), so every mounted brain uses
 * its own value. Search reads it once per request and threads the exact bytes
 * to the query embedding and the query-cache key; keyword search and stored
 * document vectors never see it, and the gateway's global state is untouched.
 * There is no default: nothing is guessed from the model id at query time.
 *
 * An independent embedding column (`provenance: 'independent'` in
 * `embedding_columns`) is its own model space. Its query embedding uses the
 * column's declared model, dimensions and `queryPrefix`, never the brain-wide
 * `embedding_query_prefix`, which belongs to the primary space.
 */
import type { BrainEngine } from '../engine.ts';
import type { ResolvedColumn } from '../types.ts';

export const EMBEDDING_QUERY_PREFIX_KEY = 'embedding_query_prefix';

export async function loadEmbeddingQueryPrefix(engine: BrainEngine): Promise<string> {
  if (typeof engine.getConfig !== 'function') return '';
  try {
    return (await engine.getConfig(EMBEDDING_QUERY_PREFIX_KEY)) ?? '';
  } catch {
    return '';
  }
}

export interface QueryEmbedOptions {
  embeddingModel?: string;
  dimensions?: number;
  queryPrefix?: string;
}

/**
 * Query-embed routing for one resolved column. An independent column always
 * embeds with its own model, dimensions and prefix (the resolver requires an
 * explicit provider:model for it), whatever the live `embedding_model` and
 * `embedding_query_prefix` say. Every other column keeps the existing routing:
 * the column's model when the resolver named one (empty means the gateway
 * default), plus the brain prefix.
 */
export function queryEmbedOptionsForColumn(column: ResolvedColumn, brainQueryPrefix: string | undefined): QueryEmbedOptions | undefined {
  if (column.provenance) {
    return {
      embeddingModel: column.embeddingModel,
      dimensions: column.dimensions,
      ...(column.queryPrefix ? { queryPrefix: column.queryPrefix } : {}),
    };
  }
  if (!column.embeddingModel && !brainQueryPrefix) return undefined;
  return {
    ...(column.embeddingModel ? { embeddingModel: column.embeddingModel, dimensions: column.dimensions } : {}),
    ...(brainQueryPrefix ? { queryPrefix: brainQueryPrefix } : {}),
  };
}

/** Model families whose model cards ask for a query instruction, with the documented value. */
const QUERY_PREFIX_FAMILIES: ReadonlyArray<{ family: string; pattern: RegExp; value: string }> = [
  { family: 'Qwen3-Embedding', pattern: /qwen3[-_]?embed/,
    value: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:' },
  { family: 'e5', pattern: /(^|[/:_-])(multilingual-)?e5([-_.]|$)/, value: 'query: ' },
  { family: 'BGE', pattern: /(^|[/:_-])bge-(?!m3)/, value: 'Represent this sentence for searching relevant passages: ' },
  { family: 'nomic-embed', pattern: /nomic-embed/, value: 'search_query: ' },
];

export function suggestedQueryPrefix(embeddingModel: string): { family: string; value: string } | null {
  const id = embeddingModel.toLowerCase();
  const match = QUERY_PREFIX_FAMILIES.find(f => f.pattern.test(id));
  return match ? { family: match.family, value: match.value } : null;
}

/** A POSIX-shell argument that reproduces `value` byte for byte (ANSI-C quoting when it holds a newline). */
export function shellQuoteConfigValue(value: string): string {
  if (/[\n\r\t]/.test(value)) {
    return `$'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`;
  }
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

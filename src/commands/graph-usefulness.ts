/**
 * DAV-6220 graph usefulness subcommands.
 *
 * Bare `gbrain graph <slug>` is traverse_graph and must stay on the operation
 * dispatcher (makeContext, source scope, thin-client MCP). This module handles
 * only: measure, stats, relations, retrieval-proof, help.
 */

import type { BrainEngine } from '../core/engine.ts';
import { measureGraphUsefulness } from '../core/graph-usefulness/measure.ts';
import {
  applyRelationManifest,
  loadRelationManifestFile,
  summarizeRowStatuses,
  type ApplyRelationManifestOpts,
} from '../core/graph-usefulness/relation-manifest.ts';
import {
  loadRetrievalProofFile,
  runRetrievalProof,
  SlugOnlyProofNeedsSourceError,
} from '../core/graph-usefulness/retrieval-proof.ts';
import { InvalidGraphLimitError, parseOptionalPositiveLimit } from '../core/graph-usefulness/limit.ts';
import type { RelationApplyResult, RelationManifest, RetrievalProofResult } from '../core/graph-usefulness/types.ts';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { federatedSearchScope } from '../core/ops/context.ts';
import type { OperationContext } from '../core/ops/contract.ts';
import {
  ALL_SOURCES,
  isResolverUserError,
  localFederatedSourceIds,
  resolveSourceId,
  resolveSourceWithTier,
} from '../core/source-resolver.ts';

/** Subcommands handled here. Bare slugs stay on the traverse_graph operation. */
export const GRAPH_USEFULNESS_SUBCOMMANDS = new Set([
  'measure',
  'stats',
  'relations',
  'retrieval-proof',
  'help',
]);

const FLAGS_WITH_VALUES = new Set([
  '--source',
  '--limit',
  '--receipt-out',
  '--out',
  '--depth',
  '--link-type',
  '--direction',
  '--type',
]);

export function isGraphUsefulnessSubcommand(firstPositional: string | undefined): boolean {
  return !!firstPositional && GRAPH_USEFULNESS_SUBCOMMANDS.has(firstPositional);
}

/**
 * Tokens before the `--` option terminator. Flags after it are positionals,
 * not mutations: `relations apply m.json -- --apply --yes` does not commit.
 */
export function argsBeforeOptionTerminator(args: string[]): string[] {
  const term = args.indexOf('--');
  return term === -1 ? args : args.slice(0, term);
}

/**
 * Positional tokens, skipping values of flags in `FLAGS_WITH_VALUES`.
 * `--source wiki retrieval-proof` yields `['retrieval-proof']`, not `['wiki', ...]`.
 * `--source=wiki` keeps the value on the flag token and does not swallow the next arg.
 * Tokens after `--` are positionals even when they look like flags.
 */
export function graphPositionals(args: string[]): string[] {
  const optionArgs = argsBeforeOptionTerminator(args);
  const out: string[] = [];
  for (let i = 0; i < optionArgs.length; i++) {
    const a = optionArgs[i];
    if (!a.startsWith('--')) {
      out.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 2 ? a.slice(0, eq) : a;
    // A following option is not a value. Leave it in place so flag checks see it.
    if (FLAGS_WITH_VALUES.has(name) && eq < 0) {
      const next = optionArgs[i + 1];
      if (next !== undefined && !next.startsWith('-')) i++;
    }
  }
  const term = args.indexOf('--');
  if (term !== -1) out.push(...args.slice(term + 1));
  return out;
}

/** First positional token, skipping flags that take a value. */
export function firstGraphPositional(args: string[]): string | undefined {
  return graphPositionals(args)[0];
}

/** Usefulness subcommand name, or undefined when this invocation is bare traversal. */
export function graphUsefulnessSubcommand(args: string[]): string | undefined {
  const sub = firstGraphPositional(args);
  return isGraphUsefulnessSubcommand(sub) ? sub : undefined;
}

export class MissingGraphFlagValueError extends Error {
  constructor(name: string) {
    super(`${name} requires a value`);
    this.name = 'MissingGraphFlagValueError';
  }
}

/**
 * `--name value` and `--name=value`. Undefined when the flag is absent.
 * A present flag with no value (or an empty `--name=`) throws.
 */
function readSeparatedOrInlineFlag(args: string[], name: string): string | undefined {
  const scan = argsBeforeOptionTerminator(args);
  const prefix = `${name}=`;
  for (let i = 0; i < scan.length; i++) {
    const a = scan[i];
    if (a === name) {
      const next = scan[i + 1];
      // `--receipt-out --apply` must not take `--apply` as the path.
      if (next === undefined || next.startsWith('-')) throw new MissingGraphFlagValueError(name);
      return next;
    }
    if (a.startsWith(prefix)) {
      const value = a.slice(prefix.length);
      if (value.length === 0 || value.startsWith('-')) throw new MissingGraphFlagValueError(name);
      return value;
    }
  }
  return undefined;
}

export interface GraphUsefulnessFlagProblem {
  kind: 'unknown' | 'missing_value';
  flag: string;
}

function legalGraphUsefulnessFlags(sub: string, action: string | undefined): { legal: Set<string>; valued: Set<string> } {
  const legal = new Set<string>(['--help', '--json', '--source']);
  const valued = new Set<string>(['--source']);
  if (sub === 'measure' || sub === 'stats') return { legal, valued };
  if (sub === 'relations') {
    legal.add('--limit');
    legal.add('--receipt-out');
    valued.add('--limit');
    valued.add('--receipt-out');
    if (action === 'verify') {
      legal.add('--write-receipt');
    } else if (action === 'apply') {
      legal.add('--apply');
      legal.add('--yes');
    } else {
      legal.add('--write-receipt');
      legal.add('--apply');
      legal.add('--yes');
    }
    return { legal, valued };
  }
  if (sub === 'retrieval-proof') {
    legal.add('--limit');
    legal.add('--out');
    valued.add('--limit');
    valued.add('--out');
  }
  return { legal, valued };
}

/** True for `help` and for `--help` / `-h` before the option terminator. */
export function graphUsefulnessWantsHelp(args: string[]): boolean {
  if (graphUsefulnessSubcommand(args) === 'help') return true;
  const optionArgs = argsBeforeOptionTerminator(args);
  return optionArgs.includes('--help') || optionArgs.includes('-h');
}

export function printGraphUsefulnessHelp(): void {
  printGraphHelp();
}

/**
 * Subcommand whitelist for usefulness flags. Null when the invocation is bare
 * traversal, help, or a clean usefulness command. Unknown flags, including
 * single-dash tokens such as `-x`, and valued flags whose next token is
 * another option are reported here so dispatch can refuse before connecting.
 * The scan stops at `--`.
 */
export function findGraphUsefulnessFlagProblem(args: string[]): GraphUsefulnessFlagProblem | null {
  const sub = graphUsefulnessSubcommand(args);
  if (!sub || sub === 'help') return null;
  const optionArgs = argsBeforeOptionTerminator(args);
  if (optionArgs.includes('--help') || optionArgs.includes('-h')) return null;
  const { legal, valued } = legalGraphUsefulnessFlags(sub, graphPositionals(args)[1]);
  for (let i = 0; i < optionArgs.length; i++) {
    const a = optionArgs[i];
    if (!a.startsWith('-')) continue;
    // `-h` is help. Every other single-dash token, including `-x`, is unknown.
    if (a === '-h') continue;
    const m = /^--([a-z0-9][a-z0-9-]*)(?:=(.*))?$/i.exec(a);
    if (!m) return { kind: 'unknown', flag: a };
    if (/[A-Z]/.test(m[1])) return { kind: 'unknown', flag: `--${m[1]}` };
    const name = `--${m[1]}`;
    if (!legal.has(name)) return { kind: 'unknown', flag: name };
    if (!valued.has(name)) continue;
    const inline = m[2];
    if (inline !== undefined) {
      if (inline.length === 0 || inline.startsWith('-')) return { kind: 'missing_value', flag: name };
      continue;
    }
    const next = optionArgs[i + 1];
    if (next === undefined || next.startsWith('-')) return { kind: 'missing_value', flag: name };
    i++;
  }
  return null;
}

/** Exit before connect/apply. No-op for bare traversal and --help. */
export function rejectGraphUsefulnessFlagProblem(args: string[]): void {
  const problem = findGraphUsefulnessFlagProblem(args);
  if (!problem) return;
  if (problem.kind === 'unknown') {
    const message = `unknown flag ${problem.flag} for 'gbrain graph'`;
    const optionArgs = argsBeforeOptionTerminator(args);
    if (optionArgs.some(a => a === '--json' || (a.startsWith('--json=') && a !== '--json=false'))) {
      process.stdout.write(JSON.stringify({ status: 'error', reason: 'invalid_flag', message }) + '\n');
    }
    console.error(`gbrain graph: ${message}`);
    console.error('Run: gbrain graph --help');
    process.exit(1);
  }
  const hint = problem.flag === '--limit' ? ' (positive integer)' : '';
  console.error(`${problem.flag} requires a value${hint}`);
  setCliExitVerdict(2);
  process.exit(2);
}

function takeFlag(args: string[], name: string): string | undefined {
  try {
    return readSeparatedOrInlineFlag(args, name);
  } catch (e) {
    if (e instanceof MissingGraphFlagValueError) {
      console.error(e.message);
      setCliExitVerdict(2);
      process.exit(2);
    }
    throw e;
  }
}

function hasFlag(args: string[], name: string): boolean {
  return argsBeforeOptionTerminator(args).includes(name);
}

async function applyManifestOrRejectSource(
  engine: BrainEngine,
  manifest: RelationManifest,
  raw: string,
  opts: ApplyRelationManifestOpts,
): Promise<RelationApplyResult | undefined> {
  try {
    return await applyRelationManifest(engine, manifest, raw, opts);
  } catch (e) {
    if (isResolverUserError(e)) {
      console.error(e instanceof Error ? e.message : String(e));
      setCliExitVerdict(1);
      return undefined;
    }
    throw e;
  }
}

function parseSource(args: string[]): { sourceId?: string } {
  const sourceId = takeFlag(args, '--source');
  return sourceId ? { sourceId } : {};
}

/**
 * Explicit `--source` for measure and stats. Same resolver as relations:
 * the id must match the source-id grammar and name an active source.
 * An omitted flag stays unscoped (whole-brain measure). `__all__` is that
 * unscoped sentinel, not a SQL filter. Retrieval proofs do not use this
 * helper. Returns undefined after a user-facing resolver error (stderr +
 * exit 1) so the caller does not read.
 */
async function resolveUsefulnessReadScope(
  engine: BrainEngine,
  args: string[],
): Promise<{ sourceId?: string } | undefined> {
  const explicit = parseSource(args).sourceId ?? null;
  if (!explicit) return {};
  try {
    const resolved = await resolveSourceId(engine, explicit);
    if (resolved === ALL_SOURCES) return {};
    return { sourceId: resolved };
  } catch (e) {
    if (isResolverUserError(e)) {
      console.error(e instanceof Error ? e.message : String(e));
      setCliExitVerdict(1);
      return undefined;
    }
    throw e;
  }
}

/**
 * Source scope for a retrieval proof, the same one an unqualified local
 * `query` uses. Resolution follows `makeContext` (flag, env, dotfile, path,
 * brain default, seed). `federatedSearchScope` then widens only through
 * `localFederatedSourceIds`: a `federated: false` source stays out, so a
 * proof cannot pass on an isolated page an ordinary query never returns.
 * `__all__` stays unscoped for this trusted local caller. Returns undefined
 * after a user-facing resolver error (stderr + exit 1).
 */
async function resolveRetrievalProofScope(
  engine: BrainEngine,
  args: string[],
): Promise<{ sourceId?: string; sourceIds?: string[] } | undefined> {
  const explicit = parseSource(args).sourceId ?? null;
  try {
    const resolved = await resolveSourceWithTier(engine, explicit);
    const localFederated = resolved.source_id === ALL_SOURCES
      ? undefined
      : await localFederatedSourceIds(engine, resolved.source_id, resolved.tier);
    const ctx = {
      engine,
      remote: false,
      sourceId: resolved.source_id,
      ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
    } as OperationContext;
    return federatedSearchScope(ctx);
  } catch (e) {
    if (isResolverUserError(e)) {
      console.error(e instanceof Error ? e.message : String(e));
      setCliExitVerdict(1);
      return undefined;
    }
    throw e;
  }
}

export class MissingGraphLimitError extends Error {
  constructor() {
    super('--limit requires a value (positive integer)');
    this.name = 'MissingGraphLimitError';
  }
}

/**
 * Raw `--limit` value (`--limit N` or `--limit=N`), or undefined when omitted.
 * A present flag with no value, including empty `--limit=`, is a missing value.
 */
export function readLimitFlag(args: string[]): string | undefined {
  try {
    return readSeparatedOrInlineFlag(args, '--limit');
  } catch (e) {
    if (e instanceof MissingGraphFlagValueError) throw new MissingGraphLimitError();
    throw e;
  }
}

function parseLimitArg(args: string[]): number | undefined {
  try {
    return parseOptionalPositiveLimit(readLimitFlag(args));
  } catch (e) {
    if (e instanceof InvalidGraphLimitError || e instanceof MissingGraphLimitError) {
      console.error(e.message);
      setCliExitVerdict(2);
      process.exit(2);
    }
    throw e;
  }
}

export async function runGraphUsefulness(engine: BrainEngine, args: string[]): Promise<void> {
  if (graphUsefulnessWantsHelp(args)) {
    printGraphHelp();
    return;
  }

  // Direct callers (and the CLI, which also checks before connect) must not
  // reach apply with an unknown flag or an option token used as a value.
  rejectGraphUsefulnessFlagProblem(args);

  const sub = graphUsefulnessSubcommand(args);
  if (!sub) {
    console.error('gbrain graph: usefulness subcommand required. Bare `gbrain graph <slug>` is traverse_graph.');
    setCliExitVerdict(2);
    return;
  }

  const json = hasFlag(args, '--json');

  if (sub === 'help') {
    printGraphHelp();
    return;
  }

  if (sub === 'measure' || sub === 'stats') {
    const scope = await resolveUsefulnessReadScope(engine, args);
    if (!scope) return;
    const report = await measureGraphUsefulness(engine, scope);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log('Graph usefulness (read-only)');
    console.log(`  active_pages:      ${report.active_pages}`);
    console.log(`  link_rows:         ${report.link_rows}`);
    console.log(`  valid_links:       ${report.valid_links}`);
    console.log(`  zero_degree_pages: ${report.zero_degree_pages}`);
    console.log(`  avg_degree:        ${report.avg_degree.toFixed(2)}`);
    console.log(`  median_degree:     ${report.median_degree.toFixed(0)}`);
    if (report.junk_slug_samples.length) {
      console.log('  junk_slug_samples:');
      for (const s of report.junk_slug_samples) {
        console.log(`    - ${s.pattern}: ${s.count} (e.g. ${s.examples.join(', ')})`);
      }
    }
    console.log(`  fingerprint_sha256: ${report.fingerprint.sha256}`);
    return;
  }

  if (sub === 'relations') {
    const positionals = graphPositionals(args);
    const action = positionals[1];
    const manifestPath = positionals[2];
    // Exactly relations + action + manifest. A surplus token such as
    // `unexpected` must not be ignored while --apply --yes still commits.
    if (positionals.length !== 3 || !action || !manifestPath) {
      const extra = positionals.slice(3);
      if (extra.length > 0) {
        console.error(`Unexpected argument${extra.length === 1 ? '' : 's'}: ${extra.join(' ')}`);
      }
      console.error('Usage: gbrain graph relations verify|apply <manifest.json>');
      setCliExitVerdict(2);
      return;
    }
    const limit = parseLimitArg(args);
    // Flag, env, dotfile, registered path, and brain default. Omitted row
    // source ids must not skip this chain and land on literal `default`.
    const explicitSource = parseSource(args).sourceId ?? null;
    let defaultSourceId: string;
    try {
      defaultSourceId = await resolveSourceId(engine, explicitSource);
    } catch (e) {
      if (isResolverUserError(e)) {
        console.error(e instanceof Error ? e.message : String(e));
        setCliExitVerdict(1);
        return;
      }
      throw e;
    }
    const receiptOut = takeFlag(args, '--receipt-out')
      ?? `docs/progress/DAV-6220/mutation-receipt-${Date.now()}.json`;
    const { manifest, raw } = loadRelationManifestFile(manifestPath);

    if (action === 'verify') {
      const result = await applyManifestOrRejectSource(engine, manifest, raw, {
        apply: false,
        limit,
        defaultSourceId,
        receiptPath: hasFlag(args, '--write-receipt') ? receiptOut : undefined,
      });
      if (!result) return;
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`relations verify: ${result.rows_total} rows, ${result.ready} ready, ${result.skipped} skipped`);
      console.log(`  status: ${JSON.stringify(summarizeRowStatuses(result.outcomes))}`);
      return;
    }

    if (action === 'apply') {
      const apply = hasFlag(args, '--apply');
      const yes = hasFlag(args, '--yes');
      if (apply && !yes) {
        console.error('Refusing --apply without --yes (bounded manifest apply only).');
        setCliExitVerdict(2);
        return;
      }
      const result = await applyManifestOrRejectSource(engine, manifest, raw, {
        apply: apply && yes,
        limit,
        defaultSourceId,
        receiptPath: receiptOut,
        operator: process.env.USER ?? 'gbrain',
      });
      if (!result) return;
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `relations ${result.mode}: applied=${result.applied} skipped=${result.skipped} ` +
        `fingerprint ${result.before.sha256.slice(0, 12)}→${result.after.sha256.slice(0, 12)}`,
      );
      if (result.receipt_path) console.log(`  receipt: ${result.receipt_path}`);
      return;
    }

    console.error(`Unknown relations action: ${action}`);
    setCliExitVerdict(2);
    return;
  }

  if (sub === 'retrieval-proof') {
    const positionals = graphPositionals(args);
    const action = positionals[1];
    const proofPath = positionals[2];
    // Exactly retrieval-proof + run + proof path. A surplus token such as
    // `unexpected`, including one placed after `--`, must not be ignored
    // while --out still writes a receipt.
    if (positionals.length !== 3 || action !== 'run' || !proofPath) {
      const extra = positionals.slice(3);
      if (extra.length > 0) {
        console.error(`Unexpected argument${extra.length === 1 ? '' : 's'}: ${extra.join(' ')}`);
      }
      console.error('Usage: gbrain graph retrieval-proof run <proof.json> [--out <path>] [--json]');
      setCliExitVerdict(2);
      return;
    }
    const scope = await resolveRetrievalProofScope(engine, args);
    if (!scope) return;
    const outPath = takeFlag(args, '--out');
    if (outPath && existsSync(outPath)) {
      console.error(`Refusing to overwrite existing retrieval-proof receipt: ${outPath}`);
      setCliExitVerdict(2);
      return;
    }
    const manifest = loadRetrievalProofFile(proofPath);
    const limit = parseLimitArg(args);
    let result: RetrievalProofResult;
    try {
      result = await runRetrievalProof(engine, manifest, { ...scope, limit });
    } catch (e) {
      if (e instanceof SlugOnlyProofNeedsSourceError) {
        console.error(e.message);
        setCliExitVerdict(2);
        return;
      }
      if (isResolverUserError(e)) {
        console.error(e instanceof Error ? e.message : String(e));
        setCliExitVerdict(1);
        return;
      }
      throw e;
    }
    if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      const body = JSON.stringify(result, null, 2) + '\n';
      try {
        writeFileSync(outPath, body, { flag: 'wx' });
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
        if (code === 'EEXIST') {
          console.error(`Refusing to overwrite existing retrieval-proof receipt: ${outPath}`);
          setCliExitVerdict(2);
          return;
        }
        throw err;
      }
    }
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `retrieval-proof: questions=${result.checks.questions} ` +
        `pass=${result.checks.scores.pass} partial=${result.checks.scores.partial} fail=${result.checks.scores.fail} ` +
        `readwise_cites=${result.checks.cited_readwise_pages}`,
      );
      if (outPath) console.log(`  wrote: ${outPath}`);
    }
    // Failed question, Readwise lineage, or a changed fingerprint.
    if (!result.passed) setCliExitVerdict(1);
    return;
  }

  printGraphHelp();
}

function printGraphHelp(): void {
  console.log(`Usage: gbrain graph <slug> [traverse options]
       gbrain graph <usefulness subcommand> ...

Traverse (traverse_graph operation; source scope and thin-client routing apply):
  gbrain graph <slug> [--depth N] [--link-type T] [--direction in|out|both] [--source <id>]

DAV-6220 usefulness:
  measure [--json] [--source <id>]
      Read-only connectivity + junk-slug samples.
      An explicit --source is resolved and must name an active source.
      An omitted --source measures the whole brain.

  relations verify <manifest.json> [--json] [--limit N] [--write-receipt] [--source <id>]
      Re-check manifest guards without writing links.
      Omitted row source ids use the resolved CLI source
      (--source, GBRAIN_SOURCE, .gbrain-source, registered path, or brain default).

  relations apply <manifest.json> [--apply] [--yes] [--limit N]
      [--receipt-out <path>] [--json] [--source <id>]
      Dry-run by default. --apply --yes writes manifest rows that still pass guards.
      Omitted row source ids use the resolved CLI source
      (--source, GBRAIN_SOURCE, .gbrain-source, registered path, or brain default).
      A row that sets from_source_id or to_source_id keeps that value.
      Every row source must name an active source. Archived sources are rejected.

  retrieval-proof run <proof.json> [--out <path>] [--json] [--source <id>] [--limit N]
      Score a sealed question pack (read-only). The graph fingerprint and a
      corpus mutation watermark must both stay unchanged. A link added during
      a question and removed before the final snapshot still fails the proof.
      --out writes the full result, including fingerprint_before and fingerprint_after.
      An explicit --source is resolved and must name an active source.
      An omitted --source uses the same scope as an unqualified query:
      the resolved source, widened only to its federated set.
      A source with federated set to false stays out of that widening.
      --source __all__ spans every source, matching a trusted local query.
      Bare relevant_slugs / forbidden_slugs require a single source scope.
      relevant_pages / forbidden_pages are already (source_id, slug).
      Each question needs at least one distinct relevant slug or page.
      Every proof uses the query operation's default expansion (expandQuery),
      regardless of the pinned search mode.
      The proof verifies live retrieval under the other pinned settings.
      Exits nonzero when a question fails, a hit cites Readwise, the fingerprint
      changes, or the corpus mutation watermark changes.

Valued flags accept both --name value and --name=value
(--limit, --source, --receipt-out, --out). An empty value, or a following
token that starts with '-', is rejected before apply.
Unknown flags are rejected before connect (for example --dry-run).
Flags after -- are positional. They do not count as --apply, --yes, or --help.
relations verify and relations apply accept exactly one manifest path.
retrieval-proof run accepts exactly one proof path.
Extra positional arguments are rejected before the source is resolved
or the manifest or proof is read.
retrieval-proof --out refuses to overwrite an existing file.
`);
}

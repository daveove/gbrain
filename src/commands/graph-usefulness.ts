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
} from '../core/graph-usefulness/relation-manifest.ts';
import {
  loadRetrievalProofFile,
  runRetrievalProof,
  SlugOnlyProofNeedsSourceError,
} from '../core/graph-usefulness/retrieval-proof.ts';
import { InvalidGraphLimitError, parseOptionalPositiveLimit } from '../core/graph-usefulness/limit.ts';
import type { RetrievalProofResult } from '../core/graph-usefulness/types.ts';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

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
 * Positional tokens, skipping values of flags in `FLAGS_WITH_VALUES`.
 * `--source wiki retrieval-proof` yields `['retrieval-proof']`, not `['wiki', ...]`.
 */
export function graphPositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      out.push(a);
      continue;
    }
    if (FLAGS_WITH_VALUES.has(a)) i++;
  }
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

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseSource(args: string[]): { sourceId?: string } {
  const sourceId = takeFlag(args, '--source');
  return sourceId ? { sourceId } : {};
}

export class MissingGraphLimitError extends Error {
  constructor() {
    super('--limit requires a value (positive integer)');
    this.name = 'MissingGraphLimitError';
  }
}

/**
 * Raw `--limit` token, or undefined when the flag is omitted.
 * A present flag with no following argument is a missing value, not an omit.
 */
export function readLimitFlag(args: string[]): string | undefined {
  const i = args.indexOf('--limit');
  if (i < 0) return undefined;
  if (i + 1 >= args.length) throw new MissingGraphLimitError();
  return args[i + 1];
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
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printGraphHelp();
    return;
  }

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
    const scope = parseSource(args);
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
    if (!action || !manifestPath) {
      console.error('Usage: gbrain graph relations verify|apply <manifest.json> ...');
      setCliExitVerdict(2);
      return;
    }
    const limit = parseLimitArg(args);
    const { manifest, raw } = loadRelationManifestFile(manifestPath);
    const receiptOut = takeFlag(args, '--receipt-out')
      ?? `docs/progress/DAV-6220/mutation-receipt-${Date.now()}.json`;

    if (action === 'verify') {
      const result = await applyRelationManifest(engine, manifest, raw, {
        apply: false,
        limit,
        receiptPath: hasFlag(args, '--write-receipt') ? receiptOut : undefined,
      });
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
      const result = await applyRelationManifest(engine, manifest, raw, {
        apply: apply && yes,
        limit,
        receiptPath: receiptOut,
        operator: process.env.USER ?? 'gbrain',
      });
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
    if (action !== 'run' || !proofPath) {
      console.error('Usage: gbrain graph retrieval-proof run <proof.json> [--out <path>] [--json]');
      setCliExitVerdict(2);
      return;
    }
    const manifest = loadRetrievalProofFile(proofPath);
    const scope = parseSource(args);
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
      throw e;
    }
    const outPath = takeFlag(args, '--out');
    if (outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify({ passed: result.passed, checks: result.checks, questions: result.questions }, null, 2) + '\n');
    }
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `retrieval-proof: questions=${result.checks.questions} ` +
      `pass=${result.checks.scores.pass} partial=${result.checks.scores.partial} fail=${result.checks.scores.fail} ` +
      `readwise_cites=${result.checks.cited_readwise_pages}`,
    );
    if (outPath) console.log(`  wrote: ${outPath}`);
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

  relations verify <manifest.json> [--json] [--limit N] [--write-receipt]
      Re-check manifest guards without writing links.

  relations apply <manifest.json> [--apply] [--yes] [--limit N]
      [--receipt-out <path>] [--json]
      Dry-run by default. --apply --yes writes manifest rows that still pass guards.

  retrieval-proof run <proof.json> [--out <path>] [--json] [--source <id>] [--limit N]
      Score a sealed question pack; fingerprints must stay identical (read-only).
      Bare relevant_slugs / forbidden_slugs require a single --source.
      relevant_pages / forbidden_pages are already (source_id, slug).
`);
}

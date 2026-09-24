/**
 * gbrain graph — traverse (default) + DAV-6220 usefulness subcommands.
 *
 *   gbrain graph <slug> [--type T] ...     traverse_graph (legacy surface)
 *   gbrain graph measure [--json] [--source <id>]
 *   gbrain graph relations verify|apply <manifest.json> ...
 *   gbrain graph retrieval-proof run <proof.json> ...
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
} from '../core/graph-usefulness/retrieval-proof.ts';
import { InvalidGraphLimitError, parseOptionalPositiveLimit } from '../core/graph-usefulness/limit.ts';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

/** Subcommands handled by DAV-6220 graph usefulness; anything else delegates to traverse_graph. */
export const GRAPH_USEFULNESS_SUBCOMMANDS = new Set([
  'measure',
  'stats',
  'relations',
  'retrieval-proof',
  'help',
]);

export function isGraphUsefulnessSubcommand(firstPositional: string | undefined): boolean {
  if (!firstPositional) return true;
  return GRAPH_USEFULNESS_SUBCOMMANDS.has(firstPositional);
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) return a;
    if (a === '--source' || a === '--limit' || a === '--receipt-out' || a === '--out') i++;
  }
  return undefined;
}

function parseSource(args: string[]): { sourceId?: string } {
  const sourceId = takeFlag(args, '--source');
  return sourceId ? { sourceId } : {};
}

function parseLimitArg(args: string[]): number | undefined {
  try {
    return parseOptionalPositiveLimit(takeFlag(args, '--limit'));
  } catch (e) {
    if (e instanceof InvalidGraphLimitError) {
      console.error(e.message);
      setCliExitVerdict(2);
      process.exit(2);
    }
    throw e;
  }
}

export async function runGraphUsefulness(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = firstPositional(args);

  if (!isGraphUsefulnessSubcommand(sub)) {
    const { runGraphQuery } = await import('./graph-query.ts');
    await runGraphQuery(engine, args);
    return;
  }

  const json = hasFlag(args, '--json');

  if (!sub || sub === 'help') {
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
    const positionals = args.filter(a => !a.startsWith('--'));
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
    const positionals = args.filter(a => !a.startsWith('--'));
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
    const result = await runRetrievalProof(engine, manifest, { ...scope, limit });
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

Traverse (unchanged — same as traverse_graph op):
  gbrain graph <slug> [--type T] [--depth N] [--direction in|out|both] [--include-foreign]

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
`);
}

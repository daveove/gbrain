/**
 * gbrain graph — post-import graph usefulness (DAV-6220).
 *
 *   gbrain graph measure [--json] [--source <id>]
 *   gbrain graph relations verify <manifest.json> [--json]
 *   gbrain graph relations apply <manifest.json> [--apply] [--yes] [--limit N]
 *       [--receipt-out <path>] [--json]
 *   gbrain graph retrieval-proof run <proof.json> [--json] [--source <id>] [--limit N]
 *       [--out <path>]
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
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

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

export async function runGraphUsefulness(engine: BrainEngine, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json');
  const sub = args.find(a => !a.startsWith('--')) ?? 'help';

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
    const action = args.filter(a => !a.startsWith('--')).slice(1)[0];
    const manifestPath = args.filter(a => !a.startsWith('--')).slice(2)[0];
    if (!action || !manifestPath) {
      console.error('Usage: gbrain graph relations verify|apply <manifest.json> ...');
      process.exit(2);
    }
    const { manifest, raw } = loadRelationManifestFile(manifestPath);
    const limitRaw = takeFlag(args, '--limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
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
        process.exit(2);
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
    process.exit(2);
  }

  if (sub === 'retrieval-proof') {
    const action = args.filter(a => !a.startsWith('--')).slice(1)[0];
    const proofPath = args.filter(a => !a.startsWith('--')).slice(2)[0];
    if (action !== 'run' || !proofPath) {
      console.error('Usage: gbrain graph retrieval-proof run <proof.json> [--out <path>] [--json]');
      process.exit(2);
    }
    const manifest = loadRetrievalProofFile(proofPath);
    const scope = parseSource(args);
    const limitRaw = takeFlag(args, '--limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
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
  console.log(`Usage: gbrain graph <subcommand>

Subcommands:
  measure [--json] [--source <id>]
      Read-only connectivity + junk-slug samples (DAV-6220 baseline).

  relations verify <manifest.json> [--json] [--limit N] [--write-receipt]
      Re-check manifest guards without writing links.

  relations apply <manifest.json> [--apply] [--yes] [--limit N]
      [--receipt-out <path>] [--json]
      Dry-run by default. --apply --yes writes manifest rows that still pass guards.

  retrieval-proof run <proof.json> [--out <path>] [--json] [--source <id>] [--limit N]
      Score a sealed question pack; fingerprints must stay identical (read-only).
`);
}

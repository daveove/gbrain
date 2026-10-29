/**
 * `gbrain transcripts audit-secrets` — the read-only installed-base audit for
 * credentials in conversation pages imported before the transcript lane's
 * `labeled_credential` detector (logic in core/transcripts/secret-audit.ts).
 * Lists affected page slugs and hit counts per pattern, never a value; caches
 * the summary for the `transcript_secret_exposure` doctor check. With
 * `--scope conversations` it scans every conversation page and stores a
 * result record (ids and counts, never text) for the read-only GBrain
 * monitor (DAV-7162).
 */

import type { BrainEngine } from '../core/engine.ts';
import type { SecretAuditScope } from '../core/transcripts/secret-audit.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

export const TRANSCRIPTS_AUDIT_HELP = `Usage:
  gbrain transcripts audit-secrets [--source-id S] [--json]
  gbrain transcripts audit-secrets --scope conversations [--json]

Scans every imported conversation page (all sources, or one with
--source-id) with the transcript import's secret detectors and lists the
pages that still carry a credential: slug, source and hit count per
pattern, never the matched text. Pages imported before the
labeled-credential detector (password: …, login user / pass) are not
rewritten automatically; this finds them. Read-only: no page changes. The
summary is cached for \`gbrain doctor --only transcript_secret_exposure\`.

Next actions are separate and each is yours to choose:
  review   gbrain get <slug>
  edit     gbrain put <slug> < edited.md   (remove the credential, keep the page)
  remove   gbrain delete <slug> --purge    (ask the user first; no recovery window)
A credential that reached a page should also be rotated (SECURITY.md,
"If a secret reached the brain"): edits and deletes do not reach git history,
synced copies or exports.

Scope conversations scans every conversation page in every source,
imported or not: title, body, and frontmatter keys and string values. It
stores a result record in the config row \`conversations.secret_audit\`:
scan start and end times, pages scanned, hit counts per pattern and the
affected page ids. The record holds no slug and no matched text, so a
read-only monitor can report the result without reading conversation
pages. Schedule it at least once a day; the monitor reports an old or
missing record as unknown. The command exits 1 if the record is not saved.

  --scope S         transcripts (default: imported conversation pages,
                    title and body) or conversations (see above)
  --source-id S     Audit one source (default: every source; not with
                    --scope conversations)
  --json            Machine-readable result
`;

export async function runTranscriptsAuditSecrets(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(TRANSCRIPTS_AUDIT_HELP);
    return;
  }
  let json = false;
  let sourceId: string | undefined;
  let scope: SecretAuditScope = 'transcripts';
  const usage = async (message: string): Promise<never> => {
    const { exitCliError, usageError } = await import('../cli/cli-error.ts');
    return exitCliError(usageError(message,
      'Run `gbrain transcripts audit-secrets --json` (every source), add `--source-id <id>`, or run `--scope conversations --json` for the monitor record.'), 'transcripts', { json: args.includes('--json') });
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') { json = true; continue; }
    if (a === '--source-id' && args[i + 1] && !args[i + 1]!.startsWith('-')) { sourceId = args[++i]; continue; }
    if (a === '--scope' && (args[i + 1] === 'transcripts' || args[i + 1] === 'conversations')) { scope = args[++i] as SecretAuditScope; continue; }
    await usage(`gbrain transcripts audit-secrets does not accept ${a}; nothing was scanned.`);
  }
  if (scope === 'conversations' && sourceId) {
    await usage('gbrain transcripts audit-secrets --scope conversations covers every source and does not accept --source-id; nothing was scanned.');
  }
  const { auditTranscriptSecrets, saveTranscriptSecretAudit } = await import('../core/transcripts/secret-audit.ts');
  const result = await auditTranscriptSecrets(engine, { sourceId, scope });
  const cached = await saveTranscriptSecretAudit(engine, result);
  // The monitor reads only the stored record: an unsaved record is a failed run.
  if (!cached && scope === 'conversations') setCliExitVerdict(1);
  const slug = [{ name: 'slug', how: 'One `slug` from `pages` above.' }];
  const nextActions = result.pages_affected === 0 ? [] : [
    { action: 'review', argv: ['gbrain', 'get', '<slug>'], inputs: slug, why: 'Read the page at the listed lines to confirm each hit is a real credential.' },
    { action: 'edit', argv: ['gbrain', 'put', '<slug>'], inputs: slug, why: 'Rewrite the page with the credential removed (page content on stdin); the rest of the conversation stays searchable.' },
    { action: 'remove', next: 'ask_user', argv: ['gbrain', 'delete', '<slug>', '--purge'], inputs: slug, why: 'Purging a conversation page loses the whole session with no recovery window; ask the user before running it.' },
    { action: 'rotate', next: 'ask_user', why: 'A credential that reached a page may also sit in git history, synced copies or exports; ask the user to rotate it (SECURITY.md, "If a secret reached the brain").' },
  ];
  if (json) {
    console.log(JSON.stringify({ ...result, cached, next_actions: nextActions }, null, 2));
    return;
  }
  console.log(`${scope === 'conversations' ? 'conversation' : 'transcript'} secret audit (${result.source_id ? `source: ${result.source_id}` : 'every source'}): ${result.pages_scanned} conversation page(s) scanned, ${result.pages_affected} carry ${result.hits_total} credential hit(s)`);
  for (const p of result.pages) {
    const counts = Object.entries(p.hits).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`  ${p.source_id}:${p.slug}  ${counts}${p.lines.length ? `  (lines ${p.lines.join(', ')})` : ''}`);
  }
  if (result.pages_affected > 0) {
    console.log('Next (separately): review with `gbrain get <slug>`, edit with `gbrain put <slug> < edited.md`, or remove with `gbrain delete <slug> --purge` after asking the user; ask the user to rotate any real credential.');
  }
  if (!cached) {
    console.error(scope === 'conversations'
      ? '[transcripts] the conversation audit record could not be saved; the GBrain monitor will report the secret scan as unknown.'
      : '[transcripts] the audit summary could not be cached; `gbrain doctor` will keep asking for an audit.');
  }
}

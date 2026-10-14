import { opError } from '../ops/contract.ts';
import { REMOTE_PRIVATE_PAGES_KEY, privatePagesFilterFragment, isReservedOwnerAggregateIdentity } from '../search/private-visibility.ts';
import type { SqlEngine, WriteAuthority } from './model.ts';

/** Publication uses fresh policy, independent of the read-side telemetry cache. */
export async function excludesPrivateWrites(engine: SqlEngine, remote: boolean): Promise<boolean> {
  if (!remote || process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return false;
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [REMOTE_PRIVATE_PAGES_KEY]);
  return !['visible', 'true', '1'].includes(row?.value ?? '');
}

/** Recheck after page guards at publication; also hide inaccessible receipt targets. */
export async function authorizePageVisibility(engine: SqlEngine, authority: WriteAuthority, slug: string): Promise<void> {
  if (!authority.remote) return;
  const filter = (authority.excludePrivate ?? true) === true || await excludesPrivateWrites(engine, true)
    ? true : 'owner-only';
  const rows = await engine.executeRaw<{ blocked: boolean }>(
    `SELECT NOT (${privatePagesFilterFragment('p', filter)}) AS blocked
       FROM pages p WHERE source_id=$1 AND slug=$2 LIMIT 1`,
    [authority.sourceId, slug],
  );
  if (rows.length) {
    if (rows[0].blocked) throw pageNotVisibleError();
    return;
  }
  // Create path: reserved owner-aggregate identities cannot be minted remotely.
  if (isReservedOwnerAggregateIdentity(authority.sourceId, slug)) {
    throw pageNotVisibleError();
  }
}

/** The one refusal a remote writer gets for a target it may not see; other visibility refusals reuse it verbatim. */
export function pageNotVisibleError() {
  return opError('page_not_found', 'Page not found.', 'This page does not exist or is not visible to this connection, so nothing was written. Write to a different slug, or confirm the slug with a search first.');
}


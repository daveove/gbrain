import { transactionMemo } from '../page-state/transactions.ts';
import type { SqlEngine } from './model.ts';

/**
 * #5984: one membership read per source per transaction; a FOR SHARE read also answers a plain one.
 * #6007: the FOR SHARE read also carries the source's read-only mirror flag, so a publication holds
 * the source row with one statement for its authorization and its mirror check.
 */
export function sourceMembership(engine: SqlEngine, sourceId: string, lock: boolean) {
  return transactionMemo(engine, lock ? [`source-membership:${sourceId}:share`] : [`source-membership:${sourceId}`, `source-membership:${sourceId}:share`],
    () => engine.executeRaw<{ incarnation: string; archived: boolean; mirror_read_only?: boolean }>(lock
      ? `SELECT incarnation,archived,COALESCE(config->>'mirror_read_only','false')='true' AS mirror_read_only FROM sources WHERE id=$1 FOR SHARE`
      : 'SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]));
}

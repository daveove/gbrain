import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import { sourceScopeOpts } from './context.ts';
import { assembleEvidenceContexts, type ContextInput, type RecordReader, type SourceRecord } from '../../../packages/evidence-context/index.mjs';

// Legacy source_records is a separate intake boundary, not a page-source grant.
// Use the injected engine only. No engine factory, migration, pool or write path.
export function evidenceRecordReader(executeRaw: (sql: string, params: unknown[]) => Promise<SourceRecord[]>): RecordReader {
  return {
    async findBySourceRef(sourceType, sourceRef) {
      const rows = await executeRaw('SELECT source_type, source_ref, entity_type, entity_id, payload_json, updated_at FROM public.source_records WHERE source_type = $1 AND source_ref = $2 LIMIT 1', [sourceType, sourceRef]);
      return rows[0] || null;
    },
    async searchRecords({ sourceTypes, payloadAny, after, limit }) {
      const params: unknown[] = [sourceTypes];
      const clauses = ['source_type = ANY($1::text[])'];
      if (payloadAny?.length) {
        const matches: string[] = [];
        for (const { equals } of payloadAny) {
          for (const [field, value] of Object.entries(equals)) {
            if (!/^(?:(metadata|message)\.)?(conversationId|chatId|threadId)$/.test(field)) throw new OperationError('invalid_input', 'Unsupported conversation field');
            params.push(value);
            matches.push(`payload_json#>>'{${field.split('.').join(',')}}' = $${params.length}`);
          }
        }
        clauses.push(`(${matches.join(' OR ')})`);
      }
      if (after) {
        params.push(after.updatedAt, after.sourceType, after.sourceRef);
        const n = params.length - 2;
        clauses.push(`(date_trunc('milliseconds', updated_at) < $${n}::timestamptz OR (date_trunc('milliseconds', updated_at) = $${n}::timestamptz AND (source_type COLLATE "C" > $${n + 1} OR (source_type = $${n + 1} AND source_ref COLLATE "C" > $${n + 2}))))`);
      }
      params.push(limit);
      return executeRaw(`SELECT source_type, source_ref, entity_type, entity_id, payload_json, updated_at FROM public.source_records WHERE ${clauses.join(' AND ')} ORDER BY date_trunc('milliseconds', updated_at) DESC, source_type COLLATE "C" ASC, source_ref COLLATE "C" ASC LIMIT $${params.length}`, params);
    },
  };
}

export const evidenceContextOperations: Operation[] = [{
  name: 'get_evidence_context',
  description: 'Assemble current source-record evidence for every supplied item. Owner-local only; page grants do not authorize raw account records. Returns revisions, body capability, exact references, gaps and bounded continuation.',
  params: {
    source_id: { type: 'string', required: true, description: 'Explicit intake source. Legacy source_records belongs to default; other page sources do not grant raw access.' },
    items: { type: 'array', items: { type: 'object' }, required: true, description: 'Items with id, exact references {sourceType, sourceRef, entityType?, entityId?}, and optional scoped continuation.' },
    accounts: { type: 'array', items: { type: 'object' }, required: true, description: 'Owner-local grants {system, network, accountKind, account}. Unknown accounts are unavailable.' },
    limit: { type: 'number', description: 'Conversation candidate page size per item, 1–200.', default: 50 },
  },
  scope: 'read', localOnly: true,
  handler: async (ctx, p) => {
    if (ctx.remote !== false) throw new OperationError('permission_denied', 'Raw account evidence requires a trusted owner-local caller');
    const scope = sourceScopeOpts(ctx);
    if (p.source_id !== 'default' || (scope.sourceId && scope.sourceId !== 'default')
      || (scope.sourceIds && !scope.sourceIds.includes('default'))) throw new OperationError('permission_denied', 'Raw intake evidence is not available in this page-source scope');
    if (!Array.isArray(p.items) || p.items.length > 2000 || !Array.isArray(p.accounts)
      || p.accounts.some(account => !account || typeof account !== 'object' || ['system', 'network', 'accountKind', 'account'].some(key => typeof account[key] !== 'string' || !account[key].trim()))) throw new OperationError('invalid_input', 'Items and explicit account grants are required; at most 2000 items per call');
    const grantKey = (identity: { system: unknown; network: unknown; accountKind: unknown; account: unknown }) => JSON.stringify([identity.system, identity.network, identity.accountKind, identity.account]);
    const accounts = new Set((p.accounts as { system: string; network: string; accountKind: string; account: string }[]).map(grantKey));
    return assembleEvidenceContexts({ items: p.items as ContextInput[], sourceId: 'default',
      reader: evidenceRecordReader((sql, params) => ctx.engine.executeRaw<SourceRecord>(sql, params)),
      authorize: (_row, identity) => Boolean(identity.account && accounts.has(grantKey(identity))),
      perItemLimit: p.limit as number | undefined });
  },
}];

import type { RecordReader, SourceRecord } from '../../packages/evidence-context/index.mjs';

// Optional host adapter for an existing intake database with source_records.
// Stock GBrain engines do not own this table. The host supplies its reader and
// authorization policy to the shared assembler; this adapter creates no store.
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
            if (!/^(?:(metadata|message)\.)?(conversationId|chatId|threadId)$/.test(field)) throw new TypeError('Unsupported conversation field');
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


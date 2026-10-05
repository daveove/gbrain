export interface SourceReference { sourceType: string; sourceRef: string; entityType?: string; entityId?: string }
export interface SourceRecord { source_type: string; source_ref: string; entity_type: string; entity_id: string; payload_json: Record<string, unknown>; updated_at: string | Date }
export interface Identity { system: string; network: string; accountKind: string; account: string | null; conversationId: string; resourceType: string; resourceId: string; conflict: boolean }
export interface Continuation { scope: string; cursor: string }
export interface ContextInput { id: string; references: SourceReference[]; continuation?: Continuation[]; anchorOffset?: number }
export interface SearchOptions { sourceTypes: string[]; payloadAny?: { equals: Record<string, string> }[]; after?: { updatedAt: string; sourceType: string; sourceRef: string }; limit: number }
export interface RecordReader { findBySourceRef(sourceType: string, sourceRef: string): Promise<SourceRecord | null>; searchRecords?(options: SearchOptions): Promise<SourceRecord[]> }
export interface Evidence { reference: SourceReference; identity: Identity; family: string; trust: 'untrusted_evidence'; title: string; sender: string; body: string | null; preview: string | null; previewTruncated: boolean; bodyState: string; contentKind: string; occurredAt: string | null; occurrenceDate: string | null; observedAt: string | null; updatedAt: string | null; revision: string; links: {url: string; label?: string}[]; lifecycle: string; providerState: string | null; truncated: boolean }
export interface ContextPacket { contract: string; itemId: string; sourceId: string; anchorOffset: number; state: string; evidence: Evidence[]; dependencies: (SourceReference & { revision: string })[]; gaps: string[]; continuation: Continuation[]; nextAnchorOffset?: number; revision: string; coverage: { anchorsRequested: number; anchorsResolved: number; candidatesExamined: number; queryExhausted: boolean; historyComplete: false; sourceFreshness: 'unknown' } }
export const CONTRACT: string;
export function recordReference(row: SourceRecord): SourceReference;
export function recordIdentity(row: SourceRecord): Identity;
export function normalizeEvidence(row: SourceRecord, options?: { identity?: Identity; maxBodyChars?: number }): Evidence;
export function conversationSearch(identity: Identity, sourceType: string, options?: { after?: SearchOptions['after']; limit?: number }): SearchOptions;
export function assembleEvidenceContexts(options: { items: ContextInput[]; sourceId: string; reader: RecordReader; authorize: (row: SourceRecord, identity: Identity, item: ContextInput) => boolean | Promise<boolean>; resolveIdentity?: (row: SourceRecord) => Identity; perItemLimit?: number; maxBodyChars?: number; signal?: AbortSignal }): Promise<{ contract: string; packets: ContextPacket[]; coverage: { requested: number; processed: number; ready: number; partial: number; unavailable: number } }>;

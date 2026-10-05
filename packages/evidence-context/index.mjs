import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CONTRACT = 'gbrain.evidence-context/v1';
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const text = v => typeof v === 'string' ? v.trim() : '';
const list = v => Array.isArray(v) ? v : [];
const iso = v => v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null;
const key = ref => JSON.stringify([ref.sourceType, ref.sourceRef]);
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const hash = v => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const bound = (v, fallback, max) => Number.isInteger(v) && v > 0 ? Math.min(v, max) : fallback;

export function recordReference(row) {
  return { sourceType: text(row?.source_type), sourceRef: text(row?.source_ref),
    entityType: text(row?.entity_type), entityId: text(row?.entity_id) };
}

// Producers can supply explicit intake identity. Legacy identity is conservative:
// unrelated resources are never joined by titles, senders or timestamps.
export function recordIdentity(row) {
  const p = obj(row?.payload_json), m = obj(p.metadata), message = obj(p.message);
  const intakeAliases = [m.intake, p.intake].filter(value => value !== undefined);
  const intakeFields = field => intakeAliases.map(value => obj(value)[field]);
  const resourceTypes = intakeFields('resourceType').map(text).filter(Boolean);
  const resourceIds = intakeFields('resourceId').map(text).filter(Boolean);
  const emails = [p.mailboxEmail, p.profileEmail, m.mailboxEmail, m.profileEmail,
    message.mailboxEmail, message.profileEmail].map(text).filter(Boolean).map(v => v.toLowerCase());
  const profiles = [p.profileId, m.profileId, message.profileId].map(text).filter(Boolean);
  const accounts = [...intakeFields('sourceAccountId'), p.sourceAccountId, m.sourceAccountId].map(text).filter(Boolean);
  const systems = [...intakeFields('system'), p.sourceSystem, m.sourceSystem].map(text).filter(Boolean);
  const networkValues = [...intakeFields('network'), p.network, p.channel, m.network, m.channel, message.network, message.channel];
  const networks = networkValues.map(text).filter(Boolean);
  const conversationValues = [p.conversationId, p.chatId, p.threadId, m.conversationId, m.chatId, m.threadId,
    message.conversationId, message.chatId, message.threadId];
  const conversations = conversationValues.map(text).filter(Boolean);
  const identityValues = [row?.source_type, row?.source_ref, row?.entity_type, row?.entity_id,
    p.mailboxEmail, p.profileEmail, m.mailboxEmail, m.profileEmail,
    message.mailboxEmail, message.profileEmail, p.profileId, m.profileId, message.profileId,
    ...intakeFields('sourceAccountId'), p.sourceAccountId, m.sourceAccountId, ...intakeFields('system'), p.sourceSystem, m.sourceSystem,
    ...intakeFields('resourceType'), ...intakeFields('resourceId'), ...networkValues, ...conversationValues];
  const conflict = [emails, profiles, accounts, systems, networks, conversations, resourceTypes, resourceIds].some(values => new Set(values).size > 1)
    || intakeAliases.some(value => !value || typeof value !== 'object' || Array.isArray(value))
    || identityValues.some(value => value !== undefined && (typeof value !== 'string'
      || value !== value.trim() || value.length > 512))
    || emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const system = systems[0] || text(row?.source_type === 'comms_channel' ? '' : row?.source_type);
  return { system, network: networks[0] || system,
    accountKind: accounts.length ? 'source-account' : emails.length ? 'mailbox' : profiles.length ? 'profile' : 'unknown',
    account: accounts[0] || emails[0] || profiles[0] || null,
    conversationId: conversations[0] || '',
    resourceType: resourceTypes[0] || text(row?.entity_type),
    resourceId: resourceIds[0] || text(row?.entity_id), conflict };
}

const THREAD_FIELDS = ['conversationId', 'chatId', 'threadId'];
export function conversationSearch(identity, sourceType, { after, limit = 51 } = {}) {
  // Readers support these fixed identity paths; every result still passes full
  // account/network/thread validation before it becomes evidence.
  return { sourceTypes: [sourceType], payloadAny: sourceType === 'comms_channel'
    ? ['', 'metadata.', 'message.'].flatMap(prefix => THREAD_FIELDS.map(field =>
      ({ equals: { [prefix + field]: identity.conversationId } }))) : undefined,
    after, limit };
}

function referenceMatches(row, ref) {
  const actual = recordReference(row);
  return key(actual) === key(ref) && (!ref.entityType || ref.entityType === actual.entityType)
    && (!ref.entityId || ref.entityId === actual.entityId);
}
function sameConversation(a, b) {
  return !a.conflict && !b.conflict && a.account && a.conversationId
    && ['system', 'network', 'accountKind', 'account', 'conversationId'].every(k => a[k] === b[k]);
}
function lifecycleSuppressed(p) {
  return [p.deleted, p.suppressed, p.archived].some(value => value !== undefined && value !== false)
    || [p.lifecycle, p.state].some(value => value !== undefined && (typeof value !== 'string'
      || ['deleted', 'suppressed', 'archived', 'retired'].includes(text(value).toLowerCase())));
}
function sensitivityOf(p) {
  const classifications = [obj(p.metadata).sensitivity, p.sensitivity].filter(value => value !== undefined);
  return classifications.length && classifications.every(value => obj(value).level === 'business') ? 'business' : '';
}

export function normalizeEvidence(row, { identity = recordIdentity(row), maxBodyChars = 12000 } = {}) {
  const p = obj(row.payload_json), message = obj(p.message), e = obj(p.evidence);
  const type = text(row.entity_type), source = text(row.source_type);
  const family = type === 'comms_channel_message' ? 'message'
    : source === 'gmail' || source === 'email' || Object.keys(message).length ? 'email'
    : /circleback|pocket|meeting|transcript/.test(`${source} ${type}`) ? 'meeting'
    : /linear/.test(`${source} ${type}`) ? 'issue'
    : /calendar/.test(`${source} ${type}`) ? 'calendar'
    : /readwise|article|document|capture/.test(`${source} ${type}`) ? 'document' : 'unsupported';
  const original = text(e.body || message.body || p.body || p.text || p.content || p.transcript || p.markdown || p.description);
  const providerNotes = family === 'meeting' ? text(p.circlebackNotes || p.notes) : '';
  const availableBody = original || providerNotes;
  const preview = text(p.preview || p.snippet || message.snippet || p.summary || p.generatedSummary || p.detail);
  const completeClaims = [e.complete, obj(p.metadata).bodyComplete].filter(value => value !== undefined);
  const explicitComplete = completeClaims.length > 0 && completeClaims.every(value => value === true)
    && [e.truncated, obj(p.metadata).truncated, p.truncated].filter(value => value !== undefined).every(value => value === false);
  const state = family === 'unsupported' ? 'unsupported' : availableBody
    ? original && explicitComplete && original.length <= maxBodyChars ? 'complete' : 'partial'
    : preview ? 'preview-only' : 'unavailable';
  return { reference: recordReference(row), identity, family, trust: 'untrusted_evidence',
    title: text(p.title || message.subject || p.subject || p.chatTitle).slice(0, 1000),
    sender: text(p.sender || message.sender).slice(0, 500),
    body: family === 'unsupported' ? null : availableBody.slice(0, maxBodyChars) || null,
    contentKind: original ? family === 'meeting' && p.transcript && !e.body ? 'transcript' : 'source-content'
      : providerNotes ? 'provider-notes' : preview ? 'preview-or-summary' : 'unavailable',
    preview: preview.slice(0, 1000) || null, previewTruncated: preview.length > 1000, bodyState: state,
    occurredAt: iso(p.occurredAt || p.sentAt || message.sentAt || p.startTime || obj(p.start).dateTime || p.capturedAt),
    occurrenceDate: text(obj(p.start).date) || null,
    observedAt: iso(p.importedAt || p.observedAt || p.retrievedAt), updatedAt: iso(row.updated_at),
    revision: hash({ reference: recordReference(row), payload: p, updatedAt: iso(row.updated_at) }),
    links: list(p.sourceLinks).flatMap(link => {
      const url = text(link?.url), label = text(link?.label).slice(0, 200);
      if (!/^https?:\/\//i.test(url) || url.length > 2048) return [];
      return [{ url, ...(label ? { label } : {}) }];
    }).slice(0, 20),
    lifecycle: text(p.lifecycle) || 'observed', providerState: text(p.status) || null,
    truncated: availableBody.length > maxBodyChars };
}

// Process-scoped authenticated encryption keeps denied-row keysets private.
// A restart invalidates progress; callers must refresh their initial packet.
const cursorKey = randomBytes(32);
function sealCursor(cursor) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cursorKey, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(cursor), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
function openCursor(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw 0;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length <= 28) throw 0;
  const decipher = createDecipheriv('aes-256-gcm', cursorKey, bytes.subarray(0, 12), { authTagLength: 16 });
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}
function cursorFor(row, scope, anchorOffset, binding) {
  return sealCursor({ contract: CONTRACT, scope, anchorOffset, binding, updatedAt: iso(row.updated_at),
    sourceType: text(row.source_type), sourceRef: text(row.source_ref) });
}
function startCursor(scope, anchorOffset, binding) {
  return sealCursor({ contract: CONTRACT, scope, anchorOffset, binding, start: true });
}
function decodeCursor(value, scope, binding) {
  if (!value) return undefined;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('invalid_continuation');
  try {
    const c = openCursor(value);
    if (c.contract !== CONTRACT || c.scope !== scope || c.binding !== binding) throw 0;
    if (c.start === true && Number.isInteger(c.anchorOffset) && c.anchorOffset >= 0) return undefined;
    if (!iso(c.updatedAt) || !text(c.sourceType) || !text(c.sourceRef)) throw 0;
    return { updatedAt: iso(c.updatedAt), sourceType: c.sourceType, sourceRef: c.sourceRef };
  } catch { throw new Error('invalid_continuation'); }
}

/** Storage and authorization are supplied by a checked host. This module never
 * constructs an engine, reads credentials, executes source text, or writes memory. */
export async function assembleEvidenceContexts({ items, reader, authorize, resolveIdentity = recordIdentity,
  sourceId, perItemLimit = 50, maxBodyChars = 12000, signal } = {}) {
  if (!text(sourceId) || !reader || typeof authorize !== 'function' || !Array.isArray(items))
    throw new TypeError('items, sourceId, reader and a host authorization policy are required');
  const limit = bound(perItemLimit, 50, 200), bodyLimit = bound(maxBodyChars, 12000, 50000);
  const cache = new Map();
  const conversationCache = new Map();
  const readExact = ref => {
    if (!cache.has(key(ref))) cache.set(key(ref), Promise.resolve().then(() => reader.findBySourceRef(ref.sourceType, ref.sourceRef)));
    return cache.get(key(ref));
  };
  const packets = [];
  for (const item of items) {
    const refs = list(item?.references);
    const binding = hash({ sourceId, itemId: text(item?.id), references: refs });
    const requestedOffset = Number.isInteger(item?.anchorOffset) && item.anchorOffset >= 0 ? item.anchorOffset : 0;
    // A conversation cursor retains its anchor position. When a caller supplies
    // both progress dimensions, finish that conversation before later anchors.
    const pendingOffsets = list(item?.continuation).flatMap(value => {
      try {
        if (typeof value?.cursor !== 'string' || value.cursor.length > 4096) return [];
        const cursor = openCursor(value.cursor);
        if (cursor.contract !== CONTRACT || cursor.scope !== value.scope || cursor.binding !== binding) return [];
        return Number.isInteger(cursor.anchorOffset) && cursor.anchorOffset >= 0 && cursor.anchorOffset < refs.length
          ? [cursor.anchorOffset] : [];
      } catch { return []; }
    });
    const offset = pendingOffsets.length ? Math.min(...pendingOffsets) : requestedOffset;
    const packet = { contract: CONTRACT, itemId: text(item?.id), sourceId, anchorOffset: offset,
      state: 'unavailable', evidence: [], dependencies: [], gaps: [], continuation: [],
      coverage: { anchorsRequested: refs.length, anchorsResolved: 0, candidatesExamined: 0,
        queryExhausted: false, historyComplete: false, sourceFreshness: 'unknown' } };
    const addGap = code => { if (!packet.gaps.includes(code)) packet.gaps.push(code); };
    const evidence = new Map();
    let bodyChars = 0;
    const approved = async row => {
      const p = obj(row?.payload_json);
      if (lifecycleSuppressed(p)) return false;
      // Missing metadata never silently upgrades old content to business evidence.
      if (sensitivityOf(p) !== 'business') return false;
      const identity = resolveIdentity(row);
      return identity && !identity.conflict && await authorize(row, identity, item) === true;
    };
    const include = (row, maxChars = bodyLimit) => {
      const refKey = key(recordReference(row));
      if (evidence.has(refKey)) return true;
      if (evidence.size >= 200 || bodyChars >= 64000) { addGap('packet_budget_reached'); return false; }
      const normalized = normalizeEvidence(row, { identity: resolveIdentity(row), maxBodyChars: maxChars });
      const remaining = Math.max(0, 64000 - bodyChars);
      // A packet budget must not permanently clip an otherwise readable body.
      if ((normalized.body?.length || 0) > remaining) { addGap('packet_budget_reached'); return false; }
      if ((normalized.body?.length || 0) + (normalized.preview?.length || 0) > remaining) {
        normalized.preview = normalized.preview?.slice(0, Math.max(0, remaining - (normalized.body?.length || 0))) || null;
        normalized.previewTruncated = true;
        addGap('packet_budget_reached');
      }
      bodyChars += (normalized.body?.length || 0) + (normalized.preview?.length || 0);
      if (bodyChars >= 64000) addGap('packet_budget_reached');
      evidence.set(key(normalized.reference), normalized);
      if (normalized.bodyState !== 'complete') addGap(normalized.bodyState === 'unsupported' ? 'unsupported_record' : 'body_incomplete');
      if (normalized.truncated) addGap('body_truncated');
      if (normalized.previewTruncated) addGap('preview_truncated');
      return true;
    };
    let exhausted = true;
    const conversations = new Set();
    if (requestedOffset > refs.length || (item?.anchorOffset != null && requestedOffset !== item.anchorOffset)) addGap('invalid_continuation');
    if (refs.length - offset > 100) { packet.nextAnchorOffset = offset + 100; addGap('anchor_limit'); }
    for (const [relativeIndex, ref] of refs.slice(offset, offset + 100).entries()) {
      const anchorIndex = offset + relativeIndex;
      if (signal?.aborted) { addGap('cancelled'); exhausted = false; break; }
      if (!text(ref?.sourceType) || !text(ref?.sourceRef)) { addGap('reference_invalid'); exhausted = false; continue; }
      try {
        const row = await readExact(ref);
        if (!row || !referenceMatches(row, ref)) { addGap('reference_unavailable'); exhausted = false; continue; }
        if (!await approved(row)) { addGap('reference_unavailable'); exhausted = false; continue; }
        packet.coverage.anchorsResolved++;
        const identity = resolveIdentity(row);
        const { system, network, accountKind, account, conversationId } = identity;
        const scope = system && network && account && conversationId
          ? hash({ sourceId, sourceType: row.source_type, system, network, accountKind, account, conversationId }) : null;
        const cursor = scope && list(item.continuation).find(c => c.scope === scope)?.cursor;
        // Repeated anchors retain a current authorized excerpt while reserving
        // enough space for one unread body even at the 50K per-body limit.
        if (!include(row, cursor ? Math.min(bodyLimit, 12000) : bodyLimit)) { packet.nextAnchorOffset = anchorIndex; exhausted = false; break; }
        if (!scope) { addGap('conversation_identity_missing'); exhausted = false; continue; }
        if (conversations.has(scope)) continue;
        conversations.add(scope);
        const after = decodeCursor(cursor, scope, binding);
        if (list(item.continuation).some(c => !c || !text(c.scope))) throw new Error('invalid_continuation');
        // Each page stops at its first unfinished conversation. Later scopes
        // have not been scanned yet and must start after this one is exhausted.
        if (typeof reader.searchRecords !== 'function') { addGap('conversation_reader_unavailable'); exhausted = false; continue; }
        // Filter before exposing counts or progress. Denied rows stay inside a
        // bounded internal scan and never become client pagination boundaries.
        const rows = []; let scanAfter = after, scanned = 0;
        while (rows.length <= limit) {
          if (signal?.aborted) throw new Error('reader_failed');
          const query = conversationSearch(identity, row.source_type, { after: scanAfter, limit: limit + 1 });
          const queryKey = hash(query);
          if (!conversationCache.has(queryKey)) conversationCache.set(queryKey, Promise.resolve().then(() => reader.searchRecords(query)));
          const batch = await conversationCache.get(queryKey);
          if (!Array.isArray(batch) || batch.length > limit + 1) throw new Error('reader_failed');
          for (const candidate of batch) {
            if (++scanned > 2000) throw new Error('reader_failed');
            if (candidate.source_type === row.source_type && sameConversation(identity, resolveIdentity(candidate)) && await approved(candidate)) rows.push(candidate);
            if (rows.length > limit) break;
          }
          if (rows.length > limit || batch.length < limit + 1) break;
          const last = batch.at(-1);
          if (!iso(last?.updated_at) || !text(last?.source_type) || !text(last?.source_ref)) throw new Error('reader_failed');
          const next = { updatedAt: iso(last.updated_at), sourceType: last.source_type, sourceRef: last.source_ref };
          if (JSON.stringify(next) === JSON.stringify(scanAfter)) throw new Error('reader_failed');
          scanAfter = next;
        }
        let examined = 0, lastProcessed = null;
        for (const candidate of rows.slice(0, limit)) {
          if (!include(candidate)) break;
          examined++; lastProcessed = candidate;
          if (packet.gaps.includes('packet_budget_reached')) break;
        }
        packet.coverage.candidatesExamined += examined;
        if (rows.length > examined) {
          const last = lastProcessed;
          if (last && !iso(last.updated_at)) throw new Error('reader_failed');
          packet.continuation.push({ scope, cursor: last ? cursorFor(last, scope, anchorIndex, binding) : cursor || startCursor(scope, anchorIndex, binding) });
          packet.anchorOffset = anchorIndex;
          packet.nextAnchorOffset = anchorIndex + 1 < refs.length ? anchorIndex + 1 : undefined;
          addGap('bounded_read'); exhausted = false; break;
        }
      } catch (error) {
        addGap(error?.message === 'invalid_continuation' ? 'invalid_continuation' : 'reader_failed'); exhausted = false;
      }
    }
    if (!refs.length) addGap('references_missing');
    if (list(item?.continuation).some(value => !conversations.has(value?.scope))) addGap('invalid_continuation');
    packet.evidence = [...evidence.values()].sort((a, b) => (a.occurredAt || a.updatedAt || '').localeCompare(b.occurredAt || b.updatedAt || '')
      || key(a.reference).localeCompare(key(b.reference)));
    packet.dependencies = packet.evidence.map(e => ({ ...e.reference, revision: e.revision }));
    packet.coverage.queryExhausted = refs.length > 0 && exhausted && packet.nextAnchorOffset == null && !packet.gaps.includes('anchor_limit')
      && !packet.gaps.includes('invalid_continuation');
    addGap('source_freshness_unknown');
    packet.state = packet.evidence.length ? packet.gaps.some(g => g !== 'source_freshness_unknown') ? 'partial' : 'ready' : 'unavailable';
    packet.revision = hash({ contract: CONTRACT, normalizerVersion: 16, sourceId, itemId: packet.itemId,
      limits: { perItemLimit: limit, maxBodyChars: bodyLimit }, evidence: packet.evidence,
      references: refs, anchorOffset: offset, dependencies: packet.dependencies,
      gaps: packet.gaps, coverage: packet.coverage,
      continuation: packet.continuation.map(({ scope, cursor }) => ({ scope, keyset: openCursor(cursor) })) });
    packets.push(packet);
  }
  return { contract: CONTRACT, packets, coverage: { requested: items.length, processed: packets.length,
    ready: packets.filter(p => p.state === 'ready').length, partial: packets.filter(p => p.state === 'partial').length,
    unavailable: packets.filter(p => p.state === 'unavailable').length } };
}

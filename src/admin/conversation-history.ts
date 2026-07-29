type Row = Record<string, any>;

export const DEFAULT_CONVERSATION_HISTORY_LIMIT = 100;
export const MAX_CONVERSATION_HISTORY_LIMIT = 200;

export interface ConversationHistorySources {
  inbound: Row[];
  outbox: Row[];
  adapterEvents: Row[];
  batches: Row[];
}

export interface ConversationHistoryOptions {
  tenantId: string;
  accountId: string;
  conversationId: string;
  contactId: string;
  showPii: boolean;
  limit?: unknown;
  cursor?: unknown;
}

interface SourceCursor {
  timestamp: string;
  key: string;
}

interface HistoryCursor {
  version: 1;
  inbound?: SourceCursor;
  outgoing?: SourceCursor;
}

interface InternalMessage {
  message_key: string;
  turn_key: string;
  direction: 'incoming' | 'outgoing';
  text: string | null;
  timestamp: string;
  trace_id?: string | null;
  chatwoot_message_id?: string | null;
  source_message_id?: string | null;
  inbox_id?: string | null;
  adapter_request_key?: string | null;
  batch_key?: string | null;
  outbox_key?: string | null;
  delivery_status?: 'sent';
  _source: 'inbound' | 'outgoing';
  _source_cursor_key: string;
}

export class ConversationHistoryError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'ConversationHistoryError';
  }
}

function requiredIdentifier(value: unknown, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new ConversationHistoryError(
      'INVALID_CONVERSATION_HISTORY_QUERY',
      400,
      `${field} is required`
    );
  }
  return normalized;
}

export function parseConversationHistoryLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_CONVERSATION_HISTORY_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConversationHistoryError(
      'INVALID_CONVERSATION_HISTORY_LIMIT',
      400,
      'limit must be a positive integer'
    );
  }
  return Math.min(parsed, MAX_CONVERSATION_HISTORY_LIMIT);
}

function validCursorPart(value: unknown, keyPattern: RegExp): value is SourceCursor {
  if (!value || typeof value !== 'object') return false;
  const timestamp = String((value as SourceCursor).timestamp ?? '');
  const key = String((value as SourceCursor).key ?? '');
  return Number.isFinite(new Date(timestamp).getTime()) && keyPattern.test(key);
}

export function decodeConversationHistoryCursor(value: unknown): HistoryCursor {
  if (value === undefined || value === null || value === '') return { version: 1 };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (
      parsed?.version !== 1
      || (parsed.inbound && !validCursorPart(parsed.inbound, /^\d+$/))
      || (parsed.outgoing && !validCursorPart(parsed.outgoing, /^[A-Za-z0-9:_-]+$/))
    ) {
      throw new Error('invalid cursor');
    }
    return {
      version: 1,
      ...(parsed.inbound
        ? {
            inbound: {
              timestamp: new Date(parsed.inbound.timestamp).toISOString(),
              key: String(parsed.inbound.key)
            }
          }
        : {}),
      ...(parsed.outgoing
        ? {
            outgoing: {
              timestamp: new Date(parsed.outgoing.timestamp).toISOString(),
              key: String(parsed.outgoing.key)
            }
          }
        : {})
    };
  } catch {
    throw new ConversationHistoryError(
      'INVALID_CONVERSATION_HISTORY_CURSOR',
      400,
      'cursor is invalid'
    );
  }
}

export function encodeConversationHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function assertConversationHistoryAccountAccess(
  authenticatedTenantId: string,
  accountContext: { tenant_id: string; account_id: string }
): void {
  if (accountContext.tenant_id !== authenticatedTenantId) {
    throw new ConversationHistoryError(
      'CONVERSATION_HISTORY_FORBIDDEN',
      403,
      'account is not available for the authenticated tenant'
    );
  }
}

function sameConversation(row: Row, options: RequiredIdentifiers): boolean {
  return String(row.tenant_id ?? '') === options.tenantId
    && String(row.conversation_id ?? '') === options.conversationId
    && String(row.contact_id ?? '') === options.contactId;
}

function sameAccountConversation(row: Row, options: RequiredIdentifiers): boolean {
  return sameConversation(row, options)
    && String(row.account_id ?? '') === options.accountId;
}

interface RequiredIdentifiers {
  tenantId: string;
  accountId: string;
  conversationId: string;
  contactId: string;
}

function normalizedOptions(options: ConversationHistoryOptions): RequiredIdentifiers {
  return {
    tenantId: requiredIdentifier(options.tenantId, 'tenant_id'),
    accountId: requiredIdentifier(options.accountId, 'account_id'),
    conversationId: requiredIdentifier(options.conversationId, 'conversation_id'),
    contactId: requiredIdentifier(options.contactId, 'contact_id')
  };
}

function sourceTimestamp(row: Row, source: 'inbound' | 'outgoing'): string | null {
  const raw = source === 'inbound' ? row.created_at : row.sent_at;
  if (!raw || !Number.isFinite(new Date(raw).getTime())) return null;
  return new Date(raw).toISOString();
}

function isBeforeCursor(message: InternalMessage, cursor: HistoryCursor): boolean {
  const boundary = cursor[message._source];
  if (!boundary) return true;
  const timeComparison = message.timestamp.localeCompare(boundary.timestamp);
  if (timeComparison < 0) return true;
  if (timeComparison > 0) return false;
  if (message._source === 'inbound') {
    return Number(message._source_cursor_key) < Number(boundary.key);
  }
  return message._source_cursor_key.localeCompare(boundary.key) < 0;
}

function compareMessagesDescending(a: InternalMessage, b: InternalMessage): number {
  const timestampComparison = b.timestamp.localeCompare(a.timestamp);
  if (timestampComparison !== 0) return timestampComparison;
  if (a._source === b._source) {
    if (a._source === 'inbound') {
      return Number(b._source_cursor_key) - Number(a._source_cursor_key);
    }
    return b._source_cursor_key.localeCompare(a._source_cursor_key);
  }
  return b.message_key.localeCompare(a.message_key);
}

function turnKey(parts: {
  batchKey?: unknown;
  adapterRequestKey?: unknown;
  traceId?: unknown;
  responseIdempotencyKey?: unknown;
  fallback: string;
}): string {
  const candidates: Array<[string, unknown]> = [
    ['batch_key', parts.batchKey],
    ['adapter_request_key', parts.adapterRequestKey],
    ['trace_id', parts.traceId],
    ['response_idempotency_key', parts.responseIdempotencyKey]
  ];
  for (const [prefix, value] of candidates) {
    const normalized = String(value ?? '').trim();
    if (normalized) return `${prefix}:${normalized}`;
  }
  return `message_key:${parts.fallback}`;
}

function stripInternalFields(message: InternalMessage) {
  const { _source, _source_cursor_key, ...result } = message;
  return result;
}

export function buildAdminConversationHistory(
  sources: ConversationHistorySources,
  options: ConversationHistoryOptions
) {
  const identifiers = normalizedOptions(options);
  const limit = parseConversationHistoryLimit(options.limit);
  const cursor = decodeConversationHistoryCursor(options.cursor);
  const batches = sources.batches.filter(row => sameAccountConversation(row, identifiers));
  const adapterEvents = sources.adapterEvents.filter(row => sameAccountConversation(row, identifiers));
  const batchByKey = new Map(
    batches.filter(row => row.batch_key).map(row => [String(row.batch_key), row])
  );
  const batchByRequest = new Map(
    batches.filter(row => row.adapter_request_key).map(row => [String(row.adapter_request_key), row])
  );
  const eventByTrace = new Map<string, Row>();
  for (const event of adapterEvents) {
    const traceId = String(event.trace_id ?? '').trim();
    if (traceId && !eventByTrace.has(traceId)) eventByTrace.set(traceId, event);
  }

  const messages: InternalMessage[] = [];
  const incomingDedupe = new Set<string>();
  for (const row of sources.inbound) {
    if (!sameConversation(row, identifiers) || row.direction !== 'incoming') continue;
    const messageId = String(row.message_id ?? '').trim();
    const sourceId = String(row.source_id ?? '').trim();
    const rowId = String(row.id ?? '').trim();
    const stableId = messageId || (sourceId ? `source:${sourceId}` : `row:${rowId}`);
    if (!stableId || incomingDedupe.has(`${identifiers.tenantId}:${stableId}`)) continue;
    const timestamp = sourceTimestamp(row, 'inbound');
    if (!timestamp || !rowId) continue;
    incomingDedupe.add(`${identifiers.tenantId}:${stableId}`);

    const responseKey = String(row.response_idempotency_key ?? '').trim();
    const adapterEvent = eventByTrace.get(String(row.trace_id ?? '').trim());
    const eventRequestKey = String(adapterEvent?.request_key ?? '').trim();
    const linkedBatch = batchByKey.get(responseKey)
      || batchByRequest.get(responseKey)
      || batchByRequest.get(eventRequestKey);
    const adapterRequestKey = String(
      linkedBatch?.adapter_request_key || eventRequestKey || ''
    ).trim();
    const messageKey = `incoming:${stableId}`;
    messages.push({
      message_key: messageKey,
      turn_key: turnKey({
        batchKey: linkedBatch?.batch_key,
        adapterRequestKey,
        traceId: row.trace_id,
        responseIdempotencyKey: responseKey,
        fallback: messageKey
      }),
      direction: 'incoming',
      text: options.showPii ? String(row.body ?? '') : null,
      timestamp,
      trace_id: row.trace_id || null,
      chatwoot_message_id: messageId || null,
      source_message_id: sourceId || null,
      inbox_id: row.inbox_id ? String(row.inbox_id) : null,
      adapter_request_key: adapterRequestKey || null,
      batch_key: linkedBatch?.batch_key || null,
      _source: 'inbound',
      _source_cursor_key: rowId
    });
  }

  const outgoingDedupe = new Set<string>();
  for (const row of sources.outbox) {
    if (
      !sameAccountConversation(row, identifiers)
      || row.status !== 'sent'
      || !row.chatwoot_outbound_message_id
    ) continue;
    const outboxKey = String(row.outbox_key ?? '').trim();
    const outboundId = String(row.chatwoot_outbound_message_id ?? '').trim();
    const dedupeKey = outboxKey || `${identifiers.tenantId}:${outboundId}`;
    if (!dedupeKey || outgoingDedupe.has(dedupeKey)) continue;
    const timestamp = sourceTimestamp(row, 'outgoing');
    if (!timestamp) continue;
    outgoingDedupe.add(dedupeKey);
    const messageKey = `outgoing:${outboxKey || outboundId}`;
    messages.push({
      message_key: messageKey,
      turn_key: turnKey({
        batchKey: row.batch_key,
        adapterRequestKey: row.adapter_request_key,
        fallback: messageKey
      }),
      direction: 'outgoing',
      text: options.showPii ? String(row.content ?? '') : null,
      timestamp,
      chatwoot_message_id: outboundId,
      adapter_request_key: row.adapter_request_key || null,
      batch_key: row.batch_key || null,
      outbox_key: outboxKey || null,
      delivery_status: 'sent',
      _source: 'outgoing',
      _source_cursor_key: outboxKey || outboundId
    });
  }

  const candidates = messages
    .filter(message => isBeforeCursor(message, cursor))
    .sort(compareMessagesDescending);
  const selected = candidates.slice(0, limit);
  let nextCursor: string | null = null;
  if (candidates.length > limit) {
    const nextState: HistoryCursor = {
      version: 1,
      ...(cursor.inbound ? { inbound: cursor.inbound } : {}),
      ...(cursor.outgoing ? { outgoing: cursor.outgoing } : {})
    };
    for (const source of ['inbound', 'outgoing'] as const) {
      const lastSelected = [...selected].reverse().find(message => message._source === source);
      if (lastSelected) {
        nextState[source] = {
          timestamp: lastSelected.timestamp,
          key: lastSelected._source_cursor_key
        };
      }
    }
    nextCursor = encodeConversationHistoryCursor(nextState);
  }

  return {
    conversation: {
      tenant_id: identifiers.tenantId,
      account_id: identifiers.accountId,
      conversation_id: identifiers.conversationId,
      contact_id: identifiers.contactId
    },
    messages: selected
      .sort((a, b) => -compareMessagesDescending(a, b))
      .map(stripInternalFields),
    next_cursor: nextCursor
  };
}

function applySourceCursor(query: any, cursor: SourceCursor | undefined, timestampColumn: string, keyColumn: string) {
  if (!cursor) return query;
  return query.or(
    `${timestampColumn}.lt.${cursor.timestamp},and(${timestampColumn}.eq.${cursor.timestamp},${keyColumn}.lt.${cursor.key})`
  );
}

function uniqueValues(values: unknown[]): string[] {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))];
}

function assertQueryResult(result: any, source: string): Row[] {
  if (result.error) {
    throw new ConversationHistoryError(
      'CONVERSATION_HISTORY_SOURCE_FAILED',
      503,
      `${source} is unavailable`
    );
  }
  return result.data || [];
}

export async function loadAdminConversationHistory(
  client: any,
  options: ConversationHistoryOptions
) {
  const identifiers = normalizedOptions(options);
  const limit = parseConversationHistoryLimit(options.limit);
  const cursor = decodeConversationHistoryCursor(options.cursor);
  const fetchLimit = limit + 1;

  let inboundQuery = client
    .from('helios_inbound_buffer')
    .select('id, tenant_id, conversation_id, contact_id, inbox_id, message_id, source_id, body, direction, trace_id, response_idempotency_key, created_at')
    .eq('tenant_id', identifiers.tenantId)
    .eq('conversation_id', identifiers.conversationId)
    .eq('contact_id', identifiers.contactId)
    .eq('direction', 'incoming')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(fetchLimit);
  inboundQuery = applySourceCursor(inboundQuery, cursor.inbound, 'created_at', 'id');

  let outboxQuery = client
    .from('helios_chatwoot_outbox')
    .select('outbox_key, batch_key, tenant_id, account_id, conversation_id, contact_id, adapter_request_key, content, status, chatwoot_outbound_message_id, sent_at')
    .eq('tenant_id', identifiers.tenantId)
    .eq('account_id', identifiers.accountId)
    .eq('conversation_id', identifiers.conversationId)
    .eq('contact_id', identifiers.contactId)
    .eq('status', 'sent')
    .not('chatwoot_outbound_message_id', 'is', null)
    .order('sent_at', { ascending: false })
    .order('outbox_key', { ascending: false })
    .limit(fetchLimit);
  outboxQuery = applySourceCursor(outboxQuery, cursor.outgoing, 'sent_at', 'outbox_key');

  const [inboundResult, outboxResult] = await Promise.all([inboundQuery, outboxQuery]);
  const inbound = assertQueryResult(inboundResult, 'helios_inbound_buffer');
  const outbox = assertQueryResult(outboxResult, 'helios_chatwoot_outbox');

  const traceIds = uniqueValues(inbound.map(row => row.trace_id));
  let adapterEvents: Row[] = [];
  if (traceIds.length) {
    const eventResult = await client
      .from('helios_adapter_events')
      .select('trace_id, request_key, tenant_id, account_id, conversation_id, contact_id, created_at')
      .eq('tenant_id', identifiers.tenantId)
      .eq('account_id', identifiers.accountId)
      .eq('conversation_id', identifiers.conversationId)
      .eq('contact_id', identifiers.contactId)
      .in('trace_id', traceIds)
      .order('created_at', { ascending: false })
      .limit(fetchLimit);
    adapterEvents = assertQueryResult(eventResult, 'helios_adapter_events');
  }

  const correlationKeys = uniqueValues([
    ...inbound.map(row => row.response_idempotency_key),
    ...outbox.map(row => row.batch_key),
    ...outbox.map(row => row.adapter_request_key),
    ...adapterEvents.map(row => row.request_key)
  ]);
  let batches: Row[] = [];
  if (correlationKeys.length) {
    const batchFetchLimit = Math.min(
      correlationKeys.length + 1,
      (MAX_CONVERSATION_HISTORY_LIMIT + 1) * 4
    );
    const baseBatchQuery = () => client
      .from('helios_processing_batches')
      .select('batch_key, adapter_request_key, tenant_id, account_id, conversation_id, contact_id, created_at')
      .eq('tenant_id', identifiers.tenantId)
      .eq('account_id', identifiers.accountId)
      .eq('conversation_id', identifiers.conversationId)
      .eq('contact_id', identifiers.contactId);
    const [byBatchResult, byRequestResult] = await Promise.all([
      baseBatchQuery().in('batch_key', correlationKeys).limit(batchFetchLimit),
      baseBatchQuery().in('adapter_request_key', correlationKeys).limit(batchFetchLimit)
    ]);
    batches = [
      ...assertQueryResult(byBatchResult, 'helios_processing_batches'),
      ...assertQueryResult(byRequestResult, 'helios_processing_batches')
    ].filter((row, index, rows) =>
      rows.findIndex(candidate => candidate.batch_key === row.batch_key) === index
    );
  }

  return buildAdminConversationHistory(
    { inbound, outbox, adapterEvents, batches },
    { ...options, limit, cursor: options.cursor }
  );
}

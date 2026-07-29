export const ADMIN_RANGES = ['today', '24h', '7d', 'all'] as const;
export type AdminRange = typeof ADMIN_RANGES[number];

type Row = Record<string, any>;

export interface AdminObservabilitySources {
  idempotency: Row[];
  inbound: Row[];
  batches: Row[];
  outbox: Row[];
  executions: Row[];
  adapterEvents: Row[];
  profiles: Row[];
  states: Row[];
  logs: Row[];
}

interface BuildOptions {
  tenantId: string;
  showPii: boolean;
  range: AdminRange;
  now?: Date;
}

const INVALID_NAME_VALUES = new Set([
  '',
  '[REDACTED]',
  'REDACTED',
  'UNKNOWN',
  'N/A',
  'NA',
  'NULL',
  'UNDEFINED',
  'PACIENTE',
  'CONTACTO SIN IDENTIFICAR'
]);

const STAGE_ORDER: Record<string, number> = {
  INBOUND_RECEIVED: 1,
  BUFFERED: 2,
  BATCH_CREATED: 3,
  ADAPTER_COMPLETED: 4,
  OUTBOX_CREATED: 5,
  CHATWOOT_SENT: 6,
  OUTGOING_ECHO_IGNORED: 7
};

export function parseAdminRange(value: unknown): AdminRange {
  return ADMIN_RANGES.includes(String(value) as AdminRange)
    ? String(value) as AdminRange
    : 'today';
}

export function getAdminRangeStart(range: AdminRange, now = new Date()): string | null {
  if (range === 'all') return null;
  if (range === '24h') return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  if (range === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Venezuela has used UTC-04:00 without DST since 2016. Constructing midnight
  // explicitly avoids coupling the dashboard's "today" filter to the host timezone.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value || '';
  return new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00-04:00`).toISOString();
}

export function isValidClinicalName(value: unknown): boolean {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  return normalized.length > 0 && !INVALID_NAME_VALUES.has(normalized.toUpperCase());
}

function joinName(firstName: unknown, lastName: unknown): string | null {
  const first = isValidClinicalName(firstName) ? String(firstName).trim() : '';
  const last = isValidClinicalName(lastName) ? String(lastName).trim() : '';
  const complete = [first, last].filter(Boolean).join(' ');
  return isValidClinicalName(complete) ? complete : null;
}

function maskPhone(phone: unknown): string | null {
  const value = String(phone ?? '').trim();
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(3, value.length - 5))}${value.slice(-2)}`;
}

function rowTimestamp(row: Row, ...columns: string[]): string | null {
  for (const column of columns) {
    if (row[column]) return String(row[column]);
  }
  return null;
}

function inRange(row: Row, start: string | null, ...columns: string[]): boolean {
  if (!start) return true;
  const timestamp = rowTimestamp(row, ...columns);
  return !!timestamp && new Date(timestamp).getTime() >= new Date(start).getTime();
}

function sameConversation(row: Row, tenantId: string, conversationId: string, contactId: string): boolean {
  return String(row.tenant_id ?? '') === tenantId
    && String(row.conversation_id ?? '') === conversationId
    && String(row.contact_id ?? '') === contactId;
}

function uniqueCount(rows: Row[], key: (row: Row) => unknown): number {
  return new Set(rows.map(key).filter(value => value !== undefined && value !== null && value !== '')).size;
}

function latest(rows: Row[]): Row | undefined {
  return [...rows].sort((a, b) => {
    const aTime = new Date(rowTimestamp(a, 'completed_at', 'finished_at', 'updated_at', 'created_at') || 0).getTime();
    const bTime = new Date(rowTimestamp(b, 'completed_at', 'finished_at', 'updated_at', 'created_at') || 0).getTime();
    return bTime - aTime;
  })[0];
}

function resolvePatientName(profile: Row | undefined, event: Row | undefined): {
  displayName: string;
  source: string;
} {
  const verifiedAdapterName = event?.identity_verified === true
    ? joinName(event.patient_first_name, event.patient_last_name)
    : null;
  if (verifiedAdapterName) return { displayName: verifiedAdapterName, source: 'verified_adapter_identity' };

  const profileName = joinName(profile?.first_name, profile?.last_name)
    || (isValidClinicalName(profile?.name) ? String(profile?.name).trim() : null);
  if (profileName) return { displayName: profileName, source: 'persisted_profile' };

  const adapterName = joinName(event?.patient_first_name, event?.patient_last_name)
    || (isValidClinicalName(event?.patient_display_name) ? String(event?.patient_display_name).trim() : null);
  if (adapterName) return { displayName: adapterName, source: 'adapter_payload' };

  return { displayName: 'N/A', source: 'unavailable' };
}

function isOutgoingEcho(log: Row): boolean {
  const searchable = JSON.stringify({
    event_type: log.event_type,
    route: log.route,
    metadata: log.metadata
  }).toLowerCase();
  return log.event_type === 'event_ignored'
    && (searchable.includes('outgoing') || searchable.includes('echo'));
}

function isBotEvent(log: Row): boolean {
  return JSON.stringify({ event_type: log.event_type, metadata: log.metadata })
    .toLowerCase()
    .includes('bot');
}

function isDuplicateLog(log: Row): boolean {
  return JSON.stringify({ event_type: log.event_type, metadata: log.metadata })
    .toLowerCase()
    .includes('duplicate');
}

function addTimelineEvent(target: Row[], event: Row): void {
  const dedupeKey = [
    event.stage,
    event.timestamp,
    event.batch_key,
    event.adapter_request_key,
    event.outbox_key,
    event.trace_id
  ].join('|');
  if (!target.some(item => item._dedupe_key === dedupeKey)) {
    target.push({ ...event, _dedupe_key: dedupeKey });
  }
}

function makeGroupKey(tenantId: string, accountId: string, conversationId: string, contactId: string): string {
  return [tenantId, accountId, conversationId, contactId].join('::');
}

export function buildAdminObservability(
  unfilteredSources: AdminObservabilitySources,
  options: BuildOptions
) {
  const now = options.now || new Date();
  const rangeStart = getAdminRangeStart(options.range, now);
  const sources: AdminObservabilitySources = {
    idempotency: unfilteredSources.idempotency.filter(row => inRange(row, rangeStart, 'processed_at', 'created_at')),
    inbound: unfilteredSources.inbound.filter(row => inRange(row, rangeStart, 'created_at')),
    batches: unfilteredSources.batches.filter(row => inRange(row, rangeStart, 'created_at')),
    outbox: unfilteredSources.outbox.filter(row => inRange(row, rangeStart, 'created_at')),
    executions: unfilteredSources.executions.filter(row => inRange(row, rangeStart, 'completed_at', 'created_at')),
    adapterEvents: unfilteredSources.adapterEvents.filter(row => inRange(row, rangeStart, 'completed_at', 'finished_at', 'created_at')),
    profiles: unfilteredSources.profiles,
    states: unfilteredSources.states,
    logs: unfilteredSources.logs.filter(row => inRange(row, rangeStart, 'created_at'))
  };

  const adapterDeduplicated = sources.adapterEvents.filter(row => row.idempotency_status === 'deduplicated');
  const duplicateLogs = sources.logs.filter(isDuplicateLog);
  const duplicateKeys = new Set([
    ...adapterDeduplicated.map(row => String(row.adapter_request_key || row.trace_id || row.id)),
    ...duplicateLogs.map(row => String(row.metadata?.message_id || row.trace_id || row.id))
  ]);
  const outgoingEchoes = sources.logs.filter(isOutgoingEcho);
  const botEvents = sources.logs.filter(row => isBotEvent(row) && !isOutgoingEcho(row));
  const ignoredWebhooks = sources.logs.filter(row =>
    row.event_type === 'event_ignored' && !isOutgoingEcho(row) && !isBotEvent(row)
  );

  const completedExecutions = sources.executions.filter(row => row.status === 'completed');
  const sentOutbox = sources.outbox.filter(row => row.status === 'sent');
  const processedBatches = sources.batches.filter(row => row.ai_status === 'completed');

  const webhookRows = [
    ...sources.idempotency,
    ...sources.logs.filter(row => ['webhook_received', 'event_ignored'].includes(row.event_type))
  ];
  const stats = {
    uniqueWebhooks: uniqueCount(webhookRows, row => row.message_id || row.metadata?.message_id),
    uniqueIncomingMessages: uniqueCount(sources.inbound, row => row.message_id || row.source_id),
    hermesCompleted: uniqueCount(completedExecutions, row => row.adapter_request_key || row.request_key || row.id),
    batchesProcessed: uniqueCount(processedBatches, row => row.batch_key),
    chatwootSent: uniqueCount(sentOutbox, row => row.outbox_key),
    outboxPending: uniqueCount(sources.outbox.filter(row => row.status === 'pending'), row => row.outbox_key),
    deliveryUnknown: uniqueCount(sources.outbox.filter(row => row.status === 'delivery_unknown'), row => row.outbox_key),
    adapterExecutionsNew: uniqueCount(sources.executions, row => row.adapter_request_key || row.request_key || row.id),
    adapterExecutionsDeduplicated: uniqueCount(adapterDeduplicated, row => row.adapter_request_key || row.trace_id || row.id),
    hermesRequestsReal: uniqueCount(
      sources.adapterEvents.filter(row => row.idempotency_status === 'new'),
      row => row.adapter_request_key || row.trace_id || row.id
    ),
    outgoingEchoes: uniqueCount(outgoingEchoes, row => row.metadata?.message_id || row.trace_id || row.id),
    botEvents: uniqueCount(botEvents, row => row.metadata?.message_id || row.trace_id || row.id),
    ignoredWebhooks: uniqueCount(ignoredWebhooks, row => row.metadata?.message_id || row.trace_id || row.id),
    duplicatesPrevented: duplicateKeys.size
  };

  const batchByKey = new Map(sources.batches.map(row => [String(row.batch_key), row]));
  const batchByRequest = new Map(
    sources.batches
      .filter(row => row.adapter_request_key)
      .map(row => [String(row.adapter_request_key), row])
  );
  const outboxByRequest = new Map(
    sources.outbox
      .filter(row => row.adapter_request_key)
      .map(row => [String(row.adapter_request_key), row])
  );
  const groups = new Map<string, Row>();

  const ensureGroup = (row: Row): Row | null => {
    const linkedBatch = batchByKey.get(String(row.batch_key || ''))
      || batchByRequest.get(String(row.adapter_request_key || row.request_key || ''));
    const linkedOutbox = outboxByRequest.get(String(row.adapter_request_key || row.request_key || ''));
    const tenantId = String(row.tenant_id || linkedBatch?.tenant_id || linkedOutbox?.tenant_id || '');
    const accountId = String(row.account_id || linkedBatch?.account_id || linkedOutbox?.account_id || '');
    const conversationId = String(row.conversation_id || linkedBatch?.conversation_id || linkedOutbox?.conversation_id || '');
    const contactId = String(row.contact_id || linkedBatch?.contact_id || linkedOutbox?.contact_id || '');
    if (!tenantId || !accountId || !conversationId || !contactId || tenantId !== options.tenantId) return null;
    const groupKey = makeGroupKey(tenantId, accountId, conversationId, contactId);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        group_key: groupKey,
        tenant_id: tenantId,
        account_id: accountId,
        conversation_id: conversationId,
        contact_id: contactId,
        hermes_profile: row.hermes_profile || linkedBatch?.hermes_profile || null,
        timeline: [],
        _rows: []
      });
    }
    const group = groups.get(groupKey)!;
    group.hermes_profile ||= row.hermes_profile || linkedBatch?.hermes_profile || null;
    group._rows.push(row);
    return group;
  };

  [...sources.batches, ...sources.outbox, ...sources.executions, ...sources.adapterEvents]
    .forEach(ensureGroup);

  for (const group of groups.values()) {
    const tenantId = group.tenant_id;
    const conversationId = group.conversation_id;
    const contactId = group.contact_id;
    const groupBatches = sources.batches.filter(row => sameConversation(row, tenantId, conversationId, contactId)
      && String(row.account_id) === group.account_id);
    const batchKeys = new Set(groupBatches.map(row => String(row.batch_key)));
    const requestKeys = new Set(groupBatches.map(row => String(row.adapter_request_key || '')).filter(Boolean));
    const groupOutbox = sources.outbox.filter(row => sameConversation(row, tenantId, conversationId, contactId)
      && String(row.account_id) === group.account_id);
    groupOutbox.forEach(row => requestKeys.add(String(row.adapter_request_key || '')));
    const groupExecutions = sources.executions.filter(row =>
      sameConversation(row, tenantId, conversationId, contactId)
      && (!row.account_id || String(row.account_id) === group.account_id)
      && (!row.adapter_request_key || requestKeys.has(String(row.adapter_request_key)))
    );
    const groupAdapterEvents = sources.adapterEvents.filter(row =>
      sameConversation(row, tenantId, conversationId, contactId)
      && (!row.account_id || String(row.account_id) === group.account_id)
      && (!row.adapter_request_key || requestKeys.has(String(row.adapter_request_key)))
    );
    const groupInbound = sources.inbound.filter(row => sameConversation(row, tenantId, conversationId, contactId));
    const groupLogs = sources.logs.filter(row => sameConversation(row, tenantId, conversationId, contactId));
    const profile = latest(sources.profiles.filter(row =>
      String(row.tenant_id) === tenantId && String(row.contact_id) === contactId
    ));
    const state = latest(sources.states.filter(row => sameConversation(row, tenantId, conversationId, contactId)));
    const adapterEvent = latest(groupAdapterEvents.filter(row =>
      row.status === 'completed' || row.response_returned === true
    )) || latest(groupAdapterEvents);

    for (const row of groupInbound) {
      addTimelineEvent(group.timeline, {
        stage: 'INBOUND_RECEIVED',
        timestamp: row.created_at,
        trace_id: row.trace_id,
        chatwoot_message_id: row.message_id,
        source_message_id: row.source_id
      });
      addTimelineEvent(group.timeline, {
        stage: 'BUFFERED',
        timestamp: row.processing_started_at || row.created_at,
        trace_id: row.trace_id,
        chatwoot_message_id: row.message_id,
        source_message_id: row.source_id
      });
    }
    for (const row of groupBatches) {
      addTimelineEvent(group.timeline, {
        stage: 'BATCH_CREATED',
        timestamp: row.created_at,
        trace_id: row.trace_id,
        batch_key: row.batch_key,
        adapter_request_key: row.adapter_request_key,
        ai_status: row.ai_status
      });
    }
    const completedByRequest = new Set<string>();
    for (const row of [...groupExecutions, ...groupAdapterEvents]) {
      if (row.status !== 'completed') continue;
      const requestKey = String(row.adapter_request_key || row.request_key || row.trace_id || row.id);
      if (completedByRequest.has(requestKey)) continue;
      completedByRequest.add(requestKey);
      addTimelineEvent(group.timeline, {
        stage: 'ADAPTER_COMPLETED',
        timestamp: row.completed_at || row.finished_at || row.created_at,
        trace_id: row.trace_id,
        adapter_request_key: row.adapter_request_key || row.request_key,
        hermes_conversation_id: row.hermes_conversation_id,
        hermes_response_id: row.hermes_response_id,
        duration_ms: row.duration_ms,
        total_tokens: row.total_tokens
      });
    }
    for (const row of groupOutbox) {
      addTimelineEvent(group.timeline, {
        stage: 'OUTBOX_CREATED',
        timestamp: row.created_at,
        batch_key: row.batch_key,
        adapter_request_key: row.adapter_request_key,
        outbox_key: row.outbox_key
      });
      if (row.status === 'sent') {
        addTimelineEvent(group.timeline, {
          stage: 'CHATWOOT_SENT',
          timestamp: row.sent_at || row.updated_at,
          batch_key: row.batch_key,
          adapter_request_key: row.adapter_request_key,
          outbox_key: row.outbox_key,
          chatwoot_outbound_message_id: row.chatwoot_outbound_message_id,
          http_status: row.http_status
        });
      }
    }
    for (const row of groupLogs.filter(isOutgoingEcho)) {
      addTimelineEvent(group.timeline, {
        stage: 'OUTGOING_ECHO_IGNORED',
        timestamp: row.created_at,
        trace_id: row.trace_id,
        source_message_id: row.metadata?.message_id,
        secondary: true
      });
    }

    group.timeline.sort((a: Row, b: Row) => {
      const stageDiff = (STAGE_ORDER[a.stage] || 99) - (STAGE_ORDER[b.stage] || 99);
      if (stageDiff !== 0) return stageDiff;
      return new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
    });
    group.timeline = group.timeline.map(({ _dedupe_key, ...event }: Row) => event);

    const sent = groupOutbox.some(row => row.status === 'sent');
    const completed = groupExecutions.some(row => row.status === 'completed')
      || groupAdapterEvents.some(row => row.status === 'completed');
    const failed = groupBatches.some(row => row.ai_status === 'failed')
      || groupOutbox.some(row => ['failed_recoverable', 'failed_final', 'delivery_unknown'].includes(row.status));
    group.status = sent ? 'SENT' : completed ? 'COMPLETED' : failed ? 'ERROR' : 'PROCESSING';

    const name = resolvePatientName(profile, adapterEvent);
    const rawPhone = adapterEvent?.patient_phone || adapterEvent?.phone || profile?.phone || null;
    const rawInbound = adapterEvent?.message_content || adapterEvent?.input_message
      || latest(groupInbound)?.body || null;
    const rawResponse = adapterEvent?.response_content || adapterEvent?.reply_text
      || latest(groupOutbox)?.content || null;

    group.patient_name = options.showPii ? name.displayName : null;
    group.patient_name_source = name.source;
    group.phone = options.showPii ? rawPhone : maskPhone(rawPhone);
    group.inbound_message = options.showPii ? rawInbound : null;
    group.hermes_response = options.showPii ? rawResponse : null;
    group.profile_complete = profile?.profile_complete === true;
    group.state = state ? {
      status: state.status,
      pending_question: state.pending_question,
      pending_intent: state.pending_intent
    } : null;
    group.batch_keys = groupBatches.map(row => row.batch_key);
    group.adapter_request_keys = [...requestKeys].filter(Boolean);
    group.outbox_keys = groupOutbox.map(row => row.outbox_key);
    group.hermes_conversation_id = adapterEvent?.hermes_conversation_id
      || latest(groupExecutions)?.hermes_conversation_id
      || null;
    group.hermes_response_id = adapterEvent?.hermes_response_id
      || latest(groupExecutions)?.hermes_response_id
      || null;
    group.last_timestamp = latest([
      ...groupInbound,
      ...groupBatches,
      ...groupOutbox,
      ...groupExecutions,
      ...groupAdapterEvents
    ]) ? rowTimestamp(latest([
      ...groupInbound,
      ...groupBatches,
      ...groupOutbox,
      ...groupExecutions,
      ...groupAdapterEvents
    ])!, 'completed_at', 'finished_at', 'sent_at', 'updated_at', 'created_at') : null;
    delete group._rows;
  }

  return {
    range: options.range,
    range_start: rangeStart,
    generated_at: now.toISOString(),
    stats,
    conversations: [...groups.values()].sort((a, b) =>
      new Date(b.last_timestamp || 0).getTime() - new Date(a.last_timestamp || 0).getTime()
    )
  };
}

interface SourceResult {
  data: Row[];
  available: boolean;
}

async function readAdminSource(
  client: any,
  table: string,
  tenantId: string,
  rangeStart: string | null,
  timestampColumn: string | null,
  orderColumn: string
): Promise<SourceResult> {
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    let query = client
      .from(table)
      .select('*')
      .eq('tenant_id', tenantId)
      .order(orderColumn, { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (rangeStart && timestampColumn) query = query.gte(timestampColumn, rangeStart);
    const { data, error } = await query;
    if (error) return { data: [], available: false };
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { data: rows, available: true };
}

export async function loadAdminObservability(
  client: any,
  options: BuildOptions
) {
  const rangeStart = getAdminRangeStart(options.range, options.now);
  const definitions: Array<[keyof AdminObservabilitySources, string, string | null, string]> = [
    ['idempotency', 'helios_message_idempotency', 'processed_at', 'processed_at'],
    ['inbound', 'helios_inbound_buffer', 'created_at', 'created_at'],
    ['batches', 'helios_processing_batches', 'created_at', 'created_at'],
    ['outbox', 'helios_chatwoot_outbox', 'created_at', 'created_at'],
    ['executions', 'helios_adapter_executions', 'created_at', 'created_at'],
    ['adapterEvents', 'helios_adapter_events', 'created_at', 'created_at'],
    ['profiles', 'helios_patient_profiles', null, 'updated_at'],
    ['states', 'helios_conversation_state', null, 'updated_at'],
    ['logs', 'helios_gateway_logs', 'created_at', 'created_at']
  ];
  const results = await Promise.all(definitions.map(([, table, timestamp, orderColumn]) =>
    readAdminSource(client, table, options.tenantId, rangeStart, timestamp, orderColumn)
  ));
  const sources = {} as AdminObservabilitySources;
  const availability: Record<string, boolean> = {};
  definitions.forEach(([key, table], index) => {
    sources[key] = results[index].data;
    availability[table] = results[index].available;
  });

  return {
    ...buildAdminObservability(sources, options),
    sources: availability
  };
}

import crypto from 'crypto';

function normalized(value: unknown): string {
  return String(value ?? '').trim();
}

function stableHash(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

export interface BatchIdentityInput {
  tenant_id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  source_message_ids: Array<string | number>;
}

export function createBatchIdentity(input: BatchIdentityInput) {
  const sourceIds = [...new Set(input.source_message_ids.map(normalized).filter(Boolean))].sort();
  if (sourceIds.length === 0) {
    throw new Error('BATCH_SOURCE_MESSAGE_IDS_REQUIRED');
  }
  const sourceMessageIdsHash = stableHash(sourceIds);
  const batchKey = `batch-${stableHash([
    `tenant:${normalized(input.tenant_id)}`,
    `account:${normalized(input.account_id)}`,
    `conversation:${normalized(input.conversation_id)}`,
    `contact:${normalized(input.contact_id)}`,
    `messages:${sourceMessageIdsHash}`
  ])}`;
  return {
    batch_key: batchKey,
    source_message_ids_hash: sourceMessageIdsHash,
    source_message_count: sourceIds.length
  };
}

export function createOutboxIdentity(input: {
  tenant_id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  source_message_ids_hash: string;
  content: string;
}) {
  const contentHash = stableHash([input.content]);
  return {
    content_hash: contentHash,
    outbox_key: `outbox-${stableHash([
      `tenant:${normalized(input.tenant_id)}`,
      `account:${normalized(input.account_id)}`,
      `conversation:${normalized(input.conversation_id)}`,
      `contact:${normalized(input.contact_id)}`,
      `messages:${normalized(input.source_message_ids_hash)}`,
      `content:${contentHash}`
    ])}`
  };
}

/**
 * Identidad determinista del handoff.
 *
 * El handoff_id se deriva del disparador, no de randomUUID(): el mismo lote o
 * la misma señal de Chatwoot producen siempre el mismo handoff_id, de modo que
 * el índice único de helios_handoff_events absorbe los duplicados sin
 * necesidad de un lock. Tres webhooks repetidos dejan una sola nota y una sola
 * alerta (ítem 24).
 */
export function createHandoffIdentity(input: {
  tenant_id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  trigger_key: string;
}) {
  const hash = stableHash([
    `tenant:${normalized(input.tenant_id)}`,
    `account:${normalized(input.account_id)}`,
    `conversation:${normalized(input.conversation_id)}`,
    `contact:${normalized(input.contact_id)}`,
    `trigger:${normalized(input.trigger_key)}`
  ]);
  return {
    handoff_id: formatAsUuid(hash),
    handoff_fingerprint: hash.slice(0, 12)
  };
}

/**
 * Presenta un hash de 256 bits como UUID válido para la columna uuid de
 * Postgres, fijando los nibbles de versión (8, UUID de nombre personalizado) y
 * de variante para que sea un identificador bien formado.
 */
function formatAsUuid(hash: string): string {
  const hex = hash.slice(0, 32).split('');
  hex[12] = '8';
  const variantNibble = parseInt(hex[16], 16);
  hex[16] = ((variantNibble & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32)
  ].join('-');
}

export function shortFingerprint(value: unknown): string {
  return stableHash([normalized(value)]).slice(0, 12);
}


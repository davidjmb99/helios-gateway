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

export function shortFingerprint(value: unknown): string {
  return stableHash([normalized(value)]).slice(0, 12);
}


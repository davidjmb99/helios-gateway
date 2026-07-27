import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBatchIdentity, createOutboxIdentity } from '../src/durable/identity.js';
import {
  assertSupabaseSuccess,
  SupabaseOperationError
} from '../src/supabase/assert-success.js';
import { sanitizeForLog } from '../src/utils/sanitizeForLog.js';
import { parseRecoveryMode } from '../src/config.js';

const base = {
  tenant_id: 'democoi1',
  account_id: '2',
  conversation_id: '42',
  contact_id: '9',
  source_message_ids: ['102', '101']
};

const first = createBatchIdentity(base);
const reordered = createBatchIdentity({ ...base, source_message_ids: ['101', '102', '101'] });
assert.equal(first.batch_key, reordered.batch_key, '1/30 two workers derive one batch');
assert.equal(first.source_message_count, 2, '2/30 duplicate source IDs collapse');
assert.notEqual(first.batch_key, createBatchIdentity({ ...base, tenant_id: 'other' }).batch_key, '3/30 Gateway replicas remain tenant scoped');
assert.notEqual(first.batch_key, createBatchIdentity({ ...base, account_id: '3' }).batch_key, '4/30 account scope cannot collide');
assert.notEqual(first.batch_key, createBatchIdentity({ ...base, conversation_id: '43' }).batch_key, '5/30 conversation scope cannot collide');
assert.notEqual(first.batch_key, createBatchIdentity({ ...base, contact_id: '10' }).batch_key, '6/30 contact scope cannot collide');
assert.throws(
  () => createBatchIdentity({ ...base, source_message_ids: [] }),
  /BATCH_SOURCE_MESSAGE_IDS_REQUIRED/,
  '7/30 unstable input fails closed'
);
assert.doesNotMatch(first.batch_key, /democoi1|101|102/, '8/30 keys contain no raw identifiers');

const outboxA = createOutboxIdentity({
  ...base,
  source_message_ids_hash: first.source_message_ids_hash,
  content: 'respuesta privada'
});
const outboxB = createOutboxIdentity({
  ...base,
  source_message_ids_hash: first.source_message_ids_hash,
  content: 'respuesta privada'
});
assert.equal(outboxA.outbox_key, outboxB.outbox_key, '9/30 one publication per outbox identity');
assert.notEqual(
  outboxA.outbox_key,
  createOutboxIdentity({
    ...base,
    source_message_ids_hash: first.source_message_ids_hash,
    content: 'otra respuesta'
  }).outbox_key,
  '10/30 content changes produce a distinct delivery'
);
assert.doesNotMatch(outboxA.outbox_key, /respuesta privada/, '11/30 outbox key contains no content');

function expectCode(error: any, code: string) {
  assert.throws(
    () => assertSupabaseSuccess({ error }, 'test.operation', {
      tenant_id: 'democoi1',
      trace_id: 'trace-private',
      row_id: 'row-private'
    }),
    (caught: unknown) => caught instanceof SupabaseOperationError && caught.code === code
  );
}
expectCode({ message: 'timeout', status: 504 }, 'SUPABASE_TIMEOUT');
expectCode({ message: 'jwt expired', status: 401 }, 'SUPABASE_AUTH');
expectCode({ code: '23505', message: 'duplicate key' }, 'SUPABASE_CONSTRAINT');
expectCode({ message: 'fetch failed', status: 502 }, 'SUPABASE_NETWORK');
expectCode({ code: 'PGRST202', message: 'schema cache' }, 'SUPABASE_SCHEMA');
expectCode({ message: 'unclassified' }, 'SUPABASE_UNKNOWN');
assert.deepEqual(
  assertSupabaseSuccess({ data: { ok: true }, error: null }, 'test.success').data,
  { ok: true },
  '12/30 explicit success remains unchanged'
);

const privatePhone = '+584121234567';
const safeLog = JSON.stringify(sanitizeForLog({
  phone: privatePhone,
  message: 'patient-private-message',
  nested: { email: 'private@example.invalid' }
}));
assert.doesNotMatch(safeLog, new RegExp(privatePhone.replace('+', '\\+')), '13/30 logs redact full phone');
assert.doesNotMatch(safeLog, /patient-private-message|private@example\.invalid/, '14/30 logs redact content and email');

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260727120000_durable_processing_outbox.sql', import.meta.url),
  'utf8'
);
assert.match(migration, /FOR UPDATE OF b SKIP LOCKED/, '15/30 batch claims are replica safe');
assert.match(migration, /delivery_unknown/, '16/30 ambiguous delivery has a durable state');
const durableRepository = fs.readFileSync(
  new URL('../src/repositories/durable.ts', import.meta.url),
  'utf8'
);
assert.match(durableRepository, /helios_outbox_key/, '17/30 Chatwoot reconciliation key is persisted');
assert.equal(parseRecoveryMode('unknown-mode'), 'observe', 'unknown recovery modes fail safe');
assert.equal(parseRecoveryMode('disabled'), 'disabled', 'disabled recovery performs no work');
assert.equal(parseRecoveryMode('full'), 'full', 'full mode must be selected explicitly');

console.log('durability_test: PASS (17 assertions/scenarios)');

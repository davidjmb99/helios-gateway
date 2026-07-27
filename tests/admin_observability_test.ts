import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildAdminObservability,
  isValidClinicalName,
  type AdminObservabilitySources
} from '../src/admin/observability.js';
import { sanitizeForLog } from '../src/utils/sanitizeForLog.js';

const fixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/admin_observability_controlled.json', import.meta.url),
  'utf8'
)) as AdminObservabilitySources;
const now = new Date('2026-07-27T20:00:00.000Z');

const pii = buildAdminObservability(fixture, {
  tenantId: 'democoi1',
  showPii: true,
  range: 'today',
  now
});
const conversation = pii.conversations[0];

assert.equal(conversation.patient_name, 'Ana Clínica', '1/10 admin PII true shows the complete clinical name');
assert.equal(conversation.phone, '+580000000001', '1/10 admin PII true shows the complete phone');
assert.equal(conversation.inbound_message, 'Mensaje clínico completo de prueba', '1/10 admin PII true shows inbound content');
assert.equal(conversation.hermes_response, 'Respuesta Hermes completa de prueba', '1/10 admin PII true shows Hermes content');

const hidden = buildAdminObservability(fixture, {
  tenantId: 'democoi1',
  showPii: false,
  range: 'today',
  now
}).conversations[0];
assert.equal(hidden.patient_name, null, '2/10 admin PII false hides the name');
assert.notEqual(hidden.phone, '+580000000001', '2/10 admin PII false hides the complete phone');
assert.equal(hidden.inbound_message, null, '2/10 admin PII false hides inbound content');
assert.equal(hidden.hermes_response, null, '2/10 admin PII false hides Hermes content');

const safeLog = JSON.stringify(sanitizeForLog({
  first_name: 'Ana',
  last_name: 'Clínica',
  phone: '+580000000001',
  body: 'Mensaje clínico completo de prueba',
  reply: 'Respuesta Hermes completa de prueba'
}));
assert.doesNotMatch(safeLog, /Ana|Clínica|\+580000000001|Mensaje clínico|Respuesta Hermes/, '3/10 server logs remain sanitized');

assert.equal(conversation.status, 'SENT', '4/10 outgoing ignored cannot replace SENT');
assert.equal(conversation.timeline.at(-1)?.stage, 'OUTGOING_ECHO_IGNORED', '4/10 outgoing echo remains a secondary timeline event');
assert.equal(conversation.timeline.at(-1)?.secondary, true, '4/10 outgoing echo is explicitly secondary');

assert.deepEqual(
  conversation.timeline.map((event: any) => event.stage),
  ['INBOUND_RECEIVED', 'BUFFERED', 'BATCH_CREATED', 'ADAPTER_COMPLETED', 'OUTBOX_CREATED', 'CHATWOOT_SENT', 'OUTGOING_ECHO_IGNORED'],
  '5/10 a conversation exposes the complete ordered timeline'
);

assert.equal(pii.stats.uniqueWebhooks, 2, '6/10 today counts unique inbound/echo webhooks and excludes historical rows');
assert.equal(pii.stats.uniqueIncomingMessages, 1, '6/10 today excludes historical incoming messages');

assert.equal(pii.stats.batchesProcessed, 1, '7/10 one batch produces one processed');
assert.equal(pii.stats.chatwootSent, 1, '7/10 one batch produces one sent');

const secondTenant: AdminObservabilitySources = JSON.parse(JSON.stringify(fixture));
for (const rows of Object.values(secondTenant)) {
  for (const row of rows) {
    row.tenant_id = 'another-tenant';
    if (row.account_id) row.account_id = '9';
  }
}
const mixed: AdminObservabilitySources = Object.fromEntries(
  Object.keys(fixture).map(key => [
    key,
    [...(fixture as any)[key], ...(secondTenant as any)[key]]
  ])
) as unknown as AdminObservabilitySources;
const tenantA = buildAdminObservability(mixed, {
  tenantId: 'democoi1',
  showPii: true,
  range: 'today',
  now
});
const tenantB = buildAdminObservability(mixed, {
  tenantId: 'another-tenant',
  showPii: true,
  range: 'today',
  now
});
assert.equal(tenantA.conversations.length, 1, '8/10 tenant A has only its conversation');
assert.equal(tenantB.conversations.length, 1, '8/10 tenant B has only its conversation');
assert.notEqual(tenantA.conversations[0].group_key, tenantB.conversations[0].group_key, '8/10 tenant/account are part of the grouping key');

assert.equal(isValidClinicalName('[REDACTED]'), false, '9/10 REDACTED is not a valid name');
assert.equal(isValidClinicalName('UNKNOWN'), false, '9/10 UNKNOWN is not a valid name');
assert.equal(isValidClinicalName('N/A'), false, '9/10 N/A is not a valid name');
assert.notEqual(conversation.patient_name, '[REDACTED]', '9/10 a redacted profile cannot override Adapter identity');

const withoutLogs = buildAdminObservability({ ...fixture, logs: [] }, {
  tenantId: 'democoi1',
  showPii: true,
  range: 'today',
  now
}).conversations[0];
assert.equal(withoutLogs.status, 'SENT', '10/10 dashboard works with incomplete debug logs');
assert.deepEqual(
  withoutLogs.timeline.map((event: any) => event.stage),
  ['INBOUND_RECEIVED', 'BUFFERED', 'BATCH_CREATED', 'ADAPTER_COMPLETED', 'OUTBOX_CREATED', 'CHATWOOT_SENT'],
  '10/10 durable timeline does not depend on debug logs'
);

console.log('admin_observability_test: PASS (10 required scenarios)');

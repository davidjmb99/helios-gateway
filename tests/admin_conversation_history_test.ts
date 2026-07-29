import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  assertConversationHistoryAccountAccess,
  buildAdminConversationHistory,
  decodeConversationHistoryCursor,
  loadAdminConversationHistory,
  MAX_CONVERSATION_HISTORY_LIMIT,
  parseConversationHistoryLimit,
  type ConversationHistorySources
} from '../src/admin/conversation-history.js';
import { sanitizeForLog } from '../src/utils/sanitizeForLog.js';

const baseTime = new Date('2026-07-29T15:00:00.000Z').getTime();
const atMinute = (minute: number) => new Date(baseTime + minute * 60_000).toISOString();

function buildSources(turnCount = 4): ConversationHistorySources {
  const inbound = [];
  const outbox = [];
  const adapterEvents = [];
  const batches = [];
  for (let turn = 1; turn <= turnCount; turn += 1) {
    const traceId = `trace-${turn}`;
    const requestKey = `request-${turn}`;
    const batchKey = `batch-${turn}`;
    inbound.push({
      id: turn,
      tenant_id: 'democoi1',
      conversation_id: '35',
      contact_id: '10',
      inbox_id: '7',
      message_id: String(570 + turn),
      source_id: `source-${turn}`,
      body: turn <= 2 ? 'Mensaje repetido' : `Entrada ${turn}`,
      direction: 'incoming',
      trace_id: traceId,
      response_idempotency_key: traceId,
      created_at: atMinute(turn * 2)
    });
    adapterEvents.push({
      tenant_id: 'democoi1',
      account_id: '2',
      conversation_id: '35',
      contact_id: '10',
      trace_id: traceId,
      request_key: requestKey,
      response_content: `Respuesta generada ${turn}`,
      system_prompt: 'NO MOSTRAR',
      tool_result: 'NO MOSTRAR',
      created_at: atMinute(turn * 2 + 1)
    });
    batches.push({
      tenant_id: 'democoi1',
      account_id: '2',
      conversation_id: '35',
      contact_id: '10',
      batch_key: batchKey,
      adapter_request_key: requestKey,
      created_at: atMinute(turn * 2 + 1)
    });
    outbox.push({
      tenant_id: 'democoi1',
      account_id: '2',
      conversation_id: '35',
      contact_id: '10',
      outbox_key: `outbox-${turn}`,
      batch_key: batchKey,
      adapter_request_key: requestKey,
      content: `Salida ${turn}`,
      status: 'sent',
      chatwoot_outbound_message_id: `outbound-${turn}`,
      sent_at: atMinute(turn * 2 + 1)
    });
  }
  return { inbound, outbox, adapterEvents, batches };
}

const options = {
  tenantId: 'democoi1',
  accountId: '2',
  conversationId: '35',
  contactId: '10',
  showPii: true
};
const sources = buildSources();
const history = buildAdminConversationHistory(sources, options);

assert.equal(history.messages.length, 8, '5/25 four inbound plus four sent outbox rows produce eight messages');
assert.deepEqual(
  history.messages.map(message => message.timestamp),
  [...history.messages.map(message => message.timestamp)].sort(),
  '14/25 response is chronological ascending'
);
assert.equal(
  history.messages.filter(message => message.text === 'Mensaje repetido').length,
  2,
  '8/25 identical text with different message IDs remains visible'
);
assert.equal(
  history.messages.filter(message => message.direction === 'outgoing').length,
  4,
  '9/25 Adapter response fields never create an extra outgoing bubble'
);
assert.equal(
  history.messages.every(message => message.turn_key.startsWith('batch_key:')),
  true,
  'turn correlation prefers batch_key over request and trace'
);
assert.doesNotMatch(
  JSON.stringify(history),
  /NO MOSTRAR|system_prompt|tool_result|Respuesta generada/,
  '13/25 prompts, tool results and generated-only responses are excluded'
);

const hidden = buildAdminConversationHistory(sources, { ...options, showPii: false });
assert.equal(hidden.messages.every(message => message.text === null), true, '2/25 PII false hides message text');
assert.doesNotMatch(
  JSON.stringify(sanitizeForLog({ phone: '+580000000001', body: 'Mensaje privado' })),
  /\+580000000001|Mensaje privado/,
  '3/25 logs stay masked independently from admin PII'
);

const excludedOutboxSources = buildSources(1);
excludedOutboxSources.outbox.push(
  {
    ...excludedOutboxSources.outbox[0],
    outbox_key: 'outbox-pending',
    status: 'pending',
    chatwoot_outbound_message_id: null
  },
  {
    ...excludedOutboxSources.outbox[0],
    outbox_key: 'outbox-failed',
    status: 'failed_final'
  },
  {
    ...excludedOutboxSources.outbox[0],
    outbox_key: 'outbox-no-id',
    chatwoot_outbound_message_id: null
  }
);
const excludedHistory = buildAdminConversationHistory(excludedOutboxSources, options);
assert.equal(
  excludedHistory.messages.some(message => message.message_key === 'outgoing:outbox-pending'),
  false,
  '10/25 pending outbox is excluded'
);
assert.equal(
  excludedHistory.messages.some(message => message.message_key === 'outgoing:outbox-failed'),
  false,
  '11/25 failed outbox is excluded'
);
assert.equal(
  excludedHistory.messages.some(message => message.message_key === 'outgoing:outbox-no-id'),
  false,
  '12/25 sent outbox without outbound ID is excluded'
);

const firstPage = buildAdminConversationHistory(sources, { ...options, limit: 3 });
const repeatedFirstPage = buildAdminConversationHistory(sources, { ...options, limit: 3 });
assert.ok(firstPage.next_cursor, '15/25 a partial page returns a cursor');
assert.equal(firstPage.next_cursor, repeatedFirstPage.next_cursor, '15/25 cursor is stable for the same page');
assert.equal(decodeConversationHistoryCursor(firstPage.next_cursor).version, 1, '15/25 cursor is opaque but valid');
const secondPage = buildAdminConversationHistory(sources, {
  ...options,
  limit: 3,
  cursor: firstPage.next_cursor
});
assert.equal(
  firstPage.messages.some(first =>
    secondPage.messages.some(second => second.message_key === first.message_key)
  ),
  false,
  '15/25 cursor pages do not overlap'
);
const equalTimestampSources = buildSources(1);
equalTimestampSources.outbox = [];
equalTimestampSources.inbound = [
  { ...equalTimestampSources.inbound[0], id: 9, message_id: 'equal-9' },
  { ...equalTimestampSources.inbound[0], id: 10, message_id: 'equal-10' }
];
const equalTimestampFirst = buildAdminConversationHistory(equalTimestampSources, { ...options, limit: 1 });
const equalTimestampSecond = buildAdminConversationHistory(equalTimestampSources, {
  ...options,
  limit: 1,
  cursor: equalTimestampFirst.next_cursor
});
assert.deepEqual(
  [
    equalTimestampFirst.messages[0]?.message_key,
    equalTimestampSecond.messages[0]?.message_key
  ].sort(),
  ['incoming:equal-10', 'incoming:equal-9'].sort(),
  '15/25 cursor remains lossless when numeric IDs share a timestamp'
);
assert.equal(parseConversationHistoryLimit(undefined), 100, '16/25 default limit is 100');
assert.equal(parseConversationHistoryLimit(999), MAX_CONVERSATION_HISTORY_LIMIT, '17/25 limit is capped at 200');

const mixedSources = buildSources(1);
mixedSources.inbound.push(
  { ...mixedSources.inbound[0], id: 90, tenant_id: 'other-tenant', message_id: 'tenant-leak' },
  { ...mixedSources.inbound[0], id: 91, contact_id: '99', message_id: 'contact-leak' }
);
mixedSources.outbox.push(
  { ...mixedSources.outbox[0], outbox_key: 'account-leak', account_id: '9' },
  { ...mixedSources.outbox[0], outbox_key: 'contact-outbox-leak', contact_id: '99' }
);
const isolated = buildAdminConversationHistory(mixedSources, options);
assert.equal(isolated.messages.some(message => message.message_key.includes('tenant-leak')), false, '18/25 tenant isolation');
assert.equal(isolated.messages.some(message => message.message_key.includes('account-leak')), false, '19/25 account isolation');
assert.equal(isolated.messages.some(message => message.message_key.includes('contact-leak')), false, '20/25 contact isolation');
assert.throws(
  () => assertConversationHistoryAccountAccess('democoi1', { tenant_id: 'other-tenant', account_id: '9' }),
  /account is not available/,
  '18/25 a mapped account from another tenant is forbidden'
);

class FakeQuery {
  constructor(private readonly rows: any[]) {}
  select() { return this; }
  eq() { return this; }
  not() { return this; }
  order() { return this; }
  limit() { return this; }
  or() { return this; }
  in() { return this; }
  then(resolve: (value: any) => any, reject?: (reason: any) => any) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve, reject);
  }
}

function fakeClient(fixture: ConversationHistorySources) {
  const calls: string[] = [];
  const rowsByTable: Record<string, any[]> = {
    helios_inbound_buffer: fixture.inbound,
    helios_chatwoot_outbox: fixture.outbox,
    helios_adapter_events: fixture.adapterEvents,
    helios_processing_batches: fixture.batches
  };
  return {
    calls,
    from(table: string) {
      calls.push(table);
      return new FakeQuery(rowsByTable[table] || []);
    }
  };
}

const smallClient = fakeClient(buildSources(1));
await loadAdminConversationHistory(smallClient, options);
const smallQueryCount = smallClient.calls.length;
const largeClient = fakeClient(buildSources(40));
await loadAdminConversationHistory(largeClient, options);
assert.equal(largeClient.calls.length, smallQueryCount, '21/25 query count is constant and has no N+1 growth');
assert.ok(smallQueryCount <= 5, '21/25 history uses at most five bounded source queries');

async function unusedLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function verifyUnauthorizedRequest(): Promise<void> {
  const port = await unusedLocalPort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      CHATWOOT_TENANT_CONTEXTS_JSON: JSON.stringify({
        '2': {
          tenant_id: 'democoi1',
          clinic_id: 'coi_demo',
          hermes_profile: 'helios'
        }
      })
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    const deadline = Date.now() + 8_000;
    let response: Response | null = null;
    while (Date.now() < deadline) {
      try {
        response = await fetch(
          `http://127.0.0.1:${port}/admin/conversations/35/messages?account_id=2&contact_id=10`
        );
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    assert.ok(response, `Gateway test server did not start: ${stderr}`);
    assert.equal(response.status, 401, '4/25 history endpoint rejects requests without a token');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2_000))
    ]);
  }
}

await verifyUnauthorizedRequest();

console.log('admin_conversation_history_test: PASS (25 required behaviors)');

import assert from 'node:assert/strict';
import {
  classifyProcessingFailure,
  isTerminalProcessingBatch
} from '../src/orchestrator.js';
import { markClaimedBufferMessagesProcessed } from '../src/repositories/database.js';
import { SupabaseOperationError } from '../src/supabase/assert-success.js';

type Row = {
  id: number;
  processed_at: string | null;
  processing_started_at: string | null;
  next_retry_at: string | null;
  last_error_code: string | null;
  failed_at: string | null;
  retry_count: number;
  response_idempotency_key: string | null;
};

class UpdateQuery {
  private ids: number[] | null = null;
  private exactId: number | null = null;

  constructor(private rows: Row[], private patch: Partial<Row>) {}

  in(column: string, values: number[]) {
    assert.equal(column, 'id');
    this.ids = values;
    return this;
  }

  eq(column: string, value: number) {
    assert.equal(column, 'id');
    this.exactId = value;
    return this;
  }

  select() {
    const selected = this.rows.filter(row =>
      (!this.ids || this.ids.includes(row.id))
      && (this.exactId === null || row.id === this.exactId)
    );
    selected.forEach(row => Object.assign(row, this.patch));
    return Promise.resolve({ data: selected.map(row => ({ id: row.id })), error: null });
  }
}

function fakeClient(rows: Row[]) {
  return {
    from(table: string) {
      assert.equal(table, 'helios_inbound_buffer');
      return {
        update(patch: Partial<Row>) {
          return new UpdateQuery(rows, patch);
        }
      };
    }
  };
}

function row(id: number): Row {
  return {
    id,
    processed_at: null,
    processing_started_at: '2026-07-31T18:55:28.000Z',
    next_retry_at: '2026-07-31T19:00:00.000Z',
    last_error_code: 'OLD_ERROR',
    failed_at: '2026-07-31T18:56:37.000Z',
    retry_count: 2,
    response_idempotency_key: null
  };
}

const rows = [row(443), row(444), row(445)];
await markClaimedBufferMessagesProcessed(fakeClient(rows), [444, 443], 'trace-batch');

for (const claimed of rows.slice(0, 2)) {
  assert.ok(claimed.processed_at, 'all claimed rows receive processed_at');
  assert.equal(claimed.processing_started_at, null);
  assert.equal(claimed.next_retry_at, null);
  assert.equal(claimed.last_error_code, null);
  assert.equal(claimed.failed_at, null);
  assert.equal(claimed.retry_count, 0);
}
assert.equal(rows[0].response_idempotency_key, 'trace-batch', 'lowest claimed ID is canonical');
assert.equal(rows[1].response_idempotency_key, null, 'secondary row keeps a null response key');
assert.deepEqual(rows[2], row(445), 'a newer unclaimed message remains unchanged');

const constraint = new SupabaseOperationError(
  'SUPABASE_CONSTRAINT',
  'inbound_buffer.mark_processed',
  {
    code: '23505',
    message: 'duplicate key value violates unique constraint',
    details: 'Key (response_idempotency_key)=(private-value) already exists',
    hint: null
  }
);
const afterSuccess = classifyProcessingFailure(constraint, {
  hermesSucceeded: true,
  outboxCreated: true,
  statePatchApplied: true,
  bufferMarkedProcessed: false,
  stage: 'inbound_buffer.mark_processed'
});
assert.equal(afterSuccess.eventType, 'SUPABASE_WRITE_ERROR');
assert.equal(afterSuccess.component, 'supabase');
assert.equal(afterSuccess.preserveHermesSuccess, true);
assert.equal(afterSuccess.markConversationError, false);
assert.equal(afterSuccess.markBufferAsHermesFailed, false);
assert.equal(afterSuccess.emitHermesFailureEvent, false);
assert.equal(afterSuccess.retryHermes, false);
assert.equal(afterSuccess.createAnotherOutbox, false);
assert.equal(constraint.original_code, '23505');
assert.doesNotMatch(constraint.original_details || '', /private-value/);

const realHermesFailure = classifyProcessingFailure(new Error('HERMES_TIMEOUT'), {
  hermesSucceeded: false,
  outboxCreated: false,
  statePatchApplied: false,
  bufferMarkedProcessed: false,
  stage: 'hermes.call'
});
assert.equal(realHermesFailure.component, 'hermes');
assert.equal(realHermesFailure.markConversationError, true);
assert.equal(realHermesFailure.markBufferAsHermesFailed, true);
assert.equal(realHermesFailure.emitHermesFailureEvent, true);

assert.equal(
  isTerminalProcessingBatch({ ai_status: 'completed', delivery_status: 'pending' }),
  true,
  'a completed AI batch must not invoke Hermes again'
);
assert.equal(
  isTerminalProcessingBatch({ ai_status: 'completed', delivery_status: 'sent' }),
  true,
  'a sent outbox remains terminal for AI and tool execution'
);
assert.equal(
  isTerminalProcessingBatch({ ai_status: 'pending', delivery_status: 'not_ready' }),
  false
);

console.log('processing_outcome_test: PASS');

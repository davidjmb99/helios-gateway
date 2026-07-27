import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { processBufferEvent } from '../orchestrator.js';
import { supabase } from '../supabase/client.js';
import { assertSupabaseSuccess } from '../supabase/assert-success.js';
import { runOutboxTick } from './chatwoot-outbox-worker.js';

let workerRunning = false;
let workerInterval: NodeJS.Timeout | null = null;

export const recoveryMetrics = {
  mode: config.HELIOS_RECOVERY_MODE,
  observed_ai_pending: 0,
  observed_delivery_pending: 0,
  ai_recovery: 0,
  delivery_recovery: 0,
  loop_detected: 0,
  last_worker_run: null as Date | null,
  last_worker_error: null as string | null
};

async function observeRecoverableWork() {
  const batches = await supabase
    .from('helios_processing_batches')
    .select('id', { count: 'exact', head: true })
    .in('ai_status', ['pending', 'processing']);
  assertSupabaseSuccess(batches, 'recovery.observe_batches');

  const outbox = await supabase
    .from('helios_chatwoot_outbox')
    .select('outbox_key', { count: 'exact', head: true })
    .in('status', ['pending', 'sending', 'delivery_unknown']);
  assertSupabaseSuccess(outbox, 'recovery.observe_outbox');

  recoveryMetrics.observed_ai_pending = batches.count || 0;
  recoveryMetrics.observed_delivery_pending = outbox.count || 0;
  console.log(JSON.stringify({
    event: 'recovery_observation',
    mode: config.HELIOS_RECOVERY_MODE,
    ai_pending: recoveryMetrics.observed_ai_pending,
    delivery_pending: recoveryMetrics.observed_delivery_pending
  }));
}

async function recoverAi() {
  const staleAt = new Date(Date.now() - config.HELIOS_BATCH_LEASE_MS).toISOString();
  const result = await supabase
    .from('helios_processing_batches')
    .select('tenant_id, conversation_id, attempt_count, adapter_request_key')
    .or(`ai_status.eq.pending,and(ai_status.eq.processing,lease_expires_at.lte.${staleAt})`)
    .lt('attempt_count', 5)
    .order('created_at', { ascending: true })
    .limit(10);
  assertSupabaseSuccess(result, 'recovery.list_ai_batches');

  for (const batch of result.data || []) {
    if (batch.attempt_count >= 4) {
      recoveryMetrics.loop_detected += 1;
      console.warn(JSON.stringify({
        event: 'RECOVERY_LOOP_DETECTED',
        attempt_count: batch.attempt_count
      }));
    }
    if (batch.adapter_request_key) {
      const execution = await supabase
        .from('helios_adapter_executions')
        .select('status, lease_expires_at')
        .eq('request_key', batch.adapter_request_key)
        .maybeSingle();
      assertSupabaseSuccess(execution, 'recovery.inspect_adapter_execution', {
        tenant_id: batch.tenant_id,
        row_id: batch.adapter_request_key
      });
      if (
        execution.data?.status === 'in_progress' &&
        execution.data?.lease_expires_at &&
        new Date(execution.data.lease_expires_at).getTime() > Date.now()
      ) {
        continue;
      }
      if (execution.data?.status === 'failed_final') {
        console.warn(JSON.stringify({
          event: 'recovery_adapter_execution_final',
          attempt_count: batch.attempt_count
        }));
        continue;
      }
    }
    await processBufferEvent(
      batch.tenant_id,
      batch.conversation_id,
      `recovery-${randomUUID()}`
    );
    recoveryMetrics.ai_recovery += 1;
  }
}

export async function runRecoveryTick() {
  if (workerRunning || config.HELIOS_RECOVERY_MODE === 'disabled') return;
  workerRunning = true;
  recoveryMetrics.last_worker_run = new Date();
  try {
    await observeRecoverableWork();
    if (['ai_only', 'full'].includes(config.HELIOS_RECOVERY_MODE)) {
      await recoverAi();
    }
    if (['delivery_only', 'full'].includes(config.HELIOS_RECOVERY_MODE)) {
      await runOutboxTick(true);
      recoveryMetrics.delivery_recovery += 1;
    }
    recoveryMetrics.last_worker_error = null;
  } catch (error: any) {
    recoveryMetrics.last_worker_error = error?.code || 'RECOVERY_FAILED';
    console.error(JSON.stringify({
      event: 'recovery_worker_failed',
      mode: config.HELIOS_RECOVERY_MODE,
      error_code: recoveryMetrics.last_worker_error
    }));
  } finally {
    workerRunning = false;
  }
}

export function startRecoveryWorker() {
  console.log(JSON.stringify({
    event: 'recovery_mode_initialized',
    mode: config.HELIOS_RECOVERY_MODE
  }));
  if (process.env.NODE_ENV === 'test') return async () => {};
  void runRecoveryTick();
  workerInterval = setInterval(() => void runRecoveryTick(), 30000);
  return async () => {
    if (workerInterval) clearInterval(workerInterval);
    workerInterval = null;
  };
}

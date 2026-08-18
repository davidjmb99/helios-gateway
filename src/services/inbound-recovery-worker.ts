import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { decidirAccion, MAXIMO_INTENTOS } from './recovery-policy.js';
import { obtenerIntentosRecovery, maximoIntentosDeRecovery } from '../tenants/settings.js';
import { rescatarLote } from './batch-rescue.js';
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
  // EL LIMITE YA NO ESTA ESCRITO AQUI. Antes era `.lt('attempt_count', 5)`, y esa
  // linea es la que abandonaba pacientes: al llegar a 5 el lote desaparecia de la
  // consulta y nadie volvia a mirarlo. Ahora se piden TODOS los lotes parados sin
  // rescatar -con el techo mas alto de todas las clinicas- y es decidirAccion()
  // quien dice, fila a fila, si se reintenta o si se llama a una persona.
  const techo = await maximoIntentosDeRecovery().catch(() => MAXIMO_INTENTOS);
  const result = await supabase
    .from('helios_processing_batches')
    .select('batch_key, tenant_id, conversation_id, contact_id, attempt_count, adapter_request_key, last_error_code, rescatado_at')
    .or(`ai_status.eq.pending,and(ai_status.eq.processing,lease_expires_at.lte.${staleAt})`)
    .is('rescatado_at', null)
    .lte('attempt_count', techo)
    .order('created_at', { ascending: true })
    .limit(10);
  assertSupabaseSuccess(result, 'recovery.list_ai_batches');

  for (const batch of result.data || []) {
    // El limite es el de SU clinica, no uno global. Si no se puede leer, el de
    // siempre: 5. Nunca se deja de decidir por no poder leer un ajuste.
    const limite = await obtenerIntentosRecovery(batch.tenant_id).catch(() => 5);
    const accion = decidirAccion({
      intentos: batch.attempt_count,
      limite,
      yaRescatado: batch.rescatado_at
    });

    if (accion === 'ignorar') continue;

    if (accion === 'rescatar') {
      // Se acabaron los intentos. La unica salida honesta: una persona sigue con
      // el paciente y al paciente se le dice. Callarse era lo que se hacia antes.
      await rescatarLote(batch);
      continue;
    }

    if (batch.attempt_count >= limite - 1) {
      recoveryMetrics.loop_detected += 1;
      console.warn(JSON.stringify({
        event: 'RECOVERY_LOOP_DETECTED',
        attempt_count: batch.attempt_count,
        limite
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
        // Fallo definitivo del Adapter: reintentar no va a cambiar nada, asi que
        // se rescata YA sin esperar a agotar los intentos. Antes esto hacia
        // `continue` y el paciente se quedaba esperando igual que en el caso de
        // los intentos agotados.
        console.warn(JSON.stringify({
          event: 'recovery_adapter_execution_final',
          attempt_count: batch.attempt_count
        }));
        await rescatarLote(batch);
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

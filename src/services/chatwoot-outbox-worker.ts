import { chatwootClient, ChatwootDeliveryError } from '../chatwoot/client.js';
import { outboxRepository, processingBatchRepository } from '../repositories/durable.js';
import { logsRepository } from '../repositories/database.js';
import { shortFingerprint } from '../durable/identity.js';
import { config } from '../config.js';
import { recordComponentError, recordComponentSuccess } from './component-health.js';

let running = false;
let interval: NodeJS.Timeout | null = null;

export const outboxMetrics = {
  sent: 0,
  delivery_unknown: 0,
  deduplicated: 0,
  failed: 0,
  conversaciones_cerradas: 0,
  cierres_fallidos: 0,
  last_send_at: null as string | null,
  last_error_code: null as string | null
};

async function reconcile(row: any): Promise<void> {
  const existing = await chatwootClient.findMessageByOutboxKey(
    row.account_id,
    row.conversation_id,
    row.outbox_key
  );
  if (existing?.id) {
    await outboxRepository.markReconciledSent(row, String(existing.id));
    await processingBatchRepository.markDelivered(row.batch_key, row.tenant_id, row.outbox_key);
    outboxMetrics.deduplicated += 1;
    // El mensaje SÍ se publicó -se acaba de encontrar en Chatwoot-, así que el
    // cierre sigue tocando. Sin esto, un envío que se dio por incierto y luego se
    // reconcilió dejaría la conversación abierta para siempre.
    await cerrarConversacionSiToca(row);
    return;
  }
  await outboxRepository.markPendingAfterReconcile(row);
}

/**
 * Resolver la conversación cuando Helios ha declarado que terminó.
 *
 * Va DESPUÉS de markSent y no en el turno: resolver antes de que la despedida
 * esté publicada deja al paciente con la conversación cerrada sin haberla leído,
 * y en algunas configuraciones de Chatwoot el mensaje posterior la reabre, con lo
 * que la encuesta saldría en medio de una conversación viva.
 *
 * NO LANZA. El mensaje ya está entregado y el outbox ya está marcado: si el cierre
 * falla, lo peor que pasa es que la conversación se quede abierta y alguien le dé
 * a Resolver a mano —exactamente lo de antes—. Convertir eso en una excepción
 * haría que el worker reintentara un envío que ya se hizo.
 */
async function cerrarConversacionSiToca(row: any): Promise<void> {
  if (row?.cerrar_conversacion !== true) return;
  try {
    await chatwootClient.setStatus(row.account_id, row.conversation_id, 'resolved');
    outboxMetrics.conversaciones_cerradas += 1;
    console.log(JSON.stringify({
      event: 'cierre_automatico_aplicado',
      tenant_id: row.tenant_id,
      conversation_id: row.conversation_id,
      outbox_fingerprint: shortFingerprint(row.outbox_key)
    }));
  } catch (error: any) {
    outboxMetrics.cierres_fallidos += 1;
    console.warn(JSON.stringify({
      event: 'cierre_automatico_fallido',
      tenant_id: row.tenant_id,
      conversation_id: row.conversation_id,
      error_code: error?.code || error?.response?.status || 'CIERRE_FALLIDO'
    }));
  }
}

async function deliver(row: any): Promise<void> {
  if (row.status === 'delivery_unknown') {
    await reconcile(row);
    return;
  }

  try {
    await processingBatchRepository.updateDeliveryStatus(row.batch_key, row.tenant_id, 'sending');
    const response = await chatwootClient.sendMessage(
      row.account_id,
      row.conversation_id,
      row.content,
      row.content_attributes || {}
    );
    const outboundId = response.data?.id;
    if (!outboundId) throw new ChatwootDeliveryError('CHATWOOT_RESPONSE_ID_MISSING', true, response.status);

    await outboxRepository.markSent(row, String(outboundId), response.status);
    await processingBatchRepository.markDelivered(row.batch_key, row.tenant_id, row.outbox_key);
    await logsRepository.save({
      trace_id: row.trace_id || `outbox-${shortFingerprint(row.outbox_key)}`,
      tenant_id: row.tenant_id,
      conversation_id: row.conversation_id,
      contact_id: row.contact_id,
      event_type: 'CHATWOOT_REPLY_SENT',
      metadata: {
        outbox_key_fingerprint: shortFingerprint(row.outbox_key),
        batch_key_fingerprint: shortFingerprint(row.batch_key),
        chatwoot_message_id: String(outboundId),
        http_status: response.status,
        attempt_count: row.attempt_count
      }
    });
    outboxMetrics.sent += 1;
    outboxMetrics.last_send_at = new Date().toISOString();
    outboxMetrics.last_error_code = null;
    recordComponentSuccess('chatwoot');
    await cerrarConversacionSiToca(row);
    console.log(JSON.stringify({
      event: 'chatwoot_outbox_sent',
      outbox_fingerprint: shortFingerprint(row.outbox_key),
      batch_fingerprint: shortFingerprint(row.batch_key),
      attempt_count: row.attempt_count
    }));
  } catch (error: any) {
    const deliveryError = error instanceof ChatwootDeliveryError
      ? error
      : new ChatwootDeliveryError('CHATWOOT_UNAVAILABLE', false);
    outboxMetrics.last_error_code = deliveryError.code;
    recordComponentError(
      'chatwoot',
      deliveryError.code,
      deliveryError.ambiguous ? 'DELIVERY_UNKNOWN' : 'DEGRADED'
    );

    if (deliveryError.ambiguous) {
      await outboxRepository.markUnknown(row, deliveryError.code);
      await processingBatchRepository.updateDeliveryStatus(
        row.batch_key,
        row.tenant_id,
        'delivery_unknown',
        deliveryError.code
      );
      outboxMetrics.delivery_unknown += 1;
    } else {
      const final = row.attempt_count >= 5 || deliveryError.code === 'CHATWOOT_REJECTED';
      await outboxRepository.markRetry(row, deliveryError.code, final);
      await processingBatchRepository.updateDeliveryStatus(
        row.batch_key,
        row.tenant_id,
        final ? 'failed' : 'pending',
        deliveryError.code
      );
      outboxMetrics.failed += 1;
    }
    console.warn(JSON.stringify({
      event: 'chatwoot_outbox_delivery_failed',
      outbox_fingerprint: shortFingerprint(row.outbox_key),
      error_code: deliveryError.code,
      ambiguous: deliveryError.ambiguous,
      attempt_count: row.attempt_count
    }));
  }
}

export async function runOutboxTick(includeUnknown = false): Promise<void> {
  if (running) return;
  running = true;
  try {
    const claimed = await outboxRepository.claim(10);
    for (const row of claimed) await deliver(row);

    if (includeUnknown) {
      const unknown = await outboxRepository.listUnknown(10);
      for (const row of unknown) {
        try {
          await reconcile(row);
        } catch (error: any) {
          outboxMetrics.last_error_code = error?.code || 'CHATWOOT_RECONCILE_FAILED';
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startOutboxWorker() {
  if (process.env.NODE_ENV === 'test') return async () => {};
  const tick = () => {
    const includeUnknown = ['delivery_only', 'full'].includes(config.HELIOS_RECOVERY_MODE);
    void runOutboxTick(includeUnknown).catch(error => {
      outboxMetrics.last_error_code = error?.code || 'OUTBOX_WORKER_FAILED';
      console.error(JSON.stringify({
        event: 'outbox_worker_failed',
        error_code: outboxMetrics.last_error_code
      }));
    });
  };
  tick();
  interval = setInterval(tick, 2000);
  return async () => {
    if (interval) clearInterval(interval);
    interval = null;
  };
}

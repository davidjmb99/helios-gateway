import crypto from 'crypto';
import { supabase } from '../supabase/client.js';
import { config } from '../config.js';
import { assertSupabaseSuccess } from '../supabase/assert-success.js';

const workerId = `gateway-${crypto.randomUUID()}`;

export interface ProcessingBatchInput {
  batch_key: string;
  tenant_id: string;
  account_id: string;
  clinic_id: string;
  hermes_profile: string;
  conversation_id: string;
  contact_id: string;
  source_message_ids_hash: string;
  source_message_count: number;
  adapter_request_key?: string | null;
}

export const processingBatchRepository = {
  async createOrGet(input: ProcessingBatchInput, traceId: string): Promise<any> {
    const result = await supabase
      .from('helios_processing_batches')
      .upsert({
        ...input,
        ai_status: 'pending',
        delivery_status: 'not_ready',
        updated_at: new Date().toISOString()
      }, { onConflict: 'batch_key', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    assertSupabaseSuccess(result, 'processing_batch.create', {
      tenant_id: input.tenant_id,
      trace_id: traceId,
      row_id: input.batch_key
    });
    if (result.data) return result.data;

    const existing = await supabase
      .from('helios_processing_batches')
      .select('*')
      .eq('batch_key', input.batch_key)
      .single();
    assertSupabaseSuccess(existing, 'processing_batch.get_existing', {
      tenant_id: input.tenant_id,
      trace_id: traceId,
      row_id: input.batch_key
    });
    return existing.data;
  },

  async claimAi(batchKey: string, tenantId: string, traceId: string): Promise<any | null> {
    const result = await supabase.rpc('claim_helios_processing_batch', {
      p_batch_key: batchKey,
      p_lease_owner: workerId,
      p_lease_seconds: Math.ceil(config.HELIOS_BATCH_LEASE_MS / 1000)
    });
    assertSupabaseSuccess(result, 'processing_batch.claim_ai', {
      tenant_id: tenantId,
      trace_id: traceId,
      row_id: batchKey
    });
    return result.data?.[0] || null;
  },

  async markAiCompleted(
    batchKey: string,
    tenantId: string,
    traceId: string,
    outboxKey: string,
    adapterRequestKey: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_processing_batches')
      .update({
        ai_status: 'completed',
        delivery_status: 'pending',
        outbox_key: outboxKey,
        adapter_request_key: adapterRequestKey,
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: null,
        ai_completed_at: now,
        updated_at: now
      })
      .eq('batch_key', batchKey)
      .eq('lease_owner', workerId);
    assertSupabaseSuccess(result, 'processing_batch.complete_ai', {
      tenant_id: tenantId,
      trace_id: traceId,
      row_id: batchKey
    });
  },

  async markAiFailed(
    batchKey: string,
    tenantId: string,
    traceId: string,
    errorCode: string,
    final: boolean
  ): Promise<void> {
    const result = await supabase
      .from('helios_processing_batches')
      .update({
        ai_status: final ? 'failed' : 'pending',
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: errorCode,
        updated_at: new Date().toISOString()
      })
      .eq('batch_key', batchKey)
      .eq('lease_owner', workerId);
    assertSupabaseSuccess(result, 'processing_batch.fail_ai', {
      tenant_id: tenantId,
      trace_id: traceId,
      row_id: batchKey
    });
  },

  async markDelivered(batchKey: string, tenantId: string, outboxKey: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_processing_batches')
      .update({
        delivery_status: 'sent',
        processed_at: now,
        updated_at: now,
        last_error_code: null
      })
      .eq('batch_key', batchKey)
      .eq('outbox_key', outboxKey)
      .eq('ai_status', 'completed');
    assertSupabaseSuccess(result, 'processing_batch.mark_delivered', {
      tenant_id: tenantId,
      row_id: batchKey
    });
  },

  async updateDeliveryStatus(
    batchKey: string,
    tenantId: string,
    status: 'pending' | 'sending' | 'delivery_unknown' | 'failed',
    errorCode?: string | null
  ): Promise<void> {
    const result = await supabase
      .from('helios_processing_batches')
      .update({
        delivery_status: status,
        last_error_code: errorCode || null,
        updated_at: new Date().toISOString()
      })
      .eq('batch_key', batchKey);
    assertSupabaseSuccess(result, 'processing_batch.update_delivery', {
      tenant_id: tenantId,
      row_id: batchKey
    });
  }
};

export interface OutboxInput {
  outbox_key: string;
  batch_key: string;
  tenant_id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  source_message_ids_hash: string;
  adapter_request_key: string;
  content: string;
  content_hash: string;
  /**
   * ¿Hay que resolver la conversación en Chatwoot cuando ESTE mensaje se entregue?
   * Viaja con la fila y no en el turno: resolver antes del envío dejaría al
   * paciente con la conversación cerrada y la despedida sin leer.
   */
  cerrar_conversacion?: boolean;
}

export const outboxRepository = {
  async create(input: OutboxInput, traceId: string): Promise<any> {
    const contentAttributes = {
      helios_outbox_key: input.outbox_key,
      helios_batch_key: input.batch_key,
      helios_adapter_request_key: input.adapter_request_key
    };
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .upsert({
        ...input,
        content_attributes: contentAttributes,
        status: 'pending',
        updated_at: new Date().toISOString()
      }, { onConflict: 'outbox_key', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    assertSupabaseSuccess(result, 'chatwoot_outbox.create', {
      tenant_id: input.tenant_id,
      trace_id: traceId,
      row_id: input.outbox_key
    });
    if (result.data) return result.data;

    const existing = await supabase
      .from('helios_chatwoot_outbox')
      .select('*')
      .eq('outbox_key', input.outbox_key)
      .single();
    assertSupabaseSuccess(existing, 'chatwoot_outbox.get_existing', {
      tenant_id: input.tenant_id,
      trace_id: traceId,
      row_id: input.outbox_key
    });
    return existing.data;
  },

  /**
   * ¿Este mensaje saliente de Chatwoot lo publicó Helios?
   *
   * Discriminador del eco: todo saliente de Helios queda en el outbox con su
   * chatwoot_outbound_message_id. Si el id no está aquí, lo escribió una
   * persona del equipo.
   */
  async isHeliosOutboundMessage(tenantId: string, chatwootMessageId: string): Promise<boolean> {
    const normalizedId = String(chatwootMessageId ?? '').trim();
    if (!normalizedId) return false;
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .select('outbox_key')
      .eq('tenant_id', tenantId)
      .eq('chatwoot_outbound_message_id', normalizedId)
      .maybeSingle();
    assertSupabaseSuccess(result, 'chatwoot_outbox.is_helios_message', {
      tenant_id: tenantId,
      row_id: normalizedId
    });
    return Boolean(result.data);
  },

  /**
   * Últimos mensajes que Helios envió en una conversación. Junto con el buffer
   * (paciente y equipo) permite reconstruir el diálogo real sin leer Chatwoot.
   */
  async listRecentForConversation(
    tenantId: string,
    conversationId: string,
    limit: number
  ): Promise<Array<{ content: string; created_at: string }>> {
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .select('content, created_at')
      .eq('tenant_id', tenantId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(limit, 50)));
    assertSupabaseSuccess(result, 'chatwoot_outbox.list_recent', {
      tenant_id: tenantId,
      row_id: conversationId
    });
    return (result.data || []) as Array<{ content: string; created_at: string }>;
  },

  async claim(limit = 10): Promise<any[]> {
    const result = await supabase.rpc('claim_helios_chatwoot_outbox', {
      p_lease_owner: workerId,
      p_limit: limit,
      p_lease_seconds: Math.ceil(config.HELIOS_OUTBOX_LEASE_MS / 1000)
    });
    assertSupabaseSuccess(result, 'chatwoot_outbox.claim');
    return result.data || [];
  },

  async markSent(row: any, outboundId: string, httpStatus: number): Promise<void> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .update({
        status: 'sent',
        chatwoot_outbound_message_id: outboundId,
        http_status: httpStatus,
        delivery_fingerprint: crypto.createHash('sha256').update(String(outboundId)).digest('hex'),
        lease_owner: null,
        lease_expires_at: null,
        sent_at: now,
        updated_at: now,
        last_error_code: null
      })
      .eq('outbox_key', row.outbox_key)
      .eq('lease_owner', workerId);
    assertSupabaseSuccess(result, 'chatwoot_outbox.mark_sent', {
      tenant_id: row.tenant_id,
      row_id: row.outbox_key
    });
  },

  async markUnknown(row: any, errorCode: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .update({
        status: 'delivery_unknown',
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: errorCode,
        last_error_at: now,
        updated_at: now
      })
      .eq('outbox_key', row.outbox_key)
      .eq('lease_owner', workerId);
    assertSupabaseSuccess(result, 'chatwoot_outbox.mark_unknown', {
      tenant_id: row.tenant_id,
      row_id: row.outbox_key
    });
  },

  async markRetry(row: any, errorCode: string, final: boolean): Promise<void> {
    const now = new Date().toISOString();
    const baseDelayMs = Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, row.attempt_count - 1)));
    const jitterMs = Math.floor(Math.random() * Math.max(1000, baseDelayMs * 0.2));
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .update({
        status: final ? 'failed_final' : 'pending',
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: errorCode,
        last_error_at: now,
        available_at: new Date(Date.now() + baseDelayMs + jitterMs).toISOString(),
        updated_at: now
      })
      .eq('outbox_key', row.outbox_key)
      .eq('lease_owner', workerId);
    assertSupabaseSuccess(result, 'chatwoot_outbox.mark_retry', {
      tenant_id: row.tenant_id,
      row_id: row.outbox_key
    });
  },

  async markReconciledSent(row: any, outboundId: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .update({
        status: 'sent',
        chatwoot_outbound_message_id: outboundId,
        delivery_fingerprint: crypto.createHash('sha256').update(String(outboundId)).digest('hex'),
        lease_owner: null,
        lease_expires_at: null,
        sent_at: now,
        reconciled_at: now,
        updated_at: now,
        last_error_code: null
      })
      .eq('outbox_key', row.outbox_key);
    assertSupabaseSuccess(result, 'chatwoot_outbox.reconcile_sent', {
      tenant_id: row.tenant_id,
      row_id: row.outbox_key
    });
  },

  async listUnknown(limit = 10): Promise<any[]> {
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .select('*')
      .eq('status', 'delivery_unknown')
      .order('updated_at', { ascending: true })
      .limit(limit);
    assertSupabaseSuccess(result, 'chatwoot_outbox.list_unknown');
    return result.data || [];
  },

  async markPendingAfterReconcile(row: any): Promise<void> {
    const result = await supabase
      .from('helios_chatwoot_outbox')
      .update({
        status: row.attempt_count >= 5 ? 'failed_final' : 'pending',
        reconciled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error_code: row.attempt_count >= 5 ? 'CHATWOOT_RECONCILE_NOT_FOUND' : null
      })
      .eq('outbox_key', row.outbox_key)
      .eq('status', 'delivery_unknown');
    assertSupabaseSuccess(result, 'chatwoot_outbox.reconcile_not_found', {
      tenant_id: row.tenant_id,
      row_id: row.outbox_key
    });
  }
};

export function gatewayWorkerId(): string {
  return workerId;
}

import { supabase } from '../supabase/client.js';
import { config } from '../config.js';
import { assertSupabaseSuccess } from '../supabase/assert-success.js';
import { gatewayWorkerId } from './durable.js';
import type {
  HandoffDestination,
  HandoffPriority,
  HandoffReasonCode,
  HandoffStage
} from '../handoff/stage.js';

export interface HandoffEventInput {
  handoff_id: string;
  tenant_id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  trace_id: string;
  reason_code: HandoffReasonCode;
  destination: HandoffDestination;
  destination_team_id: string | null;
  priority: HandoffPriority;
  summary: string | null;
  treatment_interest: string | null;
  origin: 'model' | 'technical_failure' | 'chatwoot_signal';
}

/**
 * Historial de derivaciones. La fila es idempotente por handoff_id, que es
 * determinista (createHandoffIdentity), de modo que reintentos y webhooks
 * repetidos no crean handoffs nuevos.
 */
export const handoffEventRepository = {
  async createOrGet(input: HandoffEventInput): Promise<{ row: any; created: boolean }> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_handoff_events')
      .upsert({
        ...input,
        stage: 'handoff_requested',
        status: 'pending',
        // reason y message son las columnas históricas de la tabla; se conservan
        // para no romper a los consumidores anteriores.
        reason: input.reason_code,
        message: input.summary,
        chatwoot_steps: {},
        requested_at: now,
        created_at: now,
        updated_at: now
      }, { onConflict: 'handoff_id', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    assertSupabaseSuccess(result, 'handoff_events.create', {
      tenant_id: input.tenant_id,
      trace_id: input.trace_id,
      row_id: input.handoff_id
    });
    if (result.data) return { row: result.data, created: true };

    const existing = await supabase
      .from('helios_handoff_events')
      .select('*')
      .eq('handoff_id', input.handoff_id)
      .single();
    assertSupabaseSuccess(existing, 'handoff_events.get_existing', {
      tenant_id: input.tenant_id,
      trace_id: input.trace_id,
      row_id: input.handoff_id
    });
    return { row: existing.data, created: false };
  },

  async getByHandoffId(handoffId: string): Promise<any | null> {
    const result = await supabase
      .from('helios_handoff_events')
      .select('*')
      .eq('handoff_id', handoffId)
      .maybeSingle();
    assertSupabaseSuccess(result, 'handoff_events.get', { row_id: handoffId });
    return result.data;
  },

  /**
   * Marca un paso de Chatwoot como completado. chatwoot_steps es el registro
   * durable que permite reintentar un handoff a medio ejecutar sin repetir la
   * nota privada, la etiqueta ni la asignación.
   */
  async recordChatwootStep(
    handoffId: string,
    tenantId: string,
    step: string,
    detail: Record<string, unknown> = {}
  ): Promise<Record<string, any>> {
    const current = await this.getByHandoffId(handoffId);
    const steps = { ...(current?.chatwoot_steps || {}) };
    steps[step] = { done: true, at: new Date().toISOString(), ...detail };

    const result = await supabase
      .from('helios_handoff_events')
      .update({ chatwoot_steps: steps, updated_at: new Date().toISOString() })
      .eq('handoff_id', handoffId);
    assertSupabaseSuccess(result, 'handoff_events.record_step', {
      tenant_id: tenantId,
      row_id: handoffId
    });
    return steps;
  },

  async updateLifecycle(
    handoffId: string,
    tenantId: string,
    patch: {
      stage?: HandoffStage;
      status?: 'pending' | 'resolved' | 'closed';
      transition_outbox_key?: string | null;
      notification_key?: string | null;
      human_accepted_at?: string | null;
      human_accepted_by?: string | null;
      return_requested_at?: string | null;
      returned_to_bot_at?: string | null;
      closed_at?: string | null;
      resolved_at?: string | null;
    }
  ): Promise<void> {
    const result = await supabase
      .from('helios_handoff_events')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('handoff_id', handoffId);
    assertSupabaseSuccess(result, 'handoff_events.update_lifecycle', {
      tenant_id: tenantId,
      row_id: handoffId
    });
  },

  /** Handoff abierto más reciente de una conversación. */
  async getOpenForConversation(tenantId: string, conversationId: string): Promise<any | null> {
    const result = await supabase
      .from('helios_handoff_events')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .not('handoff_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    assertSupabaseSuccess(result, 'handoff_events.get_open', {
      tenant_id: tenantId,
      row_id: conversationId
    });
    return result.data;
  }
};

export interface NotificationOutboxInput {
  notification_key: string;
  tenant_id: string;
  account_id: string;
  handoff_id: string;
  conversation_id: string;
  contact_id: string;
  channel: 'telegram' | 'slack';
  destination: string | null;
  payload: Record<string, unknown>;
}

/**
 * Outbox de avisos al equipo, independiente del outbox de Chatwoot (ítem 23):
 * una caída de Telegram no puede repetir Hermes, el handoff, la nota privada ni
 * el mensaje al paciente. Solo queda reintentable esta fila.
 */
export const notificationOutboxRepository = {
  async create(input: NotificationOutboxInput): Promise<{ row: any; created: boolean }> {
    const status = input.destination ? 'pending' : 'blocked_unconfigured';
    const result = await supabase
      .from('helios_notification_outbox')
      .upsert({
        ...input,
        status,
        updated_at: new Date().toISOString()
      }, { onConflict: 'notification_key', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    assertSupabaseSuccess(result, 'notification_outbox.create', {
      tenant_id: input.tenant_id,
      row_id: input.notification_key
    });
    if (result.data) return { row: result.data, created: true };

    const existing = await supabase
      .from('helios_notification_outbox')
      .select('*')
      .eq('notification_key', input.notification_key)
      .single();
    assertSupabaseSuccess(existing, 'notification_outbox.get_existing', {
      tenant_id: input.tenant_id,
      row_id: input.notification_key
    });
    return { row: existing.data, created: false };
  },

  async claim(limit = 10): Promise<any[]> {
    const result = await supabase.rpc('claim_helios_notification_outbox', {
      p_lease_owner: gatewayWorkerId(),
      p_limit: limit,
      p_lease_seconds: Math.ceil(config.HELIOS_NOTIFICATION_LEASE_MS / 1000),
      p_max_attempts: config.HELIOS_NOTIFICATION_MAX_ATTEMPTS
    });
    assertSupabaseSuccess(result, 'notification_outbox.claim');
    return result.data || [];
  },

  async markSent(row: any, providerMessageId: string | null): Promise<void> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_notification_outbox')
      .update({
        status: 'sent',
        provider_message_id: providerMessageId,
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: null,
        sent_at: now,
        updated_at: now
      })
      .eq('notification_key', row.notification_key)
      .eq('lease_owner', gatewayWorkerId());
    assertSupabaseSuccess(result, 'notification_outbox.mark_sent', {
      tenant_id: row.tenant_id,
      row_id: row.notification_key
    });
  },

  async markRetry(row: any, errorCode: string, final: boolean): Promise<void> {
    const now = new Date().toISOString();
    const attempt = Math.max(0, Number(row.attempt_count || 1) - 1);
    const baseDelayMs = Math.min(15 * 60_000, 30_000 * (2 ** attempt));
    const jitterMs = Math.floor(Math.random() * Math.max(1000, baseDelayMs * 0.2));
    const result = await supabase
      .from('helios_notification_outbox')
      .update({
        status: final ? 'failed_final' : 'pending',
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: errorCode,
        last_error_at: now,
        available_at: new Date(Date.now() + baseDelayMs + jitterMs).toISOString(),
        updated_at: now
      })
      .eq('notification_key', row.notification_key)
      .eq('lease_owner', gatewayWorkerId());
    assertSupabaseSuccess(result, 'notification_outbox.mark_retry', {
      tenant_id: row.tenant_id,
      row_id: row.notification_key
    });
  },

  /**
   * El canal no está configurado. No es un fallo de entrega: no consume
   * intentos y la fila espera a que el operador configure el destino.
   */
  async markBlocked(row: any, errorCode: string): Promise<void> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_notification_outbox')
      .update({
        status: 'blocked_unconfigured',
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: Math.max(0, Number(row.attempt_count || 1) - 1),
        last_error_code: errorCode,
        last_error_at: now,
        updated_at: now
      })
      .eq('notification_key', row.notification_key)
      .eq('lease_owner', gatewayWorkerId());
    assertSupabaseSuccess(result, 'notification_outbox.mark_blocked', {
      tenant_id: row.tenant_id,
      row_id: row.notification_key
    });
  },

  /**
   * Devuelve a la cola los avisos que quedaron bloqueados por falta de
   * configuración. Sin limit a propósito: PostgREST exige un order explícito para
   * acotar un UPDATE, y estas filas son pocas por definición.
   */
  async releaseBlocked(): Promise<number> {
    const now = new Date().toISOString();
    const result = await supabase
      .from('helios_notification_outbox')
      .update({ status: 'pending', available_at: now, updated_at: now })
      .eq('status', 'blocked_unconfigured')
      .select('notification_key');
    assertSupabaseSuccess(result, 'notification_outbox.release_blocked');
    return (result.data || []).length;
  },

  async countByStatus(status: string): Promise<number> {
    const result = await supabase
      .from('helios_notification_outbox')
      .select('notification_key', { count: 'exact', head: true })
      .eq('status', status);
    assertSupabaseSuccess(result, 'notification_outbox.count');
    return Number((result as any).count || 0);
  }
};

import { supabase } from '../supabase/client.js';
import { NormalizedMessage } from '../chatwoot/normalizer.js';
import { config } from '../config.js';

// --- IDEMPOTENCIA ---
export const idempotencyRepository = {
  async check(tenant_id: string, provider: string, message_id: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('helios_message_idempotency')
      .select('message_id')
      .eq('tenant_id', tenant_id)
      .eq('provider', provider)
      .eq('message_id', message_id)
      .maybeSingle();

    if (error) {
      console.error('[Repository Error] Idempotency check failed:', error);
      return false; // Ante fallos de BD asumimos no procesado, pero registramos el error
    }
    return !!data;
  },

  async markProcessed(tenant_id: string, provider: string, message_id: string, conversation_id: string, trace_id: string): Promise<void> {
    await supabase
      .from('helios_message_idempotency')
      .insert({
        tenant_id,
        provider,
        message_id,
        conversation_id,
        trace_id,
        status: 'processed',
        processed_at: new Date().toISOString()
      });
  }
};

// --- BUFFER DE MENSAJES ---
export const bufferRepository = {
  async save(msg: NormalizedMessage): Promise<void> {
    await supabase
      .from('helios_inbound_buffer')
      .insert({
        tenant_id: msg.tenant_id,
        conversation_id: msg.conversation_id,
        contact_id: msg.contact_id,
        inbox_id: msg.inbox_id,
        message_id: msg.message_id,
        source_id: msg.source_id,
        body: msg.text,
        direction: msg.direction,
        content_type: 'text',
        created_at: msg.created_at,
        trace_id: msg.trace_id
      });
  },

  async getUnprocessed(tenant_id: string, conversation_id: string, trace_id?: string): Promise<any[]> {
    let query = supabase
      .from('helios_inbound_buffer')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('conversation_id', conversation_id)
      .is('processed_at', null)
      .is('failed_at', null);

    // Para el flujo de recuperación y reintentos, siempre consolidamos todos los mensajes pendientes de la conversación,
    // independientemente del trace_id del disparador inicial.

    const { data, error } = await query.order('created_at', { ascending: true });

    if (error) {
      console.error('[Repository Error] getUnprocessed buffer failed:', error);
      return [];
    }

    // Filtrar next_retry_at en el futuro
    const now = new Date();
    const result = (data || []).filter(m => {
      if (!m.next_retry_at) return true;
      return new Date(m.next_retry_at) <= now;
    });

    return result;
  },

  async claimConversationMessages(tenantId: string, conversationId: string): Promise<any[]> {
    // Intentar la RPC atómica (ideal: transacción única con FOR UPDATE SKIP LOCKED)
    const { data, error } = await supabase.rpc('claim_conversation_messages', {
      p_tenant_id: tenantId,
      p_conversation_id: conversationId
    });

    if (!error) {
      return data || [];
    }

    // Si la RPC no está en el schema cache de PostgREST (PGRST202), usar fallback SELECT+UPDATE.
    // Esto ocurre después de crear la función hasta que el cache se refresque (puede tardar minutos en Supabase Cloud).
    if (error.code === 'PGRST202') {
      console.warn('[Repository] claim_conversation_messages RPC no disponible en schema cache, usando fallback SELECT+UPDATE.');
      const now = new Date();
      const { data: candidates, error: selErr } = await supabase
        .from('helios_inbound_buffer')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('conversation_id', conversationId)
        .is('processed_at', null)
        .is('failed_at', null)
        .lt('retry_count', 5)
        .order('created_at', { ascending: true });

      if (selErr || !candidates || candidates.length === 0) return [];

      const eligible = candidates.filter(m => {
        // Lease check
        if (m.processing_started_at) {
          const RECOVERY_STALE_AFTER_MS = Math.max((config.HERMES_TIMEOUT_MS || 30000) + 60000, 180000);
          const staleThreshold = new Date(Date.now() - RECOVERY_STALE_AFTER_MS);
          if (new Date(m.processing_started_at) >= staleThreshold) {
            return false;
          }
        }
        if (!m.next_retry_at) return true;
        return new Date(m.next_retry_at) <= now;
      });

      if (eligible.length === 0) return [];

      const ids = eligible.map(m => m.id);
      await supabase
        .from('helios_inbound_buffer')
        .update({ processing_started_at: now.toISOString() })
        .in('id', ids);

      return eligible;
    }

    // Cualquier otro error de RPC: propagar
    console.error('[Repository Error] claim_conversation_messages RPC failed:', error);
    throw error;
  },

  async getMessagesByIds(ids: number[]): Promise<any[]> {
    if (!ids || ids.length === 0) return [];
    const { data, error } = await supabase
      .from('helios_inbound_buffer')
      .select('*')
      .in('id', ids);
    
    if (error) throw error;
    return (data || []).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  },

  async markProcessed(ids: number[], response_idempotency_key?: string): Promise<void> {
    if (ids.length === 0) return;
    const payload: any = { 
      processed_at: new Date().toISOString(),
      processing_started_at: null,
      last_error_code: null,
      next_retry_at: null,
      retry_count: 0,
      failed_at: null
    };
    if (response_idempotency_key) {
      payload.response_idempotency_key = response_idempotency_key;
    }
    
    await supabase
      .from('helios_inbound_buffer')
      .update(payload)
      .in('id', ids);
  },

  async markRecoverableError(ids: number[], error_code: string, current_retry_count: number): Promise<void> {
    if (ids.length === 0) return;
    
    // Si ya alcanzó o superó el máximo de reintentos (5), marcar como fallido definitivo.
    if (current_retry_count >= 5) {
      await this.markFailed(ids, error_code);
      return;
    }
    
    // Backoff especificado por requerimiento: 
    // retry 1: +1 minuto (60000ms)
    // retry 2: +2 minutos (120000ms)
    // retry 3: +5 minutos (300000ms)
    // retry 4: +10 minutos (600000ms)
    // retry 5: +15 minutos (900000ms)
    let delayMs = 60000;
    if (current_retry_count === 1) delayMs = 120000;
    else if (current_retry_count === 2) delayMs = 300000;
    else if (current_retry_count === 3) delayMs = 600000;
    else if (current_retry_count >= 4) delayMs = 900000;

    const nextRetry = process.env.NODE_ENV === 'test'
      ? null
      : new Date(Date.now() + delayMs).toISOString();

    await supabase
      .from('helios_inbound_buffer')
      .update({
        retry_count: current_retry_count + 1,
        processing_started_at: null,
        last_error_code: error_code,
        next_retry_at: nextRetry
      })
      .in('id', ids);
  },

  async markFailed(ids: number[], error_code: string): Promise<void> {
    if (ids.length === 0) return;
    await supabase
      .from('helios_inbound_buffer')
      .update({
        failed_at: new Date().toISOString(),
        processing_started_at: null,
        next_retry_at: null,
        last_error_code: error_code
      })
      .in('id', ids);
  }
};

// --- ESTADO DE LA CONVERSACIÓN ---
export const stateRepository = {
  async get(tenant_id: string, conversation_id: string): Promise<any | null> {
    const { data, error } = await supabase
      .from('helios_conversation_state')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('conversation_id', conversation_id)
      .maybeSingle();

    if (error) {
      console.error('[Repository Error] Get state failed:', error);
      return null;
    }
    return data;
  },

  async getRefined(tenant_id: string, conversation_id: string, contact_id: string): Promise<any | null> {
    // Buscar primero con el contact_id específico para saltar filas 'unknown' corruptas
    const { data, error } = await supabase
      .from('helios_conversation_state')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('conversation_id', conversation_id)
      .eq('contact_id', contact_id)
      .maybeSingle();

    if (!error && data) {
      return data;
    }

    // Fallback de búsqueda general si no existe
    return this.get(tenant_id, conversation_id);
  },

  async upsert(state: {
    tenant_id: string;
    conversation_id: string;
    contact_id: string;
    inbox_id: string;
    phone?: string;
    status?: string;
    pending_question?: string | null;
    pending_intent?: string | null;
    missing_fields?: any;
    ai_enabled?: boolean;
    human_handoff_active?: boolean;
    active_booking?: any;
    appointment_context?: any;
    financing?: any;
    last_intent?: string | null;
  }): Promise<void> {
    const { error } = await supabase
      .from('helios_conversation_state')
      .upsert({
        ...state,
        updated_at: new Date().toISOString()
      }, { onConflict: 'tenant_id,conversation_id' });

    if (error) {
      console.error('[Repository Error] Upsert state failed:', error);
    }
  }
};

// --- PERFIL DE PACIENTE ---
export const patientRepository = {
  async get(tenant_id: string, contact_id: string): Promise<any | null> {
    const { data, error } = await supabase
      .from('helios_patient_profiles')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('contact_id', contact_id)
      .maybeSingle();

    if (error) {
      console.error('[Repository Error] Get patient failed:', error);
      return null;
    }
    return data;
  },

  async upsert(profile: {
    tenant_id: string;
    contact_id: string;
    phone: string;
    first_name?: string | null;
    last_name?: string | null;
    name?: string | null;
    email?: string | null;
    profile_complete?: boolean;
    crm_contact_id?: string | null;
    chatwoot_display_name?: string | null;
  }): Promise<boolean> {
    const { error } = await supabase
      .from('helios_patient_profiles')
      .upsert({
        ...profile,
        updated_at: new Date().toISOString()
      }, { onConflict: 'tenant_id,contact_id' });

    if (error) {
      console.error('[Repository Error] Upsert patient profile failed:', error.code, error.message);
      return false;
    }
    return true;
  }
};

// --- LOGS ---
export const logsRepository = {
  async save(log: {
    trace_id: string;
    tenant_id: string;
    conversation_id: string;
    contact_id: string;
    event_type: string;
    route?: string;
    intent?: string;
    metadata?: any;
    error?: string;
  }): Promise<void> {
    await supabase
      .from('helios_gateway_logs')
      .insert({
        ...log,
        created_at: new Date().toISOString()
      });
  }
};

// --- HANDOFF EVENTOS ---
export const handoffRepository = {
  async create(event: {
    tenant_id: string;
    conversation_id: string;
    contact_id: string;
    reason?: string;
    message?: string;
    status?: string;
  }): Promise<void> {
    await supabase
      .from('helios_handoff_events')
      .insert({
        ...event,
        created_at: new Date().toISOString()
      });
  }
};

// --- FINANCIAMIENTO ---
export const financingRepository = {
  async getActive(tenant_id: string, contact_id: string): Promise<any | null> {
    const { data, error } = await supabase
      .from('helios_financing_cases')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('contact_id', contact_id)
      .in('status', ['requested', 'collecting_info', 'under_review', 'approved', 'paying'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[Repository Error] Get active financing failed:', error);
      return null;
    }
    return data;
  },

  async createCase(caseData: {
    tenant_id: string;
    conversation_id: string;
    contact_id: string;
    patient_name?: string | null;
    patient_email?: string | null;
    phone: string;
    treatment?: string;
    requested_amount?: number;
    status?: string;
    notes?: string;
  }): Promise<void> {
    await supabase
      .from('helios_financing_cases')
      .insert({
        ...caseData,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
  },

  async updateCase(id: number, updates: any): Promise<void> {
    await supabase
      .from('helios_financing_cases')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);
  }
};

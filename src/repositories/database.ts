import { supabase } from '../supabase/client.js';
import { NormalizedMessage } from '../chatwoot/normalizer.js';

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
      .is('processed_at', null);

    if (trace_id) {
      query = query.eq('trace_id', trace_id);
    }

    const { data, error } = await query.order('created_at', { ascending: true });

    if (error) {
      console.error('[Repository Error] getUnprocessed buffer failed:', error);
      return [];
    }
    return data || [];
  },

  async markProcessed(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await supabase
      .from('helios_inbound_buffer')
      .update({ processed_at: new Date().toISOString() })
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
    name?: string | null;
    email?: string | null;
    crm_contact_id?: string | null;
  }): Promise<void> {
    const { error } = await supabase
      .from('helios_patient_profiles')
      .upsert({
        ...profile,
        updated_at: new Date().toISOString()
      }, { onConflict: 'tenant_id,contact_id' });

    if (error) {
      console.error('[Repository Error] Upsert patient profile failed:', error);
    }
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

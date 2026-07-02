-- ==========================================
-- Helios Gateway — Esquema de Base de Datos
-- ==========================================

-- 1. Idempotencia de Mensajes (Evitar procesamiento duplicado)
CREATE TABLE IF NOT EXISTS public.helios_message_idempotency (
    tenant_id text NOT NULL,
    provider text NOT NULL,
    message_id text NOT NULL,
    conversation_id text NOT NULL,
    processed_at timestamptz DEFAULT now(),
    status text NOT NULL DEFAULT 'processed',
    trace_id text,
    CONSTRAINT helios_message_idempotency_pkey PRIMARY KEY (tenant_id, provider, message_id)
);

-- 2. Buffer de Mensajes Entrantes (Ráfagas)
CREATE TABLE IF NOT EXISTS public.helios_inbound_buffer (
    id bigserial PRIMARY KEY,
    tenant_id text NOT NULL,
    conversation_id text NOT NULL,
    contact_id text NOT NULL,
    inbox_id text NOT NULL,
    message_id text NOT NULL,
    source_id text,
    body text NOT NULL,
    direction text NOT NULL,
    content_type text,
    created_at timestamptz NOT NULL,
    processed_at timestamptz,
    trace_id text
);

-- 3. Estado de la Conversación
CREATE TABLE IF NOT EXISTS public.helios_conversation_state (
    tenant_id text NOT NULL,
    conversation_id text NOT NULL,
    contact_id text NOT NULL,
    inbox_id text NOT NULL,
    phone text,
    status text NOT NULL DEFAULT 'new',
    pending_question text,
    pending_intent text,
    missing_fields jsonb DEFAULT '[]'::jsonb,
    ai_enabled boolean DEFAULT true,
    human_handoff_active boolean DEFAULT false,
    active_booking jsonb,
    financing jsonb,
    last_intent text,
    updated_at timestamptz DEFAULT now(),
    CONSTRAINT helios_conversation_state_pkey PRIMARY KEY (tenant_id, conversation_id)
);

-- 4. Perfiles de Paciente (Mantenimiento de datos de contacto)
CREATE TABLE IF NOT EXISTS public.helios_patient_profiles (
    tenant_id text NOT NULL,
    contact_id text NOT NULL,
    phone text NOT NULL,
    name text,
    email text,
    crm_contact_id text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    CONSTRAINT helios_patient_profiles_pkey PRIMARY KEY (tenant_id, contact_id)
);

-- 5. Eventos de Handoff Humano (Historial de derivaciones)
CREATE TABLE IF NOT EXISTS public.helios_handoff_events (
    id bigserial PRIMARY KEY,
    tenant_id text NOT NULL,
    conversation_id text NOT NULL,
    contact_id text NOT NULL,
    reason text,
    message text,
    status text NOT NULL DEFAULT 'pending', -- pending, resolved, closed
    created_at timestamptz DEFAULT now(),
    resolved_at timestamptz
);

-- 6. Casos de Financiamiento
CREATE TABLE IF NOT EXISTS public.helios_financing_cases (
    id bigserial PRIMARY KEY,
    tenant_id text NOT NULL,
    conversation_id text NOT NULL,
    contact_id text NOT NULL,
    patient_name text,
    patient_email text,
    phone text NOT NULL,
    treatment text,
    requested_amount numeric(10, 2),
    approved_amount numeric(10, 2),
    monthly_payment numeric(10, 2),
    installments integer,
    granted_at timestamptz,
    next_payment_date timestamptz,
    status text NOT NULL DEFAULT 'requested', -- requested, collecting_info, under_review, approved, rejected, paying, completed, cancelled
    notes text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- 7. Historial / Logs de Helios Gateway
CREATE TABLE IF NOT EXISTS public.helios_gateway_logs (
    id bigserial PRIMARY KEY,
    trace_id text,
    tenant_id text,
    conversation_id text,
    contact_id text,
    event_type text NOT NULL, -- e.g. webhook_received, hermes_called, error
    route text,
    intent text,
    metadata jsonb DEFAULT '{}'::jsonb,
    error text,
    created_at timestamptz DEFAULT now()
);

-- ==========================================
-- Índices de Optimización de Consultas
-- ==========================================

CREATE INDEX IF NOT EXISTS idx_helios_inbound_buffer_tenant_conv_processed
ON public.helios_inbound_buffer(tenant_id, conversation_id, processed_at);

CREATE INDEX IF NOT EXISTS idx_helios_handoff_events_active
ON public.helios_handoff_events(tenant_id, conversation_id)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_helios_financing_cases_active
ON public.helios_financing_cases(tenant_id, contact_id, status);

CREATE INDEX IF NOT EXISTS idx_helios_gateway_logs_trace
ON public.helios_gateway_logs(trace_id);

CREATE INDEX IF NOT EXISTS idx_helios_gateway_logs_conv
ON public.helios_gateway_logs(tenant_id, conversation_id);

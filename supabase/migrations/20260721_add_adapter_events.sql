-- 1. Crear tabla de manera idempotente
CREATE TABLE IF NOT EXISTS public.helios_adapter_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    duration_ms INTEGER,
    hermes_duration_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    model TEXT,
    tool_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    safe_to_send BOOLEAN,
    response_sent BOOLEAN,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Índices idempotentes
CREATE INDEX IF NOT EXISTS idx_helios_adapter_events_trace_id ON public.helios_adapter_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_helios_adapter_events_created_at ON public.helios_adapter_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_helios_adapter_events_tenant_conv ON public.helios_adapter_events(tenant_id, conversation_id);

-- 3. Configuración estricta de seguridad (RLS)
ALTER TABLE public.helios_adapter_events ENABLE ROW LEVEL SECURITY;

-- 4. Revocar todos los permisos públicos
REVOKE ALL ON TABLE public.helios_adapter_events FROM PUBLIC;
REVOKE ALL ON TABLE public.helios_adapter_events FROM anon;
REVOKE ALL ON TABLE public.helios_adapter_events FROM authenticated;

-- 5. Conceder permisos exclusivamente a service_role
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.helios_adapter_events TO service_role;

-- 6. Crear política estricta para service_role
DROP POLICY IF EXISTS "Service role access" ON public.helios_adapter_events;
CREATE POLICY "Service role access" ON public.helios_adapter_events 
    FOR ALL
    TO service_role
    USING (true) 
    WITH CHECK (true);

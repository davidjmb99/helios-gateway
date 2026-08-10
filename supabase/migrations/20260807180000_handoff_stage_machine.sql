-- ==========================================================================
-- Helios — Máquina de estados canónica del handoff humano
-- ==========================================================================
-- Cambios ADITIVOS e idempotentes. No elimina ni renombra nada.
-- Fuente canónica del estado: helios_conversation_state (ítem 15 del check list).
-- helios_handoff_events conserva el historial de derivaciones.
-- helios_notification_outbox es independiente: una caída de Telegram no puede
-- repetir Hermes, el handoff, la nota privada ni el mensaje al paciente.

BEGIN;

-- --------------------------------------------------------------------------
-- 1. Estado canónico del handoff en la conversación (ítem 15)
-- --------------------------------------------------------------------------
-- human_handoff_active se conserva y se sigue escribiendo por compatibilidad
-- con el dashboard y el payload de Hermes; stage es la fuente de verdad.

ALTER TABLE public.helios_conversation_state
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'bot_active',
  ADD COLUMN IF NOT EXISTS handoff_id uuid,
  ADD COLUMN IF NOT EXISTS handoff_reason text,
  ADD COLUMN IF NOT EXISTS handoff_priority text,
  ADD COLUMN IF NOT EXISTS handoff_destination text,
  ADD COLUMN IF NOT EXISTS handoff_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_accepted_by text,
  ADD COLUMN IF NOT EXISTS return_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_to_bot_at timestamptz,
  -- Marca de que la transcripción del episodio humano ya se entregó a Hermes.
  -- Sin esto el payload arrastraría esa conversación en todos los turnos
  -- siguientes, y el coste por turno ya es el problema abierto más caro.
  ADD COLUMN IF NOT EXISTS handoff_context_delivered_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'helios_conversation_state_stage_check'
  ) THEN
    ALTER TABLE public.helios_conversation_state
      ADD CONSTRAINT helios_conversation_state_stage_check
      CHECK (stage IN (
        'bot_active',
        'handoff_requested',
        'human_queue',
        'human_active',
        'waiting_patient',
        'return_requested',
        'handoff_failed',
        'closed'
      ));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_helios_conversation_state_stage
  ON public.helios_conversation_state (tenant_id, stage, updated_at DESC);

-- Backfill: una conversación que HOY está en modo humano debe seguir bloqueada
-- después del deploy. El default 'bot_active' se la devolvería a la IA.
-- status='error' + human_handoff_active queda excluido a propósito: el código
-- vigente lo trata como fallo técnico, no como handoff humano real.
UPDATE public.helios_conversation_state
SET stage = 'human_active'
WHERE human_handoff_active IS TRUE
  AND COALESCE(status, '') <> 'error'
  AND stage = 'bot_active';

-- --------------------------------------------------------------------------
-- 2. Historial de handoff con identidad propia
-- --------------------------------------------------------------------------
-- La tabla existente ya tiene id, reason, message y status; se amplía.

ALTER TABLE public.helios_handoff_events
  ADD COLUMN IF NOT EXISTS handoff_id uuid,
  ADD COLUMN IF NOT EXISTS account_id text,
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS priority text,
  ADD COLUMN IF NOT EXISTS destination text,
  ADD COLUMN IF NOT EXISTS destination_team_id text,
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS treatment_interest text,
  ADD COLUMN IF NOT EXISTS origin text,
  ADD COLUMN IF NOT EXISTS chatwoot_steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS transition_outbox_key text,
  ADD COLUMN IF NOT EXISTS notification_key text,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS human_accepted_by text,
  ADD COLUMN IF NOT EXISTS return_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_to_bot_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Sin cláusula WHERE a propósito: Postgres considera los NULL distintos entre
-- sí, así que las filas históricas sin handoff_id conviven, y un índice total sí
-- puede inferirse en ON CONFLICT (handoff_id), que es como el repositorio
-- consigue el createOrGet idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_helios_handoff_events_handoff_id
  ON public.helios_handoff_events (handoff_id);

-- Búsqueda del handoff abierto de una conversación. NO es único a propósito:
-- la tabla ya tiene filas históricas creadas por la herramienta handoff.create
-- con status='pending' y un índice único aquí podría abortar la migración.
-- La unicidad real la da handoff_id, que es determinista (createHandoffIdentity).
CREATE INDEX IF NOT EXISTS idx_helios_handoff_events_open_conversation
  ON public.helios_handoff_events (tenant_id, conversation_id, status);

CREATE INDEX IF NOT EXISTS idx_helios_handoff_events_conversation_history
  ON public.helios_handoff_events (tenant_id, conversation_id, created_at DESC);

-- --------------------------------------------------------------------------
-- 3. Lectura del historial humano (requisito D)
-- --------------------------------------------------------------------------
-- Los mensajes que escribe el equipo se guardan en el buffer con
-- direction='outgoing' y processed_at ya puesto, de modo que
-- claim_conversation_messages nunca los reclama y no pueden disparar la IA.

CREATE INDEX IF NOT EXISTS idx_helios_inbound_buffer_conversation_direction
  ON public.helios_inbound_buffer (tenant_id, conversation_id, direction, created_at DESC);

-- --------------------------------------------------------------------------
-- 4. Outbox de notificaciones (ítem 23)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.helios_notification_outbox (
  notification_key text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  handoff_id uuid,
  conversation_id text NOT NULL,
  contact_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('telegram', 'slack')),
  destination text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed_final', 'blocked_unconfigured')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error_code text,
  last_error_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sending_at timestamptz,
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_helios_notification_outbox_delivery
  ON public.helios_notification_outbox (status, available_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_helios_notification_outbox_handoff
  ON public.helios_notification_outbox (tenant_id, handoff_id);

ALTER TABLE public.helios_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.helios_notification_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.helios_notification_outbox TO service_role;

-- Claim atómico. Un lease vencido en 'sending' se vuelve a reclamar: perder un
-- aviso al equipo es peor que repetirlo, y attempt_count acota los reintentos.
CREATE OR REPLACE FUNCTION public.claim_helios_notification_outbox(
  p_lease_owner text,
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 8
)
RETURNS SETOF public.helios_notification_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT n.notification_key
    FROM public.helios_notification_outbox n
    WHERE n.attempt_count < GREATEST(p_max_attempts, 1)
      AND (
        (n.status = 'pending' AND n.available_at <= now())
        OR (
          n.status = 'sending'
          AND (n.lease_expires_at IS NULL OR n.lease_expires_at <= now())
        )
      )
    ORDER BY n.created_at
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE OF n SKIP LOCKED
  )
  UPDATE public.helios_notification_outbox n
  SET status = 'sending',
      lease_owner = p_lease_owner,
      lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 15), 300)),
      attempt_count = n.attempt_count + 1,
      sending_at = COALESCE(n.sending_at, now()),
      updated_at = now()
  FROM candidates
  WHERE n.notification_key = candidates.notification_key
  RETURNING n.*;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_helios_notification_outbox(text, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_helios_notification_outbox(text, integer, integer, integer)
  TO service_role;

COMMIT;

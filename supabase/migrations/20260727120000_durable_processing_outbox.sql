BEGIN;

CREATE TABLE IF NOT EXISTS public.helios_processing_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_key text UNIQUE NOT NULL,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  clinic_id text NOT NULL,
  hermes_profile text NOT NULL,
  conversation_id text NOT NULL,
  contact_id text NOT NULL,
  source_message_ids_hash text NOT NULL,
  source_message_count integer NOT NULL CHECK (source_message_count > 0),
  ai_status text NOT NULL DEFAULT 'pending'
    CHECK (ai_status IN ('pending','processing','completed','failed','handoff')),
  delivery_status text NOT NULL DEFAULT 'not_ready'
    CHECK (delivery_status IN ('not_ready','pending','sending','sent','delivery_unknown','failed','suppressed')),
  adapter_request_key text,
  outbox_key text,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ai_completed_at timestamptz,
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_helios_batches_recovery
  ON public.helios_processing_batches (tenant_id, ai_status, delivery_status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_helios_batches_conversation
  ON public.helios_processing_batches (tenant_id, conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.helios_chatwoot_outbox (
  outbox_key text PRIMARY KEY,
  batch_key text NOT NULL REFERENCES public.helios_processing_batches(batch_key),
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  conversation_id text NOT NULL,
  contact_id text NOT NULL,
  source_message_ids_hash text NOT NULL,
  adapter_request_key text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  content_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','delivery_unknown','failed_recoverable','failed_final')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  chatwoot_outbound_message_id text,
  http_status integer,
  delivery_fingerprint text,
  last_error_code text,
  last_error_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sending_at timestamptz,
  sent_at timestamptz,
  reconciled_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_helios_outbox_delivery
  ON public.helios_chatwoot_outbox (tenant_id, status, lease_expires_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_helios_outbox_chatwoot_message
  ON public.helios_chatwoot_outbox (tenant_id, chatwoot_outbound_message_id)
  WHERE chatwoot_outbound_message_id IS NOT NULL;

ALTER TABLE public.helios_processing_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.helios_chatwoot_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.helios_processing_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.helios_chatwoot_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.helios_processing_batches TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.helios_chatwoot_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.claim_conversation_messages(
  p_tenant_id text,
  p_conversation_id text,
  p_lease_seconds integer DEFAULT 180
)
RETURNS SETOF public.helios_inbound_buffer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
BEGIN
  RETURN QUERY
  WITH locked AS (
    SELECT b.id
    FROM public.helios_inbound_buffer b
    WHERE b.tenant_id = p_tenant_id
      AND b.conversation_id = p_conversation_id
      AND b.processed_at IS NULL
      AND b.failed_at IS NULL
      AND COALESCE(b.retry_count, 0) < 5
      AND (b.next_retry_at IS NULL OR b.next_retry_at <= now())
      AND (
        b.processing_started_at IS NULL
        OR b.processing_started_at <= now() - make_interval(secs => LEAST(GREATEST(p_lease_seconds, 30), 900))
      )
    ORDER BY b.created_at
    FOR UPDATE OF b SKIP LOCKED
  )
  UPDATE public.helios_inbound_buffer u
  SET processing_started_at = now()
  FROM locked
  WHERE u.id = locked.id
  RETURNING u.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_helios_processing_batch(
  p_batch_key text,
  p_lease_owner text,
  p_lease_seconds integer DEFAULT 180
)
RETURNS SETOF public.helios_processing_batches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT b.batch_key
    FROM public.helios_processing_batches b
    WHERE b.batch_key = p_batch_key
      AND b.ai_status IN ('pending','processing')
      AND (
        b.ai_status = 'pending'
        OR b.lease_expires_at IS NULL
        OR b.lease_expires_at <= now()
      )
    FOR UPDATE OF b SKIP LOCKED
  )
  UPDATE public.helios_processing_batches b
  SET ai_status = 'processing',
      lease_owner = p_lease_owner,
      lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 30), 900)),
      attempt_count = b.attempt_count + 1,
      updated_at = now()
  FROM candidate
  WHERE b.batch_key = candidate.batch_key
  RETURNING b.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_helios_chatwoot_outbox(
  p_lease_owner text,
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60
)
RETURNS SETOF public.helios_chatwoot_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT o.outbox_key
    FROM public.helios_chatwoot_outbox o
    WHERE (o.status = 'pending' AND o.available_at <= now())
       OR (
         o.status = 'sending'
         AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= now())
       )
    ORDER BY o.created_at
    LIMIT LEAST(GREATEST(p_limit, 1), 100)
    FOR UPDATE OF o SKIP LOCKED
  )
  UPDATE public.helios_chatwoot_outbox o
  SET status = CASE WHEN o.status = 'sending' THEN 'delivery_unknown' ELSE 'sending' END,
      lease_owner = p_lease_owner,
      lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 15), 300)),
      attempt_count = o.attempt_count + 1,
      sending_at = COALESCE(o.sending_at, now()),
      updated_at = now()
  FROM candidates
  WHERE o.outbox_key = candidates.outbox_key
  RETURNING o.*;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_conversation_messages(text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_helios_processing_batch(text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_helios_chatwoot_outbox(text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_conversation_messages(text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_helios_processing_batch(text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_helios_chatwoot_outbox(text,integer,integer) TO service_role;

COMMIT;

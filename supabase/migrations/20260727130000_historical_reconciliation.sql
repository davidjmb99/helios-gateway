BEGIN;

CREATE TABLE IF NOT EXISTS public.helios_historical_reconciliation_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL,
  source_fingerprint text NOT NULL,
  tenant_id text,
  classification text NOT NULL CHECK (
    classification IN (
      'sent_evidence_applied',
      'sent_evidence_unlinked',
      'historical_unknown',
      'recovery_loop',
      'multiple_publications'
    )
  ),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  affected_rows integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_fingerprint, classification)
);

ALTER TABLE public.helios_historical_reconciliation_report ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.helios_historical_reconciliation_report FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.helios_historical_reconciliation_report TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_helios_gateway_history()
RETURNS TABLE(classification text, affected_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
BEGIN
  -- Apply only authoritative outbox evidence already persisted by the new flow.
  WITH proven AS (
    SELECT b.batch_key, b.tenant_id, o.outbox_key, o.chatwoot_outbound_message_id
    FROM public.helios_processing_batches b
    JOIN public.helios_chatwoot_outbox o ON o.batch_key = b.batch_key
    WHERE b.processed_at IS NULL
      AND o.status = 'sent'
      AND o.chatwoot_outbound_message_id IS NOT NULL
  ), updated AS (
    UPDATE public.helios_processing_batches b
    SET delivery_status = 'sent',
        processed_at = COALESCE(b.processed_at, now()),
        updated_at = now()
    FROM proven p
    WHERE b.batch_key = p.batch_key
    RETURNING b.batch_key, b.tenant_id, p.outbox_key, p.chatwoot_outbound_message_id
  )
  INSERT INTO public.helios_historical_reconciliation_report (
    source_type, source_fingerprint, tenant_id, classification, evidence, affected_rows
  )
  SELECT
    'processing_batch',
    md5(batch_key),
    tenant_id,
    'sent_evidence_applied',
    jsonb_build_object(
      'outbox_key_fingerprint', md5(outbox_key),
      'outbound_id_present', chatwoot_outbound_message_id IS NOT NULL
    ),
    1
  FROM updated
  ON CONFLICT DO NOTHING;

  -- Legacy outbound logs are evidence, but without stable batch/outbox keys they
  -- are report-only. This function never reconstructs content and never sends.
  INSERT INTO public.helios_historical_reconciliation_report (
    source_type, source_fingerprint, tenant_id, classification, evidence, affected_rows
  )
  SELECT
    'gateway_log',
    md5(l.id::text),
    l.tenant_id,
    'sent_evidence_unlinked',
    jsonb_build_object(
      'event_type', l.event_type,
      'outbound_id_present', true
    ),
    0
  FROM public.helios_gateway_logs l
  WHERE l.event_type = 'CHATWOOT_REPLY_SENT'
    AND COALESCE(l.metadata->>'chatwoot_message_id', '') <> ''
  ON CONFLICT DO NOTHING;

  INSERT INTO public.helios_historical_reconciliation_report (
    source_type, source_fingerprint, tenant_id, classification, evidence, affected_rows
  )
  SELECT
    'gateway_log',
    md5(l.id::text),
    l.tenant_id,
    'recovery_loop',
    jsonb_build_object('event_type', l.event_type),
    0
  FROM public.helios_gateway_logs l
  WHERE l.event_type IN ('RECOVERY_LOOP_30', 'RECOVERY_LOOP_DETECTED')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.helios_historical_reconciliation_report (
    source_type, source_fingerprint, tenant_id, classification, evidence, affected_rows
  )
  SELECT
    'conversation_day',
    md5(
      l.tenant_id || ':' || COALESCE(l.conversation_id, 'unknown') || ':' || (l.created_at::date)::text
    ),
    l.tenant_id,
    'multiple_publications',
    jsonb_build_object(
      'day', l.created_at::date,
      'publication_count', count(*)
    ),
    0
  FROM public.helios_gateway_logs l
  WHERE l.event_type = 'CHATWOOT_REPLY_SENT'
  GROUP BY l.tenant_id, l.conversation_id, l.created_at::date
  HAVING count(*) > 1
  ON CONFLICT DO NOTHING;

  INSERT INTO public.helios_historical_reconciliation_report (
    source_type, source_fingerprint, tenant_id, classification, evidence, affected_rows
  )
  SELECT
    'processing_batch',
    md5(b.batch_key),
    b.tenant_id,
    'historical_unknown',
    jsonb_build_object(
      'ai_status', b.ai_status,
      'delivery_status', b.delivery_status
    ),
    0
  FROM public.helios_processing_batches b
  WHERE b.processed_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.helios_chatwoot_outbox o
      WHERE o.batch_key = b.batch_key
        AND o.status = 'sent'
        AND o.chatwoot_outbound_message_id IS NOT NULL
    )
  ON CONFLICT DO NOTHING;

  RETURN QUERY
  SELECT r.classification, count(*)::bigint
  FROM public.helios_historical_reconciliation_report r
  GROUP BY r.classification
  ORDER BY r.classification;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_helios_gateway_history() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_helios_gateway_history() TO service_role;

COMMIT;

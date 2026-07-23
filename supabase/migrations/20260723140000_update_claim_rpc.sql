CREATE OR REPLACE FUNCTION public.claim_unprocessed_messages(p_max_conversations integer DEFAULT 20)
RETURNS TABLE (
    tenant_id text,
    conversation_id text,
    message_ids bigint[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function
DECLARE
    v_actual_limit integer;
    v_now timestamp with time zone := NOW();
BEGIN
    -- Sanitización del límite
    v_actual_limit := LEAST(GREATEST(p_max_conversations, 1), 100);

    RETURN QUERY
    WITH eligible_conversations AS (
        SELECT 
            b.tenant_id,
            b.conversation_id
        FROM public.helios_inbound_buffer b
        WHERE b.processed_at IS NULL
          AND b.failed_at IS NULL
          AND COALESCE(b.retry_count, 0) < 5
          AND (b.next_retry_at IS NULL OR b.next_retry_at <= v_now)
          AND (b.processing_started_at IS NULL OR b.processing_started_at <= v_now - INTERVAL '3 minutes')
          AND b.created_at <= v_now - INTERVAL '10 seconds'
        GROUP BY b.tenant_id, b.conversation_id
        ORDER BY MIN(b.created_at) ASC
        LIMIT v_actual_limit
    ),
    rows_to_claim AS (
        SELECT b.id, b.tenant_id, b.conversation_id
        FROM public.helios_inbound_buffer b
        INNER JOIN eligible_conversations e 
            ON b.tenant_id = e.tenant_id AND b.conversation_id = e.conversation_id
        WHERE b.processed_at IS NULL
          AND b.failed_at IS NULL
          AND COALESCE(b.retry_count, 0) < 5
          AND (b.next_retry_at IS NULL OR b.next_retry_at <= v_now)
          AND (b.processing_started_at IS NULL OR b.processing_started_at <= v_now - INTERVAL '3 minutes')
          AND b.created_at <= v_now - INTERVAL '10 seconds'
        FOR UPDATE OF b SKIP LOCKED
    ),
    updated_rows AS (
        UPDATE public.helios_inbound_buffer u
        SET processing_started_at = v_now
        FROM rows_to_claim r
        WHERE u.id = r.id
          AND u.processed_at IS NULL
          AND u.failed_at IS NULL
          AND COALESCE(u.retry_count, 0) < 5
        RETURNING r.tenant_id, r.conversation_id, r.id
    )
    SELECT 
        u.tenant_id,
        u.conversation_id,
        array_agg(u.id ORDER BY u.id ASC) as message_ids
    FROM updated_rows u
    GROUP BY u.tenant_id, u.conversation_id;
END;
$function;

REVOKE ALL ON FUNCTION public.claim_unprocessed_messages(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_unprocessed_messages(integer) TO service_role;
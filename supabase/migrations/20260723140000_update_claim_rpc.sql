CREATE OR REPLACE FUNCTION public.claim_unprocessed_messages(p_max_conversations integer)
RETURNS TABLE (
    tenant_id text,
    conversation_id text,
    message_ids bigint[],
    retry_count integer,
    processing_started_at timestamp with time zone,
    created_at timestamp with time zone
)
LANGUAGE plpgsql
AS $function
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT 
            b.tenant_id, 
            b.conversation_id, 
            array_agg(b.id ORDER BY b.created_at) as message_ids,
            MAX(COALESCE(b.retry_count, 0)) as retry_count,
            MIN(b.processing_started_at) as processing_started_at,
            MIN(b.created_at) as created_at
        FROM public.helios_inbound_buffer b
        WHERE b.processed_at IS NULL
          AND b.failed_at IS NULL
          AND COALESCE(b.retry_count, 0) < 5
          AND (b.next_retry_at IS NULL OR b.next_retry_at <= NOW())
          AND (b.processing_started_at IS NULL OR b.processing_started_at <= NOW() - INTERVAL '3 minutes')
          AND b.created_at <= NOW() - INTERVAL '10 seconds'
        GROUP BY b.tenant_id, b.conversation_id
        ORDER BY MIN(b.created_at) ASC
        LIMIT p_max_conversations
    ),
    updated AS (
        UPDATE public.helios_inbound_buffer t
        SET processing_started_at = NOW()
        FROM candidates c
        WHERE t.tenant_id = c.tenant_id
          AND t.conversation_id = c.conversation_id
          AND t.processed_at IS NULL
          AND t.failed_at IS NULL
          AND COALESCE(t.retry_count, 0) < 5
          AND (t.next_retry_at IS NULL OR t.next_retry_at <= NOW())
          AND (t.processing_started_at IS NULL OR t.processing_started_at <= NOW() - INTERVAL '3 minutes')
          AND t.created_at <= NOW() - INTERVAL '10 seconds'
        RETURNING t.tenant_id, t.conversation_id, t.processing_started_at
    )
    SELECT DISTINCT ON (c.tenant_id, c.conversation_id)
        c.tenant_id, 
        c.conversation_id, 
        c.message_ids,
        c.retry_count,
        u.processing_started_at,
        c.created_at
    FROM candidates c
    JOIN updated u ON c.tenant_id = u.tenant_id AND c.conversation_id = u.conversation_id;
END;
$function;
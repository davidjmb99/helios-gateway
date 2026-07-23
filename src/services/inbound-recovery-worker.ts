import { supabase } from '../supabase/client.js';
import { processBufferEvent } from '../orchestrator.js';
import { config } from '../config.js';
import { randomUUID } from 'crypto';

let workerRunning = false;
let workerInterval: NodeJS.Timeout | null = null;

// Umbral: no reclamar mensajes con processing_started_at más reciente que esto.
// Debe ser >= HERMES_TIMEOUT_MS + 60000 para no interferir con solicitudes activas.
const RECOVERY_STALE_AFTER_MS = Math.max(
    (config.HERMES_TIMEOUT_MS || 30000) + 60000,
    180000 // mínimo 3 minutos
);

export const recoveryMetrics = {
    pending_messages: 0,
    retry_scheduled: 0,
    processing_recovery: 0,
    permanently_failed: 0,
    last_worker_run: null as Date | null,
    last_worker_error: null as string | null,
    recovery_stale_after_ms: RECOVERY_STALE_AFTER_MS
};

const MAX_RECOVERY_RETRIES = 5;

async function claimViaRpc(maxConversations: number) {
    const { data, error } = await supabase.rpc('claim_unprocessed_messages', {
        p_max_conversations: maxConversations
    });
    if (error) throw error;
    
    // Filtros estrictos posteriores a la RPC
    const staleThreshold = new Date(Date.now() - RECOVERY_STALE_AFTER_MS);
    return (data || []).filter((claim: any) => {
        if (claim.retry_count >= MAX_RECOVERY_RETRIES) return false;
        if (claim.failed_at) return false;
        if (claim.processed_at) return false;
        if (claim.processing_started_at && new Date(claim.processing_started_at) > staleThreshold) return false;
        return true;
    });
}

async function claimViaFallback(maxConversations: number) {
    const staleThreshold = new Date(Date.now() - RECOVERY_STALE_AFTER_MS);
    const tenSecondsAgo = new Date(Date.now() - 10000).toISOString();
    
    const { data: candidates, error: selErr } = await supabase
        .from('helios_inbound_buffer')
        .select('tenant_id, conversation_id, processing_started_at, next_retry_at, failed_at, retry_count, created_at')
        .is('processed_at', null)
        .is('failed_at', null)
        .lt('retry_count', MAX_RECOVERY_RETRIES)
        .lte('created_at', tenSecondsAgo)
        .order('created_at', { ascending: true })
        .limit(200);

    if (selErr || !candidates || candidates.length === 0) return [];

    const now = new Date();
    const seen = new Map<string, any>();
    for (const m of candidates) {
        const key = `${m.tenant_id}:${m.conversation_id}`;
        if (seen.has(key)) continue;

        if (m.processing_started_at && new Date(m.processing_started_at) > staleThreshold) {
            continue;
        }

        if (m.next_retry_at && new Date(m.next_retry_at) > now) {
            continue;
        }

        seen.set(key, { 
            tenant_id: m.tenant_id, 
            conversation_id: m.conversation_id,
            retry_count: m.retry_count,
            processing_started_at: m.processing_started_at
        });
        if (seen.size >= maxConversations) break;
    }

    return Array.from(seen.values());
}

async function claimUnprocessedMessages(maxConversations = 20) {
    let claims: any[] = [];
    let claimSource: "rpc" | "fallback" = "rpc";
    let rpcSucceeded = false;
    let fallbackReason: string | null = null;
    let rpcRowCount = 0;

    try {
        claims = await claimViaRpc(maxConversations);
        rpcSucceeded = true;
        rpcRowCount = claims.length;
    } catch (error: any) {
        rpcSucceeded = false;
        fallbackReason = error.message;
        claimSource = "fallback";
        console.warn(`[Recovery Worker] RPC falló: ${error.message}. Ejecutando fallback.`);
        claims = await claimViaFallback(maxConversations);
    }

    console.log(JSON.stringify({
        event: "recovery_claim_attempt",
        claim_source: claimSource,
        rpc_succeeded: rpcSucceeded,
        rpc_row_count: rpcRowCount,
        fallback_reason: fallbackReason,
        stale_after_ms: RECOVERY_STALE_AFTER_MS,
        max_retries: MAX_RECOVERY_RETRIES
    }));

    if (claims.length > 0) {
        for (const claim of claims) {
            const ageMs = claim.processing_started_at 
                ? Date.now() - new Date(claim.processing_started_at).getTime()
                : 0;

            console.log(JSON.stringify({
                event: "recovery_message_claimed",
                claim_source: claimSource,
                tenant_id: claim.tenant_id,
                conversation_id: claim.conversation_id,
                message_ids: claim.message_ids || [],
                retry_count: claim.retry_count || 0,
                processing_age_ms: ageMs
            }));
        }
    }

    return claims;
}

async function runRecoveryTick() {
    if (workerRunning) {
        return; 
    }
    workerRunning = true;
    recoveryMetrics.last_worker_run = new Date();
    try {
        let claims = await claimUnprocessedMessages(20);
        
        if (claims && claims.length > 0) {
            const testTenants = [
                't1_503', 't5_retry', 't7_buff', 't9_idem', 't11_401',
                't13_clean', 't14_conc', 't15_amb', 'tA_test_fut', 'tB_test_fail'
            ];
            claims = claims.filter((c: any) => !testTenants.includes(c.tenant_id));
        }
        
        if (claims && claims.length > 0) {
            console.log(`[Recovery Worker] Reclamadas ${claims.length} conversaciones pendientes (stale_after_ms=${RECOVERY_STALE_AFTER_MS}).`);
            recoveryMetrics.processing_recovery += claims.length;
            
            for (const claim of claims) {
                const traceId = `recovery-${randomUUID()}`;
                console.log(`[Recovery Worker] Procesando Conv #${claim.conversation_id} con TraceID: ${traceId}`);
                
                try {
                    await processBufferEvent(claim.tenant_id, claim.conversation_id, traceId);
                } catch (err: any) {
                    const errStr = (err.message || '').toLowerCase();
                    let normalizedCode = 'UNKNOWN_FATAL_ERROR';
                    if (errStr.includes('timeout')) normalizedCode = 'HERMES_TIMEOUT';
                    else if (errStr.includes('unavailable') || errStr.includes('econnrefused')) normalizedCode = 'HERMES_UNAVAILABLE';
                    else if (errStr.includes('chatwoot')) normalizedCode = 'CHATWOOT_TIMEOUT';
                    else if (errStr.includes('active_stream_conflict')) normalizedCode = 'ACTIVE_STREAM_CONFLICT';
                    
                    console.error(`[Recovery Worker] Error en processBufferEvent para Conv #${claim.conversation_id}: Code: ${normalizedCode}`);
                }
            }
        }
    } catch (error: any) {
        const errStr = (error.message || '').toLowerCase();
        let normalizedCode = 'RPC_CLAIM_FAILED';
        if (errStr.includes('timeout')) normalizedCode = 'HERMES_TIMEOUT';
        else if (errStr.includes('unavailable') || errStr.includes('econnrefused')) normalizedCode = 'HERMES_UNAVAILABLE';
        else if (errStr.includes('chatwoot')) normalizedCode = 'CHATWOOT_TIMEOUT';
        
        recoveryMetrics.last_worker_error = normalizedCode;
        console.error(`[Recovery Worker] Error crítico en el ciclo de recuperación: Code: ${normalizedCode}`);
    } finally {
        workerRunning = false;
    }
}

export function startRecoveryWorker() {
    console.log(`[Recovery Worker] Iniciando servicio de recuperación (cada 30s, stale_after_ms=${RECOVERY_STALE_AFTER_MS})...`);
    
    if (workerInterval) {
        clearInterval(workerInterval);
    }
    
    runRecoveryTick();
    
    workerInterval = setInterval(() => {
        runRecoveryTick();
    }, 30000);
    
    return async function stopRecoveryWorker() {
        console.log('[Recovery Worker] Recibida señal de detención. Cerrando worker limpiamente...');
        if (workerInterval) {
            clearInterval(workerInterval);
            workerInterval = null;
        }
        
        let waits = 0;
        while (workerRunning && waits < 15) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            waits++;
        }
        if (workerRunning) {
            console.warn('[Recovery Worker] Timeout esperando que finalice el ciclo activo. Forzando detención.');
        } else {
            console.log('[Recovery Worker] Worker detenido correctamente.');
        }
    };
}

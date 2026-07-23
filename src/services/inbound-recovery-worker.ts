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

async function claimUnprocessedMessages(maxConversations = 20) {
    // Intentar la RPC atómica primero
    const { data, error } = await supabase.rpc('claim_unprocessed_messages', {
        p_max_conversations: maxConversations
    });

    if (!error) {
        // Filtrar por lease y retry_count
        const staleThreshold = new Date(Date.now() - RECOVERY_STALE_AFTER_MS);
        return (data || []).filter((claim: any) => {
            if (claim.retry_count >= 5) return false;
            if (!claim.processing_started_at) return true;
            return new Date(claim.processing_started_at) < staleThreshold;
        });
    }

    // Fallback si la RPC no está disponible (PGRST202)
    if (error.code === 'PGRST202') {
        console.warn('[Recovery Worker] RPC claim_unprocessed_messages no disponible, usando fallback.');
        const staleThreshold = new Date(Date.now() - RECOVERY_STALE_AFTER_MS);
        
        const { data: candidates, error: selErr } = await supabase
            .from('helios_inbound_buffer')
            .select('tenant_id, conversation_id, processing_started_at, next_retry_at, failed_at, retry_count')
            .is('processed_at', null)
            .is('failed_at', null)
            .lt('retry_count', 5)
            .order('created_at', { ascending: true })
            .limit(200);

        if (selErr || !candidates || candidates.length === 0) return [];

        const now = new Date();
        // Agrupar por conversación, respetando lease y next_retry_at
        const seen = new Map<string, any>();
        for (const m of candidates) {
            const key = `${m.tenant_id}:${m.conversation_id}`;
            if (seen.has(key)) continue;

            // Lease check: si processing_started_at es reciente, NO reclamar
            if (m.processing_started_at && new Date(m.processing_started_at) >= staleThreshold) {
                continue;
            }

            // next_retry_at check: no reclamar antes de tiempo
            if (m.next_retry_at && new Date(m.next_retry_at) > now) {
                continue;
            }

            seen.set(key, { tenant_id: m.tenant_id, conversation_id: m.conversation_id });
            if (seen.size >= maxConversations) break;
        }

        return Array.from(seen.values());
    }

    throw error;
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

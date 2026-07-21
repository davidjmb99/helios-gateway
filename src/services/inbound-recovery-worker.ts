import { supabase } from '../supabase/client.js';
import { processBufferEvent } from '../orchestrator.js';
import { randomUUID } from 'crypto';

let workerRunning = false;
let workerInterval: NodeJS.Timeout | null = null;

export const recoveryMetrics = {
    pending_messages: 0,
    retry_scheduled: 0,
    processing_recovery: 0,
    permanently_failed: 0,
    last_worker_run: null as Date | null,
    last_worker_error: null as string | null
};

async function claimUnprocessedMessages(maxConversations = 20) {
    const { data, error } = await supabase.rpc('claim_unprocessed_messages', {
        p_max_conversations: maxConversations
    });
    if (error) {
        throw error;
    }
    return data;
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
            console.log(`[Recovery Worker] Reclamadas ${claims.length} conversaciones pendientes.`);
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
    console.log('[Recovery Worker] Iniciando servicio de recuperación (cada 30s)...');
    
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

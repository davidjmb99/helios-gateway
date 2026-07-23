import { config } from './config.js';
import { 
  idempotencyRepository, 
  bufferRepository, 
  stateRepository, 
  patientRepository, 
  financingRepository,
  logsRepository
} from './repositories/database.js';
import { callHermes } from './hermes/client.js';
import { runTools } from './tools/tool-runner.js';
import { chatwootClient } from './chatwoot/client.js';
import { debugTracker } from './debug/debug-tracker.js';
import { hermesStatusTracker } from './server.js';
import { normalizeProfilePatch, resolveChatwootAlias } from './utils/normalizeProfilePatch.js';

// Control de idempotencia en memoria para evitar flushes duplicados redundantes de la misma conversación en ventanas muy cortas de tiempo
const lastProcessedFlushes = new Map<string, number>();
// Lock por conversación: evita procesamiento paralelo de la misma conversación (respuestas duplicadas)
const activeProcessing = new Set<string>();

export function clearOrchestratorCache() {
  lastProcessedFlushes.clear();
  activeProcessing.clear();
}

export async function processBufferEvent(tenantId: string, conversationId: string, traceId: string): Promise<void> {
  const key = `${tenantId}:${conversationId}`;

  // Lock: si esta conversación ya está siendo procesada, re-encolar con delay
  if (activeProcessing.has(key)) {
    console.log(`[Orchestrator] Conv #${conversationId} ya en proceso. Reintento programado en 5s.`);
    setTimeout(() => processBufferEvent(tenantId, conversationId, traceId), 5000);
    return;
  }
  activeProcessing.add(key);

  const now = Date.now();
  
  if (lastProcessedFlushes.has(key)) {
    const lastTime = lastProcessedFlushes.get(key) || 0;
    if (now - lastTime < 2500) {
      console.log(`[Orchestrator] Ignorando ejecución de flush duplicada para Conv #${conversationId} (última hace menos de 2.5s)`);
      activeProcessing.delete(key);
      return;
    }
  }
  
  lastProcessedFlushes.set(key, now);

  // Limpiar entradas antiguas (>60s) para evitar fuga de memoria
  for (const [k, v] of lastProcessedFlushes) {
    if (now - v > 60000) lastProcessedFlushes.delete(k);
  }

  console.log(`[Orchestrator] Iniciando procesamiento de buffer para Conv #${conversationId}`);
  
  let phone = '';
  let resolvedPhone = '';
  let rawMessages: any[] = [];
  let contact_id = '';
  let inboxId = '';

  try {
    // 1. Obtener mensajes no procesados de esta conversación en el buffer correspondientes a la ráfaga (traceId)
    rawMessages = await bufferRepository.getUnprocessed(tenantId, conversationId, traceId);
    if (rawMessages.length === 0) {
      console.log(`[Orchestrator] No hay mensajes pendientes en el buffer para la conversación #${conversationId}.`);
      debugTracker.addTimelineStep(traceId, 'error', { message: 'No hay mensajes en buffer para consolidar.' });
      return;
    }

    // Actualizar el estado de depuración de todos los mensajes consolidados en este buffer
    for (const msg of rawMessages) {
      if (msg.trace_id) {
        debugTracker.updateEvent(msg.trace_id, { decision: 'processing' });
        debugTracker.addTimelineStep(msg.trace_id, 'buffer_consolidated', { conversationId });
        debugTracker.addTimelineStep(msg.trace_id, 'action_executed', { action: 'BUFFER_FLUSH_STARTED' });
      }
    }

    // 2. Extraer metadatos básicos para construir la consulta
    const firstMsg = rawMessages[0];
    contact_id = firstMsg.contact_id;
    inboxId = firstMsg.inbox_id;
    
    // Recuperar y normalizar el teléfono de forma robusta
    phone = firstMsg.phone || 
            firstMsg.raw_payload?.phone || 
            firstMsg.raw_payload?.sender?.phone_number || 
            firstMsg.raw_payload?.conversation?.contact_inbox?.source_id || 
            '';
                 
    if (phone && !phone.startsWith('+')) {
      // Si parece número internacional válido sin el +, se lo agregamos
      if (phone.length >= 8 && /^\d+$/.test(phone)) {
        phone = `+${phone}`;
      }
    }

    // 3. Consolidar el texto de todos los mensajes
    const sortedMessages = rawMessages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const consolidatedText = sortedMessages.map(m => m.body).join('\n');

    // 4. Consultar en Supabase el estado, perfil de paciente y caso de financiamiento EN PARALELO
    const [rawState, patientProfile, activeFinancing] = await Promise.all([
      stateRepository.getRefined(tenantId, conversationId, contact_id).catch((e: any) => {
        console.warn('[Orchestrator] Error leyendo conversation_state de Supabase. Usando fallback true:', e.message);
        return null;
      }),
      patientRepository.get(tenantId, contact_id).catch((e: any) => {
        console.warn('[Orchestrator] Error leyendo patientProfile de Supabase:', e.message);
        return null;
      }),
      financingRepository.getActive(tenantId, contact_id)
    ]);

    const state = rawState || {
      ai_enabled: true,
      status: 'new',
      pending_question: null,
      pending_intent: null,
      missing_fields: [],
      human_handoff_active: false,
      active_booking: null,
      financing: null,
      last_intent: null
    };

    // Asegurar defaults seguros
    const aiEnabled = state.ai_enabled !== false;
    
    // Si la conversación tiene human_handoff_active=true pero el estado es "error", 
    // asumimos que fue un fallo técnico y NO un handoff humano manual real. Por tanto, no bloqueamos la IA.
    const isTechnicalErrorHandoff = state.status === 'error' && state.human_handoff_active === true;
    const humanHandoffActive = isTechnicalErrorHandoff ? false : !!state.human_handoff_active;

    // Agregar log de timeline detallado AI_ENABLED_CHECK para depuración en todos los trace_ids consolidados
    for (const msg of rawMessages) {
      if (msg.trace_id) {
        debugTracker.addTimelineStep(msg.trace_id, 'action_executed', {
          action: "AI_ENABLED_CHECK",
          trace_id: msg.trace_id,
          tenant_id: tenantId,
          conversation_id: conversationId,
          contact_id: contact_id,
          ai_enabled: aiEnabled,
          ai_enabled_source: rawState ? "conversation_state" : "default_true",
          human_handoff_active: humanHandoffActive,
          human_handoff_source: isTechnicalErrorHandoff ? "recovered_from_technical_error" : (rawState ? "conversation_state" : "default_false"),
          will_process: aiEnabled && !humanHandoffActive,
          skip_reason: !aiEnabled ? "explicit_ai_disabled" : (humanHandoffActive ? "human_handoff_active" : null)
        });
      }
    }

    // Si la IA está pausada o en modo Handoff, no debemos procesar con Hermes ni responder de forma automática.
    if (!aiEnabled || humanHandoffActive) {
      console.log(`[Orchestrator] La IA está pausada o en modo Handoff para la conversación #${conversationId}. Ignorando.`);
      for (const msg of rawMessages) {
        if (msg.trace_id) {
          debugTracker.updateEvent(msg.trace_id, { 
            decision: 'ignored',
            reason: !aiEnabled ? 'explicit_ai_disabled' : 'human_handoff_active',
            source: 'conversation_state',
            ai_enabled: aiEnabled
          } as any);
          debugTracker.addTimelineStep(msg.trace_id, 'action_executed', { action: 'ignored_by_ai_disabled' });
        }
      }
      // Marcamos los mensajes del buffer como procesados para que no se queden acumulados
      const ids = rawMessages.map(m => m.id);
      await bufferRepository.markProcessed(ids);
      return;
    }

    // Resolver de forma robusta el número de teléfono con prioridades
    // Prioridad 1: state.phone (guardado en base de datos al recibir webhook)
    // Prioridad 2: patientProfile.phone (guardado proactivamente al recibir webhook)
    // Prioridad 3: normalización directa de primer mensaje del buffer
    resolvedPhone = state.phone || patientProfile?.phone || phone;

    // Detección de identidad: usar campos verificados de Supabase
    const isProfileComplete = patientProfile?.profile_complete === true ||
      !!(patientProfile?.first_name && patientProfile?.last_name && patientProfile?.email && resolvedPhone);

    // Resolver alias provisional de Chatwoot con función unificada
    const chatwootDisplayName = resolveChatwootAlias(firstMsg.raw_payload, patientProfile, state);
    
    // Persistir el alias provisional si no existe o cambió (para reutilizarlo en futuros webhooks sin nombre)
    if (chatwootDisplayName !== 'Contacto sin identificar' && patientProfile?.chatwoot_display_name !== chatwootDisplayName) {
      await patientRepository.upsert({
        tenant_id: tenantId,
        contact_id: contact_id,
        phone: resolvedPhone,
        chatwoot_display_name: chatwootDisplayName
      });
      // Actualizar el objeto local para evitar falsos "no guardado" en logs
      if (patientProfile) patientProfile.chatwoot_display_name = chatwootDisplayName;
    }

    const possibleFrustration = rawMessages.some(m => m.signals?.possible_frustration || false);
    const possibleEmergency = rawMessages.some(m => m.signals?.possible_emergency || false);
    const asksForHuman = rawMessages.some(m => m.signals?.asks_for_human || false);
    const asksForFinancing = rawMessages.some(m => m.signals?.asks_for_financing || false);

    const retryCount = Math.max(...rawMessages.map(m => m.retry_count || 0));
    const parentTraceId = retryCount > 0 ? rawMessages[0]?.trace_id : null;

    // 6. Preparar el payload limpio para Hermes con identidad real desde Supabase
    const payload = {
      event: "patient_message_ready",
      tenant_id: tenantId,
      clinic_id: config.CLINIC_ID || "coi_demo",
      channel: "chatwoot",
      conversation: {
        conversation_id: conversationId,
        contact_id: contact_id,
        inbox_id: inboxId,
        phone: resolvedPhone
      },
      patient: {
        profile_exists: !!patientProfile,
        profile_complete: isProfileComplete,
        first_name: isProfileComplete ? (patientProfile?.first_name || null) : null,
        last_name: isProfileComplete ? (patientProfile?.last_name || null) : null,
        name: isProfileComplete ? [patientProfile?.first_name, patientProfile?.last_name].filter(Boolean).join(' ') || patientProfile?.name || null : null,
        email: patientProfile?.email || null,
        phone: resolvedPhone,
        chatwoot_display_name: chatwootDisplayName,
        display_name_source: isProfileComplete ? "verified_profile" : "chatwoot"
      },
      state: {
        ai_enabled: state.ai_enabled,
        status: state.status,
        pending_question: state.pending_question || null,
        pending_intent: state.pending_intent || null,
        missing_fields: state.missing_fields || [],
        human_handoff_active: state.human_handoff_active,
        active_booking: state.active_booking || null,
        financing: activeFinancing ? { id: activeFinancing.id, status: activeFinancing.status } : null,
        last_intent: state.last_intent || null
      },
      message: {
        text: consolidatedText,
        message_count: rawMessages.length,
        messages: rawMessages.map(m => ({ id: m.message_id, body: m.body, created_at: m.created_at }))
      },
      clinic_context: {
        timezone: config.CLINIC_TIMEZONE || "Europe/Madrid",
        tone: config.CLINIC_TONE || "es-ES",
        first_visit_free: true,
        no_diagnosis: true,
        no_medication: true,
        prices_are_orientative: true
      },
      signals: {
        possible_frustration: possibleFrustration || asksForHuman,
        possible_emergency: possibleEmergency,
        asks_for_human: asksForHuman,
        asks_for_financing: asksForFinancing
      },
      metadata: {
        trace_id: traceId,
        source: "helios_gateway",
        retry_count: retryCount,
        parent_trace_id: parentTraceId
      }
    };

    // Registrar inicio de llamada Hermes Real siempre
    debugTracker.updateEvent(traceId, { decision: 'sent_to_hermes', hermesRequest: payload });
    debugTracker.addTimelineStep(traceId, 'hermes_request', payload);

    console.log(`[Orchestrator] HERMES_CALL_STARTED: Llamando a Hermes. TraceId: ${traceId}, Phone: ${phone}`);
    const adapterStartedAt = Date.now();
    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id,
      event_type: 'HERMES_CALL_STARTED',
      metadata: { message_count: rawMessages.length, phone, adapter_started_at: new Date(adapterStartedAt).toISOString() }
    });

    // Llamada HTTP real a Hermes
    const hermesResponse = await callHermes(payload, traceId);
    const adapterFinishedAt = Date.now();
    const adapterDurationMs = adapterFinishedAt - adapterStartedAt;
    hermesStatusTracker.lastCallFailed = false;

    debugTracker.updateEvent(traceId, { hermesResponse });
    debugTracker.addTimelineStep(traceId, 'hermes_response', hermesResponse);

    console.log(`[Orchestrator] HERMES_CALL_SUCCESS: Recibida respuesta de Hermes. TraceId: ${traceId}, adapter_duration_ms: ${adapterDurationMs}`);

    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id,
      event_type: 'HERMES_CALL_SUCCESS',
      route: hermesResponse.route,
      intent: hermesResponse.intent,
      metadata: {
        ...hermesResponse,
        adapter_started_at: new Date(adapterStartedAt).toISOString(),
        adapter_finished_at: new Date(adapterFinishedAt).toISOString(),
        adapter_duration_ms: adapterDurationMs
      }
    });

    // Interpretar resultados del Adapter: si safe_to_send=false o error_code presente o message_for_client vacío, NO publicar
    const replyText = hermesResponse.message_for_client || '';
    const safeToSend = hermesResponse.safe_to_send !== false;
    const hasErrorCode = !!hermesResponse.error_code;
    const ok = hermesResponse.ok !== false;

    // Si hay algún error según la regla estricta: operación no completada
    if (!ok || !safeToSend || hasErrorCode || typeof replyText !== 'string' || replyText.trim() === '') {
      const errorCode = hermesResponse.error_code || 'ADAPTER_UNSAFE_RESPONSE';
      console.warn(`[Orchestrator] ADAPTER_RESPONSE_INCOMPLETE: ok=${ok}, safe_to_send=${safeToSend}, error_code=${errorCode}. No publicar en Chatwoot. TraceId: ${traceId}`);

      // Dejar recuperable sin handoff técnico
      const ids = rawMessages.map(m => m.id);
      const retryCount = Math.max(...rawMessages.map(m => m.retry_count || 0));
      await bufferRepository.markRecoverableError(ids, errorCode, retryCount);
      
      await logsRepository.save({
        trace_id: traceId, tenant_id: tenantId, conversation_id: conversationId, contact_id: contact_id,
        event_type: 'ADAPTER_RESPONSE_INCOMPLETE',
        metadata: { error_code: errorCode, safe_to_send: safeToSend, ok: ok, recoverable: hermesResponse.recoverable, adapter_duration_ms: adapterDurationMs }
      });
      return; // No marcar processed, no publicar, no handoff técnico
    }

    if (replyText && safeToSend) {
      try {
        // Idempotency check para Chatwoot message
        // Buscamos si ya se envi en la db un event_type 'CHATWOOT_REPLY_SENT' para este trace_id
        // Para simplificar, usaremos un check en memoria con el traceId como response_idempotency_key
        const cacheKey = `chatwoot_reply_${traceId}`;
        if (lastProcessedFlushes.has(cacheKey)) {
            console.log(`[Orchestrator] Idempotency check: Chatwoot message ya enviado para trace ${traceId}`);
        } else {
            lastProcessedFlushes.set(cacheKey, Date.now());
            const chatwootSendStartedAt = Date.now();
            const messageObj = await chatwootClient.sendMessage(conversationId, replyText);
            const chatwootSendFinishedAt = Date.now();
            const chatwootSendDurationMs = chatwootSendFinishedAt - chatwootSendStartedAt;
            
            for (const msg of rawMessages) {
              if (msg.trace_id) {
                debugTracker.addAction(msg.trace_id, 'reply_sent_to_chatwoot', true, { 
                  reply: replyText,
                  delivery_mode: 'unified_buffer_consolidated_reply',
                  messages_consolidated_count: rawMessages.length,
                  chatwoot_send_duration_ms: chatwootSendDurationMs
                });
              }
            }

            console.log(`[Orchestrator] CHATWOOT_REPLY_SENT: Conv #${conversationId}, chatwoot_send_duration_ms: ${chatwootSendDurationMs}`);

            await logsRepository.save({
              trace_id: traceId,
              tenant_id: tenantId,
              conversation_id: conversationId,
              contact_id: contact_id,
              event_type: 'CHATWOOT_REPLY_SENT',
              metadata: {
                reply: replyText,
                chatwoot_message_id: messageObj?.id,
                adapter_duration_ms: adapterDurationMs,
                chatwoot_send_started_at: new Date(chatwootSendStartedAt).toISOString(),
                chatwoot_send_finished_at: new Date(chatwootSendFinishedAt).toISOString(),
                chatwoot_send_duration_ms: chatwootSendDurationMs
              }
            });
        }

      } catch (chatwootError: any) {
        console.error(`[Orchestrator] CHATWOOT_REPLY_FAILED: Error enviando respuesta a Chatwoot para Conv #${conversationId}:`, chatwootError.message);
        
        for (const msg of rawMessages) {
          if (msg.trace_id) {
            debugTracker.addAction(msg.trace_id, 'reply_sent_to_chatwoot', false, { error: chatwootError.message });
          }
        }

        await logsRepository.save({
          trace_id: traceId,
          tenant_id: tenantId,
          conversation_id: conversationId,
          contact_id: contact_id,
          event_type: 'CHATWOOT_REPLY_FAILED',
          error: chatwootError.message,
          metadata: { reply: replyText }
        });

        // Lanzar el error para que la conversación NO se marque como procesada si Chatwoot falló
        throw chatwootError;
      }
    }

    // Post-procesamiento: estado, perfil y herramientas (ya no bloquea la respuesta al paciente)

    // A. Aplicar parches de identidad si Hermes los retorna (profile_patch)
    const incomingPatch = hermesResponse.profile_patch || hermesResponse.patient_profile_update;
    if (incomingPatch) {
      const normalized = normalizeProfilePatch(patientProfile, incomingPatch, resolvedPhone);

      if (normalized.has_changes) {
        const upsertOk = await patientRepository.upsert({
          tenant_id: tenantId,
          contact_id: contact_id,
          phone: normalized.phone,
          first_name: normalized.first_name,
          last_name: normalized.last_name,
          name: normalized.name,
          email: normalized.email,
          profile_complete: normalized.profile_complete,
          crm_contact_id: normalized.crm_contact_id
        });

        if (upsertOk) {
          // Actualizar representación local para reconocer identidad en el mismo turno
          if (patientProfile) {
            patientProfile.first_name = normalized.first_name;
            patientProfile.last_name = normalized.last_name;
            patientProfile.name = normalized.name;
            patientProfile.email = normalized.email;
            patientProfile.profile_complete = normalized.profile_complete;
            patientProfile.crm_contact_id = normalized.crm_contact_id;
          }

          debugTracker.addAction(traceId, 'patient_profile_updated_in_supabase', true, {
            profile_complete: normalized.profile_complete,
            has_first_name: !!normalized.first_name,
            has_last_name: !!normalized.last_name,
            has_email: !!normalized.email,
            has_crm_id: !!normalized.crm_contact_id
          });

          await logsRepository.save({
            trace_id: traceId,
            tenant_id: tenantId,
            conversation_id: conversationId,
            contact_id: contact_id,
            event_type: 'patient_profile_updated',
            metadata: {
              profile_complete: normalized.profile_complete,
              has_first_name: !!normalized.first_name,
              has_last_name: !!normalized.last_name,
              has_email: !!normalized.email,
              has_crm_id: !!normalized.crm_contact_id
            }
          });
        } else {
          // Upsert falló — NO afirmar que el perfil fue sincronizado
          console.error(`[Orchestrator] PROFILE_UPSERT_FAILED: No se pudo persistir identidad para Conv #${conversationId}`);
          debugTracker.addAction(traceId, 'patient_profile_updated_in_supabase', false, {
            error: 'SUPABASE_UPSERT_FAILED'
          });

          await logsRepository.save({
            trace_id: traceId,
            tenant_id: tenantId,
            conversation_id: conversationId,
            contact_id: contact_id,
            event_type: 'PROFILE_UPSERT_FAILED',
            error: 'Supabase upsert returned error'
          });
        }
      }
    }

    // B. Aplicar parches del estado de conversación si Hermes los retorna (state_patch / state_update)
    const statePatch = hermesResponse.state_patch || hermesResponse.state_update;
    if (statePatch) {
      const su = statePatch;
      
      let nextAiEnabled = state.ai_enabled;
      let nextHandoffActive = state.human_handoff_active;
      
      // Si hay herramientas que indiquen deshabilitar IA
      const toolCalls = hermesResponse.tool_calls || [];
      const stateUpdateTool = toolCalls.find((tc: any) => tc.name === 'state.update');
      if (stateUpdateTool && stateUpdateTool.arguments) {
        if (stateUpdateTool.arguments.ai_enabled !== undefined) nextAiEnabled = stateUpdateTool.arguments.ai_enabled;
        if (stateUpdateTool.arguments.human_handoff_active !== undefined) nextHandoffActive = stateUpdateTool.arguments.human_handoff_active;
      }
      
      // Validar handoff: "Solo activar handoff cuando requires_handoff=true y la causa no sea tcnica"
      if (hermesResponse.handoff_required && !hasErrorCode) {
        nextHandoffActive = true;
      }

      await stateRepository.upsert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        inbox_id: inboxId,
        phone: phone,
        status: su.status !== undefined ? su.status : state.status,
        pending_question: su.pending_question !== undefined ? su.pending_question : state.pending_question,
        pending_intent: su.pending_intent !== undefined ? su.pending_intent : state.pending_intent,
        ai_enabled: nextAiEnabled,
        human_handoff_active: nextHandoffActive,
        last_intent: hermesResponse.intent || state.last_intent
      });

      debugTracker.addAction(traceId, 'state_saved_to_supabase', true, {
          status: su.status,
          pending_question: su.pending_question,
          pending_intent: su.pending_intent,
          human_handoff_active: nextHandoffActive
      });
      await logsRepository.save({
        trace_id: traceId, tenant_id: tenantId, conversation_id: conversationId, contact_id: contact_id,
        event_type: 'state_updated', metadata: su
      });
    }

    // C. Booking Patch
    if (hermesResponse.booking_patch && hermesResponse.booking_patch.booking_uid) {
        const bp = hermesResponse.booking_patch;
        await stateRepository.upsert({
          tenant_id: tenantId,
          conversation_id: conversationId,
          contact_id: contact_id,
          inbox_id: inboxId,
          phone: phone,
          active_booking: {
            booking_uid: bp.booking_uid,
            status: bp.status,
            start_time: bp.start_time,
            timezone: bp.timezone,
            service: bp.service,
            last_action: bp.last_action
          }
        });
        debugTracker.addAction(traceId, 'booking_saved', true, bp);
        await logsRepository.save({
            trace_id: traceId, tenant_id: tenantId, conversation_id: conversationId, contact_id: contact_id,
            event_type: 'booking_updated', metadata: bp
        });
    }

    // D. Operation & Tool Calls (Solo guardar metadatos seguros)
    if (hermesResponse.operation || (hermesResponse.tool_calls && hermesResponse.tool_calls.length > 0)) {
        const safeToolCalls = (hermesResponse.tool_calls || []).map((tc: any) => ({
            name: tc.name,
            status: tc.status,
            duration_ms: tc.duration_ms,
            result_code: tc.result_code
        }));
        
        const operationSummary = hermesResponse.operation ? {
            type: hermesResponse.operation.type,
            status: hermesResponse.operation.status,
            summary: hermesResponse.operation.summary,
            last_tool_name: hermesResponse.operation.last_tool_name,
            last_tool_status: hermesResponse.operation.last_tool_status,
            last_operation_at: hermesResponse.operation.last_operation_at
        } : null;

        debugTracker.addAction(traceId, 'operation_executed', true, { operation: operationSummary, tools: safeToolCalls });
        await logsRepository.save({
            trace_id: traceId, tenant_id: tenantId, conversation_id: conversationId, contact_id: contact_id,
            event_type: 'operation_log', metadata: { operation: operationSummary, tools: safeToolCalls }
        });
    }

    // E. Ejecutar las herramientas locales (legacy support)
    const localTools = (hermesResponse.tool_calls || []).filter((tc: any) => tc.name === 'handoff.create' || tc.name === 'state.update');
    if (localTools && localTools.length > 0) {
      const normalizedToolCalls = localTools.map((tc: any) => ({
        name: tc.name,
        arguments: tc.arguments || {}
      }));

      const toolResults = await runTools(normalizedToolCalls, {
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        phone: phone,
        trace_id: traceId
      });

      for (const tr of toolResults) {
        debugTracker.addAction(traceId, `tool:${tr.name}`, !tr.error, tr.result || { error: tr.error });
      }
    }

    // 14. Marcar todos los mensajes procesados del buffer
    const ids = rawMessages.map(m => m.id);
    await bufferRepository.markProcessed(ids, traceId);
    console.log(`[Orchestrator] Procesamiento exitoso para la conversación #${conversationId}.`);

    // Decidir visualmente el badge final de la conversación en base a la decisión/status que devuelva Hermes
    let finalDecision: 'processed' | 'identity_required' = 'processed';
    if (hermesResponse.decision === 'identity_required' || (statePatch && statePatch.status === 'waiting_patient_identity')) {
      finalDecision = 'identity_required';
    }

    for (const msg of rawMessages) {
      if (msg.trace_id) {
        debugTracker.updateEvent(msg.trace_id, { decision: finalDecision });
        debugTracker.addTimelineStep(msg.trace_id, 'action_executed', { action: 'BUFFER_FLUSH_COMPLETED' });
      }
    }

  } catch (error: any) {
    console.error(`[Orchestrator Error] Error procesando la conversación #${conversationId}:`, error.message);
    
    // Propagar error a todos los trace_ids consolidados
    if (typeof rawMessages !== 'undefined' && Array.isArray(rawMessages)) {
      for (const msg of rawMessages) {
        if (msg.trace_id) {
          debugTracker.updateEvent(msg.trace_id, { decision: 'error' });
          debugTracker.addTimelineStep(msg.trace_id, 'error', { message: error.message });
        }
      }
    } else {
      debugTracker.updateEvent(traceId, { decision: 'error' });
      debugTracker.addTimelineStep(traceId, 'error', { message: error.message });
    }
    
    // Indicar que la última llamada falló
    hermesStatusTracker.lastCallFailed = true;
    
    // Si Hermes falló (timeout o error de conexión), evitar respuestas mock locales
    console.warn(`[Orchestrator] CHATWOOT_REPLY_SKIPPED_DUE_TO_HERMES_ERROR: Evitando respuesta mock a Chatwoot para Conv #${conversationId}`);

    // Modificar estado en la conversación a error (pero manteniendo IA activada y sin handoff forzado por error transitorio)
    await stateRepository.upsert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id || 'unknown',
      inbox_id: inboxId || 'unknown',
      status: 'error',
      ai_enabled: true,
      human_handoff_active: false
    });

    // Clasificar y procesar el error según su tipo (Recuperable o Definitivo)
    if (typeof rawMessages !== 'undefined' && Array.isArray(rawMessages) && rawMessages.length > 0) {
      const ids = rawMessages.map(m => m.id);
      const errStr = (error.message || '').toLowerCase();
      
      const isRecoverable = 
        errStr.includes('503') || errStr.includes('502') || errStr.includes('504') || 
        errStr.includes('500') || errStr.includes('429') || errStr.includes('timeout') || errStr.includes('econnrefused');
      
      let errorCode = 'HERMES_CALL_FAILED';
      if (errStr.includes('timeout') && errStr.includes('chatwoot')) errorCode = 'CHATWOOT_TIMEOUT';
      else if (errStr.includes('timeout')) errorCode = 'HERMES_TIMEOUT';
      else if (errStr.includes('504')) errorCode = 'CHATWOOT_TIMEOUT';
      else if (errStr.includes('500')) errorCode = 'CHATWOOT_UNAVAILABLE';
      else if (errStr.includes('401') || errStr.includes('403') || errStr.includes('409')) errorCode = 'HERMES_CALL_FAILED';
      else if (errStr.includes('503') || errStr.includes('502')) errorCode = 'HERMES_UNAVAILABLE';

      if (isRecoverable) {
        // Obtener el retry_count máximo actual
        const maxRetryCount = Math.max(...rawMessages.map(m => m.retry_count || 0));
        if (maxRetryCount < 5) {
          await bufferRepository.markRecoverableError(ids, errorCode, maxRetryCount);
          console.log(`[Orchestrator Catch] Error recuperable (${errorCode}). Incrementando retry_count para ${ids.length} mensajes.`);
        } else {
          await bufferRepository.markFailed(ids, errorCode);
          console.error(`[Orchestrator Catch] Máximo de reintentos excedido (5) para la ráfaga. Marcando como FALLO DEFINITIVO.`);
        }
      } else {
        await bufferRepository.markFailed(ids, errorCode);
        console.error(`[Orchestrator Catch] Error definitivo no recuperable (${errorCode}). Marcando como fallido.`);
      }
    }

    // Registrar el error en base de datos con los nombres clave requeridos
    let event_type = 'HERMES_CALL_FAILED';
    if (error.message === 'HERMES_TIMEOUT') {
      event_type = 'HERMES_TIMEOUT';
    } else if (error.message === 'HERMES_DISABLED' || error.message === 'HERMES_BASE_URL_MISSING') {
      event_type = 'HERMES_NOT_CONFIGURED';
    } else if (error.code || error.message.includes('network') || error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
      event_type = 'HERMES_NETWORK_ERROR';
    }

    console.error(`[Orchestrator] ${event_type}: Error al interactuar con Hermes. TraceId: ${traceId}, Msg: ${error.message}`);

    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id || 'unknown',
      event_type: event_type,
      error: error.message,
      metadata: { code: error.code, phone: resolvedPhone }
    });

    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id || 'unknown',
      event_type: 'CHATWOOT_REPLY_SKIPPED_DUE_TO_HERMES_ERROR',
      metadata: { error: error.message, event_type }
    });
  } finally {
    activeProcessing.delete(key);
  }
}

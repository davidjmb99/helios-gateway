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

// Control de idempotencia en memoria para evitar flushes duplicados redundantes de la misma conversación en ventanas muy cortas de tiempo
const lastProcessedFlushes = new Map<string, number>();
// Lock por conversación: evita procesamiento paralelo de la misma conversación (respuestas duplicadas)
const activeProcessing = new Set<string>();

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

    // Detección de identidad incompleta
    // Para considerarse completo, el paciente debe tener perfil con nombre real y correo (no el default de Chatwoot)
    const isProfileComplete = !!(patientProfile?.name && patientProfile?.email && patientProfile.name !== 'Paciente de Chatwoot');

    // Resolver de forma robusta el nombre del paciente de Chatwoot
    // Prioridad 1: patientProfile.name (inicializado al recibir webhook)
    // Prioridad 2: metadatos del webhook original (si están disponibles)
    const chatwootDisplayName = patientProfile?.name || 
                                 firstMsg.raw_payload?.sender?.name || 
                                 firstMsg.raw_payload?.conversation?.meta?.sender?.name || 
                                 'David Mercado';

    const possibleFrustration = rawMessages.some(m => m.signals?.possible_frustration || false);
    const possibleEmergency = rawMessages.some(m => m.signals?.possible_emergency || false);
    const asksForHuman = rawMessages.some(m => m.signals?.asks_for_human || false);
    const asksForFinancing = rawMessages.some(m => m.signals?.asks_for_financing || false);

    // 6. Preparar el payload limpio para Hermes con la arquitectura correcta
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
        name: isProfileComplete ? patientProfile.name : null,
        email: patientProfile?.email || null,
        phone: resolvedPhone,
        chatwoot_display_name: chatwootDisplayName
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
        source: "helios_gateway"
      }
    };

    // Registrar inicio de llamada Hermes Real siempre
    debugTracker.updateEvent(traceId, { decision: 'sent_to_hermes', hermesRequest: payload });
    debugTracker.addTimelineStep(traceId, 'hermes_request', payload);

    console.log(`[Orchestrator] HERMES_CALL_STARTED: Llamando a Hermes. TraceId: ${traceId}, Phone: ${phone}`);
    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id,
      event_type: 'HERMES_CALL_STARTED',
      metadata: { message_count: rawMessages.length, phone }
    });

    // Llamada HTTP real a Hermes
    const hermesResponse = await callHermes(payload, traceId);
    hermesStatusTracker.lastCallFailed = false;

    debugTracker.updateEvent(traceId, { hermesResponse });
    debugTracker.addTimelineStep(traceId, 'hermes_response', hermesResponse);

    console.log(`[Orchestrator] HERMES_CALL_SUCCESS: Recibida respuesta de Hermes. TraceId: ${traceId}`);

    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id,
      event_type: 'HERMES_CALL_SUCCESS',
      route: hermesResponse.route,
      intent: hermesResponse.intent,
      metadata: hermesResponse
    });

    // ⚡ PRIORIDAD: Enviar respuesta a Chatwoot INMEDIATAMENTE (antes de post-procesamiento)
    const replyText = hermesResponse.reply_text || hermesResponse.reply || '';
    const safeToSend = hermesResponse.safe_to_send !== false;

    if (replyText && safeToSend) {
      try {
        await chatwootClient.sendMessage(conversationId, replyText);
        
        for (const msg of rawMessages) {
          if (msg.trace_id) {
            debugTracker.addAction(msg.trace_id, 'reply_sent_to_chatwoot', true, { 
              reply: replyText,
              delivery_mode: 'unified_buffer_consolidated_reply',
              messages_consolidated_count: rawMessages.length
            });
          }
        }

        console.log(`[Orchestrator] CHATWOOT_REPLY_SENT: Mensaje enviado exitosamente a Chatwoot para Conv #${conversationId}`);

        await logsRepository.save({
          trace_id: traceId,
          tenant_id: tenantId,
          conversation_id: conversationId,
          contact_id: contact_id,
          event_type: 'CHATWOOT_REPLY_SENT',
          metadata: { reply: replyText }
        });
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
      }
    }

    // Post-procesamiento: estado, perfil y herramientas (ya no bloquea la respuesta al paciente)

    // A. Aplicar parches de identidad si Hermes los retorna (profile_patch)
    if (hermesResponse.profile_patch) {
      const up = hermesResponse.profile_patch;
      if (up.name || up.email) {
        await patientRepository.upsert({
          tenant_id: tenantId,
          contact_id: contact_id,
          phone: phone,
          name: up.name || patientProfile?.name,
          email: up.email || patientProfile?.email
        });

        debugTracker.addAction(traceId, 'patient_profile_updated_in_supabase', true, up);

        await logsRepository.save({
          trace_id: traceId,
          tenant_id: tenantId,
          conversation_id: conversationId,
          contact_id: contact_id,
          event_type: 'patient_profile_updated',
          metadata: up
        });
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
      const stateUpdateTool = toolCalls.find(tc => tc.name === 'state.update');
      if (stateUpdateTool) {
        if (stateUpdateTool.arguments.ai_enabled !== undefined) nextAiEnabled = stateUpdateTool.arguments.ai_enabled;
        if (stateUpdateTool.arguments.human_handoff_active !== undefined) nextHandoffActive = stateUpdateTool.arguments.human_handoff_active;
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
        missing_fields: su.missing_fields !== undefined ? su.missing_fields : state.missing_fields,
        ai_enabled: nextAiEnabled,
        human_handoff_active: nextHandoffActive,
        active_booking: su.active_booking !== undefined ? su.active_booking : state.active_booking,
        financing: su.financing !== undefined ? su.financing : state.financing,
        last_intent: hermesResponse.intent || state.last_intent
      });

      debugTracker.addAction(traceId, 'state_saved_to_supabase', true, su);

      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        event_type: 'state_updated',
        metadata: su
      });
    }

    // C. Ejecutar las herramientas si Hermes las indica
    if (hermesResponse.tool_calls && hermesResponse.tool_calls.length > 0) {
      const normalizedToolCalls = hermesResponse.tool_calls.map(tc => ({
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
    await bufferRepository.markProcessed(ids);
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

    // Marcar los mensajes del buffer como procesados en el catch por regla del problema 2
    if (typeof rawMessages !== 'undefined' && Array.isArray(rawMessages) && rawMessages.length > 0) {
      const ids = rawMessages.map(m => m.id);
      await bufferRepository.markProcessed(ids);
      console.log(`[Orchestrator Catch] Marcados ${ids.length} mensajes como procesados tras error.`);
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

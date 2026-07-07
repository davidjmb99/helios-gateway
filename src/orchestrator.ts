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

export async function processBufferEvent(tenantId: string, conversationId: string, traceId: string): Promise<void> {
  const key = `${tenantId}:${conversationId}`;
  const now = Date.now();
  
  if (lastProcessedFlushes.has(key)) {
    const lastTime = lastProcessedFlushes.get(key) || 0;
    if (now - lastTime < 2500) {
      console.log(`[Orchestrator] Ignorando ejecución de flush duplicada para Conv #${conversationId} (última hace menos de 2.5s)`);
      return;
    }
  }
  
  lastProcessedFlushes.set(key, now);

  console.log(`[Orchestrator] Iniciando procesamiento de buffer para Conv #${conversationId}`);
  
  let phone = '';
  let rawMessages: any[] = [];
  let contact_id = '';
  let inboxId = '';

  try {
    // 1. Obtener mensajes no procesados de esta conversación en el buffer
    rawMessages = await bufferRepository.getUnprocessed(tenantId, conversationId);
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

    // 4. Consultar en Supabase el estado, perfil de paciente y caso de financiamiento
    let rawState: any = null;
    try {
      rawState = await stateRepository.getRefined(tenantId, conversationId, contact_id);
    } catch (e: any) {
      console.warn('[Orchestrator] Error leyendo conversation_state de Supabase. Usando fallback true:', e.message);
    }

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

    let patientProfile = null;
    try {
      patientProfile = await patientRepository.get(tenantId, contact_id);
    } catch (e: any) {
      console.warn('[Orchestrator] Error leyendo patientProfile de Supabase:', e.message);
    }

    const activeFinancing = await financingRepository.getActive(tenantId, contact_id);

    // Detección de identidad incompleta
    // El paciente es nuevo/incompleto si no tiene registro de perfil guardado en helios_patient_profiles.
    const isProfileComplete = !!(patientProfile?.name && patientProfile?.email);
    const isNewPatient = !patientProfile || !isProfileComplete;

    // Chatwoot display name no verificado
    const chatwootDisplayName = firstMsg.raw_payload?.sender?.name || 
                                 firstMsg.raw_payload?.conversation?.meta?.sender?.name || 
                                 '';

    const possibleFrustration = rawMessages.some(m => m.signals?.possible_frustration || false);
    const possibleEmergency = rawMessages.some(m => m.signals?.possible_emergency || false);
    const asksForHuman = rawMessages.some(m => m.signals?.asks_for_human || false);
    const asksForFinancing = rawMessages.some(m => m.signals?.asks_for_financing || false);

    // 6. Preparar el payload limpio para Hermes
    const payload = {
      event: "patient_message_ready",
      tenant_id: tenantId,
      clinic_id: config.CLINIC_ID || "coi_demo",
      channel: "chatwoot",
      conversation: {
        conversation_id: conversationId,
        contact_id: contact_id,
        inbox_id: inboxId,
        phone: phone
      },
      patient: {
        is_new: isNewPatient,
        first_name: patientProfile?.name ? patientProfile.name.split(' ')[0] : null,
        last_name: patientProfile?.name && patientProfile.name.split(' ').length > 1 ? patientProfile.name.split(' ').slice(1).join(' ') : null,
        email: patientProfile?.email || null,
        phone: phone,
        chatwoot_display_name: chatwootDisplayName,
        profile_complete: isProfileComplete
      },
      state: {
        ai_enabled: state.ai_enabled,
        status: isNewPatient ? 'collecting_profile' : state.status,
        pending_question: state.pending_question || null,
        pending_intent: isNewPatient ? 'collect_patient_identity' : (state.pending_intent || null),
        missing_fields: isNewPatient ? ["first_name", "last_name", "email"] : (state.missing_fields || []),
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
      history: {
        summary: ""
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

    let replyText = '';

    if (isNewPatient) {
      console.log(`[Orchestrator] PATIENT_PROFILE_INCOMPLETE: El perfil del paciente está incompleto o es nuevo.`);
      
      // Registrar log correspondiente
      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        event_type: 'PATIENT_PROFILE_INCOMPLETE',
        metadata: { phone, is_new: true }
      });

      // FALLBACK LOCAL OBLIGATORIO PARA PACIENTE NUEVO:
      // Respondemos directamente pidiendo Nombre, Apellido y Correo sin arriesgar bloqueos con llamadas a Hermes.
      replyText = "¡Hola! Gracias por escribir al Centro Odontológico Integral. Para ayudarte mejor, ¿me indicas por favor tu nombre, apellido y correo electrónico?";

      console.log(`[Orchestrator] PATIENT_IDENTITY_REQUIRED: Identidad requerida. Omitiendo llamada externa a Hermes.`);
      
      const skippedHermesObj = {
        skipped_hermes: true,
        reason: "PATIENT_PROFILE_INCOMPLETE",
        decision: "IDENTITY_REQUIRED",
        reply_text: replyText
      };

      // Guardar detalle local simulado en el debugger
      for (const msg of rawMessages) {
        if (msg.trace_id) {
          debugTracker.updateEvent(msg.trace_id, { 
            hermesRequest: skippedHermesObj,
            hermesResponse: skippedHermesObj
          });
        }
      }

      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        event_type: 'PATIENT_IDENTITY_REQUESTED',
        metadata: { phone }
      });

    } else {
      // PACIENTE REGISTRADO: Llamamos a Hermes Real
      debugTracker.updateEvent(traceId, { decision: 'sent_to_hermes', hermesRequest: payload });
      debugTracker.addTimelineStep(traceId, 'hermes_request', payload);

      console.log(`[Orchestrator] HERMES_CALL_STARTED: Iniciando llamada a Hermes. TraceId: ${traceId}, Phone: ${phone}`);
      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        event_type: 'HERMES_CALL_STARTED',
        metadata: { message_count: rawMessages.length, phone }
      });

      const hermesResponse = await callHermes(payload, traceId);
      hermesStatusTracker.lastCallFailed = false;
      
      replyText = hermesResponse.reply || '';

      debugTracker.updateEvent(traceId, { hermesResponse });
      debugTracker.addTimelineStep(traceId, 'hermes_response', hermesResponse);

      console.log(`[Orchestrator] HERMES_CALL_SUCCESS: Llamada a Hermes completada con éxito. TraceId: ${traceId}`);

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

      // 10. Ejecutar las herramientas (tool_calls) dictadas por Hermes
      const normalizedToolCalls = (hermesResponse.tool_calls || []).map(tc => ({
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

      // 11. Actualizar el perfil del paciente si se detectaron nuevos datos
      if (hermesResponse.patient_profile_update) {
        const up = hermesResponse.patient_profile_update;
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

      // 12. Actualizar el estado de la conversación en base a la respuesta de Hermes
      if (hermesResponse.state_update) {
        const su = hermesResponse.state_update;
        
        let nextAiEnabled = state.ai_enabled;
        let nextHandoffActive = state.human_handoff_active;
        
        const stateUpdateTool = normalizedToolCalls.find(tc => tc.name === 'state.update');
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
    }

    // 13. Enviar la respuesta a Chatwoot
    if (replyText) {
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
    }

    // 14. Marcar todos los mensajes procesados del buffer
    const ids = rawMessages.map(m => m.id);
    await bufferRepository.markProcessed(ids);
    console.log(`[Orchestrator] Procesamiento exitoso para la conversación #${conversationId}.`);

    // Actualizar la decisión de todos los trace_ids consolidados en el debugger de forma visual
    const finalDecision = isNewPatient ? 'identity_required' : 'processed';
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
    
    // Si Hermes falló (timeout o error de conexión), registrar como ignorado debido a error
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
      metadata: { code: error.code, phone }
    });

    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id || 'unknown',
      event_type: 'CHATWOOT_REPLY_SKIPPED_DUE_TO_HERMES_ERROR',
      metadata: { error: error.message, event_type }
    });
  }
}

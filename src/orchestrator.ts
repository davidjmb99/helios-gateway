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

export async function processBufferEvent(tenantId: string, conversationId: string, traceId: string): Promise<void> {
  console.log(`[Orchestrator] Iniciando procesamiento de buffer para Conv #${conversationId}`);
  debugTracker.addTimelineStep(traceId, 'buffer_consolidated', { conversationId });

  let phone = '';

  try {
    // 1. Obtener mensajes no procesados de esta conversación en el buffer
    const rawMessages = await bufferRepository.getUnprocessed(tenantId, conversationId);
    if (rawMessages.length === 0) {
      console.log(`[Orchestrator] No hay mensajes pendientes en el buffer para la conversación #${conversationId}.`);
      debugTracker.addTimelineStep(traceId, 'error', { message: 'No hay mensajes en buffer para consolidar.' });
      return;
    }

    // 2. Extraer metadatos básicos para construir la consulta
    const firstMsg = rawMessages[0];
    const contact_id = firstMsg.contact_id;
    const inboxId = firstMsg.inbox_id;
    
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
    const state = await stateRepository.get(tenantId, conversationId) || {
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

    // Si la IA está pausada, no debemos procesar con Hermes ni responder de forma automática.
    if (state.ai_enabled === false || state.human_handoff_active === true) {
      console.log(`[Orchestrator] La IA está pausada o en modo Handoff para la conversación #${conversationId}. Ignorando.`);
      debugTracker.updateEvent(traceId, { decision: 'ignored' });
      debugTracker.addTimelineStep(traceId, 'action_executed', { action: 'ignored_by_ai_disabled' });
      // Marcamos los mensajes del buffer como procesados para que no se queden acumulados
      const ids = rawMessages.map(m => m.id);
      await bufferRepository.markProcessed(ids);
      return;
    }

    const patientProfile = await patientRepository.get(tenantId, contact_id);
    const activeFinancing = await financingRepository.getActive(tenantId, contact_id);

    // Detección de identidad incompleta
    // No confiamos en el name visual de Chatwoot; el paciente es nuevo/incompleto si no tiene registro de perfil guardado en helios_patient_profiles.
    const isProfileComplete = !!(patientProfile?.name && patientProfile?.email);
    const isNewPatient = !patientProfile || !isProfileComplete;

    if (isNewPatient) {
      console.log(`[Orchestrator] PATIENT_PROFILE_INCOMPLETE: El perfil del paciente está incompleto o es nuevo.`);
      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        event_type: 'PATIENT_PROFILE_INCOMPLETE',
        metadata: { phone, is_new: true }
      });
    }

    // 5. Construir los flags / señales basados en los mensajes recibidos
    const possibleFrustration = rawMessages.some(m => m.signals?.possible_frustration || false);
    const possibleEmergency = rawMessages.some(m => m.signals?.possible_emergency || false);
    const asksForHuman = rawMessages.some(m => m.signals?.asks_for_human || false);
    const asksForFinancing = rawMessages.some(m => m.signals?.asks_for_financing || false);

    // Chatwoot display name no verificado
    const chatwootDisplayName = firstMsg.raw_payload?.sender?.name || 
                                 firstMsg.raw_payload?.conversation?.meta?.sender?.name || 
                                 '';

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

    // Actualizar datos de depuración
    debugTracker.updateEvent(traceId, { decision: 'sent_to_hermes', hermesRequest: payload });
    debugTracker.addTimelineStep(traceId, 'hermes_request', payload);

    // 7. Registrar en el log que se llamará a Hermes
    console.log(`[Orchestrator] HERMES_CALL_STARTED: Iniciando llamada a Hermes. TraceId: ${traceId}, Phone: ${phone}`);
    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id,
      event_type: 'HERMES_CALL_STARTED',
      metadata: { message_count: rawMessages.length, phone }
    });

    // 8. Llamar a Hermes
    const hermesResponse = await callHermes(payload, traceId);
    
    // Si la llamada fue exitosa, marcar que no hay fallos
    hermesStatusTracker.lastCallFailed = false;
    
    // Actualizar respuesta en el tracker
    debugTracker.updateEvent(traceId, { hermesResponse });
    debugTracker.addTimelineStep(traceId, 'hermes_response', hermesResponse);

    console.log(`[Orchestrator] HERMES_CALL_SUCCESS: Llamada a Hermes completada con éxito. TraceId: ${traceId}`);

    // 9. Registrar la respuesta recibida
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

    if (isNewPatient || hermesResponse.intent === 'collect_patient_identity') {
      console.log(`[Orchestrator] PATIENT_IDENTITY_REQUESTED: Solicitando identidad al paciente nuevo.`);
      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        event_type: 'PATIENT_IDENTITY_REQUESTED',
        metadata: { phone }
      });
    }

    // 10. Ejecutar las herramientas (tool_calls) dictadas por Hermes (Excluyendo agenda si el perfil está incompleto)
    let filteredToolCalls = hermesResponse.tool_calls || [];
    if (isNewPatient) {
      // Filtrar herramientas de agenda / cal.com por seguridad
      filteredToolCalls = filteredToolCalls.filter(tc => !tc.name.startsWith('calcom') && !tc.name.includes('book') && !tc.name.includes('slot'));
    }

    const normalizedToolCalls = filteredToolCalls.map(tc => ({
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

    // Registrar los resultados de las herramientas en las acciones ejecutadas
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

    // 13. Si Hermes entrega una respuesta de texto ("reply"), enviarla a Chatwoot
    if (hermesResponse.reply) {
      await chatwootClient.sendMessage(conversationId, hermesResponse.reply);
      debugTracker.addAction(traceId, 'reply_sent_to_chatwoot', true, { reply: hermesResponse.reply });

      console.log(`[Orchestrator] CHATWOOT_REPLY_SENT: Mensaje enviado exitosamente a Chatwoot para Conv #${conversationId}`);

      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        event_type: 'CHATWOOT_REPLY_SENT',
        metadata: { reply: hermesResponse.reply }
      });
    }

    // 14. Marcar todos los mensajes procesados del buffer
    const ids = rawMessages.map(m => m.id);
    await bufferRepository.markProcessed(ids);
    console.log(`[Orchestrator] Procesamiento exitoso para la conversación #${conversationId}.`);

  } catch (error: any) {
    console.error(`[Orchestrator Error] Error procesando la conversación #${conversationId}:`, error.message);
    debugTracker.updateEvent(traceId, { decision: 'error' });
    debugTracker.addTimelineStep(traceId, 'error', { message: error.message });
    
    // Indicar que la última llamada falló
    hermesStatusTracker.lastCallFailed = true;
    
    // Si Hermes falló (timeout o error de conexión), registrar como ignorado debido a error
    console.warn(`[Orchestrator] CHATWOOT_REPLY_SKIPPED_DUE_TO_HERMES_ERROR: Evitando respuesta mock a Chatwoot para Conv #${conversationId}`);

    // Modificar estado en la conversación a error
    await stateRepository.upsert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: 'unknown',
      inbox_id: 'unknown',
      status: 'error',
      ai_enabled: true,
      human_handoff_active: true // Derivación opcional por seguridad en caso de fallo crítico
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
      contact_id: 'unknown',
      event_type: event_type,
      error: error.message,
      metadata: { code: error.code, phone }
    });

    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: 'unknown',
      event_type: 'CHATWOOT_REPLY_SKIPPED_DUE_TO_HERMES_ERROR',
      metadata: { error: error.message, event_type }
    });
  }
}

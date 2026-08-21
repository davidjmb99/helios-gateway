import { config } from './config.js';
import { ajustarUsoDelNombre } from './chatwoot/name-style.js';
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
import { debugTracker } from './debug/debug-tracker.js';
import {
  deriveMissingIdentityFields,
  deriveMissingBookingFields,
  evaluatePersistedProfile,
  normalizeProfilePatch,
  resolveChatwootAlias,
  resolveOperationalPhone
} from './utils/normalizeProfilePatch.js';
import { resolveTenantContextByTenantId } from './tenants/context.js';
import { maskPhoneForLog } from './utils/sanitizeForLog.js';
import { createBatchIdentity, createOutboxIdentity } from './durable/identity.js';
import { detectSignals } from './chatwoot/normalizer.js';
import { markEligibleIfAppointment, markExcluded } from './csat/service.js';
import { decidirCierre } from './csat/cierre.js';
import { fraseDeDisponibilidad } from './handoff/disponibilidad.js';
import { registrarTurnoDeCrm } from './services/crm-watch.js';
import { obtenerHorarioYVentana, leerContextoDeClinica } from './tenants/settings.js';
import { blockLead, markLeadInterest } from './leads/service.js';
import { pideQueNoLeEscriban } from './leads/messages.js';
import {
  deriveHandoffRequest,
  detectHandoffRequest,
  humanHandoffActiveFor,
  isHumanOwnedStage,
  normalizeHandoffRequest,
  resolveStage,
  type HandoffStage
} from './handoff/stage.js';
import {
  completeHandoff,
  escalateTechnicalFailure,
  loadHandoffContext,
  openHandoff,
  type OpenedHandoff
} from './handoff/service.js';
import { outboxRepository, processingBatchRepository } from './repositories/durable.js';
import { recordComponentError, recordComponentSuccess } from './services/component-health.js';
import { SupabaseOperationError } from './supabase/assert-success.js';

// Control de idempotencia en memoria para evitar flushes duplicados redundantes de la misma conversación en ventanas muy cortas de tiempo
const lastProcessedFlushes = new Map<string, number>();
// Lock por conversación: evita procesamiento paralelo de la misma conversación (respuestas duplicadas)
const activeProcessing = new Set<string>();

export interface ProcessingOutcomeFlags {
  hermesSucceeded: boolean;
  outboxCreated: boolean;
  statePatchApplied: boolean;
  bufferMarkedProcessed: boolean;
  stage: string;
}

export function classifyProcessingFailure(error: any, flags: ProcessingOutcomeFlags) {
  const isSupabaseError = error instanceof SupabaseOperationError
    || String(error?.code || '').startsWith('SUPABASE_');
  if (flags.hermesSucceeded) {
    return {
      component: isSupabaseError ? 'supabase' : (flags.outboxCreated ? 'postprocessing' : 'outbox'),
      eventType: isSupabaseError
        ? 'SUPABASE_WRITE_ERROR'
        : (flags.outboxCreated ? 'POSTPROCESSING_ERROR' : 'OUTBOX_ERROR'),
      stage: error?.operation || flags.stage,
      preserveHermesSuccess: true,
      markConversationError: false,
      markBufferAsHermesFailed: false,
      emitHermesFailureEvent: false,
      retryHermes: false,
      createAnotherOutbox: false
    };
  }
  return {
    component: 'hermes',
    eventType: 'HERMES_ERROR',
    stage: flags.stage,
    preserveHermesSuccess: false,
    markConversationError: true,
    markBufferAsHermesFailed: true,
    emitHermesFailureEvent: true,
    retryHermes: false,
    createAnotherOutbox: false
  };
}

export interface AiGateDecision {
  /** Falso significa: persistir el mensaje y NO llamar al Adapter ni a Hermes. */
  process: boolean;
  stage: HandoffStage;
  stage_source: string;
  ai_enabled: boolean;
  skip_reason: 'explicit_ai_disabled' | 'human_mode_stage' | null;
}

/**
 * Decide si la IA puede intervenir (ítem 16 del check list). Pura a propósito:
 * es la regla que garantiza cero llamadas a Hermes en modo humano y tiene que
 * poder comprobarse sin base de datos.
 */
export function evaluateAiGate(rawState: any): AiGateDecision {
  const { stage, source } = resolveStage(rawState);
  const aiEnabled = rawState ? rawState.ai_enabled !== false : true;
  const humanOwnsConversation = isHumanOwnedStage(stage);
  return {
    process: aiEnabled && !humanOwnsConversation,
    stage,
    stage_source: source,
    ai_enabled: aiEnabled,
    skip_reason: !aiEnabled
      ? 'explicit_ai_disabled'
      : (humanOwnsConversation ? 'human_mode_stage' : null)
  };
}

export function isTerminalProcessingBatch(batch: any): boolean {
  return batch?.ai_status === 'completed' || batch?.delivery_status === 'sent';
}

export function clearOrchestratorCache() {
  lastProcessedFlushes.clear();
  activeProcessing.clear();
}

/**
 * ¿Va a reintentarlo alguien de verdad?
 *
 * Marcar un fallo como «recuperable» solo tiene sentido si existe un worker que lo
 * vuelva a intentar. Con HELIOS_RECOVERY_MODE en `observe` o `disabled` NADIE
 * reprocesa: el mensaje queda marcado para reintento, el contador nunca llega a
 * cinco, la escalada por fallo definitivo NUNCA se dispara y el mensaje del
 * paciente se muere en silencio. Es exactamente lo que el requisito A prohíbe.
 *
 * Así que la pregunta correcta no es «¿es este fallo recuperable?» sino «¿hay
 * alguien que lo vaya a recuperar?». Si no lo hay, el fallo ES definitivo ahora
 * mismo y tiene que escalar a Soporte Técnico Helios en el primer intento.
 */
function aiRecoveryIsRunning(): boolean {
  return ['ai_only', 'full'].includes(config.HELIOS_RECOVERY_MODE);
}

export async function processBufferEvent(tenantId: string, conversationId: string, traceId: string): Promise<void> {
  const key = `${tenantId}:${conversationId}`;
  // Con el flag apagado, un handoff solo levanta el booleano legacy: sin efectos
  // en Chatwoot ni avisos al equipo. Es la palanca de rollback del bloque.
  const handoffEnabled = config.HELIOS_HANDOFF_ENABLED;

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
  let durableBatchKey = '';
  let durableBatchClaimed = false;
  let hermesSucceeded = false;
  let outboxCreated = false;
  let statePatchApplied = false;
  let bufferMarkedProcessed = false;
  let processingStage = 'buffer.claim';
  // A nivel de función: si algo falla DESPUÉS de abrir el handoff, el catch tiene
  // que poder terminar de entregarlo. Un handoff abierto sin avisar al equipo
  // deja la conversación bloqueada y a nadie atendiendo.
  let openedHandoff: OpenedHandoff | null = null;
  let handoffPatientSnapshot = {
    first_name: null as string | null,
    last_name: null as string | null,
    identity_complete: false,
    crm_synced: false
  };

  try {
    const tenantContext = resolveTenantContextByTenantId(tenantId);
    // 1. Obtener mensajes no procesados de esta conversación en el buffer correspondientes a la ráfaga (traceId)
    rawMessages = await bufferRepository.claimConversationMessages(tenantId, conversationId);
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

    // 4. Estado de la conversación. Se lee ANTES de crear el lote: un mensaje
    //    que llega en modo humano no debe generar batch, ni patient_message_ready,
    //    ni llegar al Adapter (ítem 16 del check list).
    processingStage = 'conversation_state.read';
    const rawState = await stateRepository.getRefined(tenantId, conversationId, contact_id)
      .catch((e: any) => {
        console.warn('[Orchestrator] Error leyendo conversation_state de Supabase. Usando fallback true:', e.message);
        return null;
      });

    const gate = evaluateAiGate(rawState);
    const stage = gate.stage;
    const humanOwnsConversation = isHumanOwnedStage(stage);

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

    const aiEnabled = gate.ai_enabled;

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
          stage,
          stage_source: gate.stage_source,
          human_handoff_active: humanOwnsConversation,
          will_process: aiEnabled && !humanOwnsConversation,
          skip_reason: !aiEnabled ? "explicit_ai_disabled" : (humanOwnsConversation ? "human_mode_stage" : null)
        });
      }
    }

    // Si la IA está pausada o la conversación pertenece a una persona, el mensaje
    // queda persistido en el buffer pero no se llama al Adapter ni a Hermes.
    if (!gate.process) {
      const skipReason = gate.skip_reason;
      console.log(`[Orchestrator] ${humanOwnsConversation ? `Conversación #${conversationId} en modo humano (stage=${stage})` : `IA pausada para la conversación #${conversationId}`}. No se llama a Hermes.`);
      for (const msg of rawMessages) {
        if (msg.trace_id) {
          debugTracker.updateEvent(msg.trace_id, {
            decision: 'ignored',
            reason: skipReason,
            source: 'conversation_state',
            ai_enabled: aiEnabled
          } as any);
          debugTracker.addTimelineStep(msg.trace_id, 'action_executed', {
            action: humanOwnsConversation ? 'HUMAN_MODE_MESSAGE_SKIPPED' : 'ignored_by_ai_disabled'
          });
        }
      }
      // Los mensajes ya están persistidos en helios_inbound_buffer (requisito C).
      // Marcarlos procesados solo impide que el recovery los reclame más tarde.
      processingStage = 'inbound_buffer.mark_processed';
      await bufferRepository.markProcessed(rawMessages.map(m => m.id));
      bufferMarkedProcessed = true;
      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id,
        event_type: humanOwnsConversation ? 'HUMAN_MODE_MESSAGE_SKIPPED' : 'AI_DISABLED_MESSAGE_SKIPPED',
        metadata: {
          stage,
          stage_source: gate.stage_source,
          handoff_id: rawState?.handoff_id || null,
          message_count: rawMessages.length,
          hermes_called: false,
          adapter_called: false
        }
      });
      return;
    }

    // El paciente vuelve a escribir en una conversación cerrada: la reabre. El
    // stage no puede quedarse en 'closed' mientras la IA la está atendiendo.
    if (stage === 'closed') {
      await stateRepository.upsert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id,
        inbox_id: inboxId,
        stage: 'bot_active',
        human_handoff_active: false
      });
    }

    const batchIdentity = createBatchIdentity({
      tenant_id: tenantId,
      account_id: tenantContext.account_id,
      conversation_id: conversationId,
      contact_id,
      source_message_ids: sortedMessages.map(message => message.message_id)
    });
    durableBatchKey = batchIdentity.batch_key;
    const batch = await processingBatchRepository.createOrGet({
      ...batchIdentity,
      tenant_id: tenantId,
      account_id: tenantContext.account_id,
      clinic_id: tenantContext.clinic_id,
      hermes_profile: tenantContext.hermes_profile,
      conversation_id: conversationId,
      contact_id,
      adapter_request_key: null
    }, traceId);

    if (isTerminalProcessingBatch(batch)) {
      hermesSucceeded = batch.ai_status === 'completed';
      outboxCreated = Boolean(batch.outbox_key) || batch.delivery_status === 'sent';
      processingStage = 'inbound_buffer.mark_processed';
      await bufferRepository.markProcessed(rawMessages.map(message => message.id), batch.batch_key);
      bufferMarkedProcessed = true;
      console.log(JSON.stringify({
        event: 'processing_batch_deduplicated',
        source_message_count: batchIdentity.source_message_count
      }));
      return;
    }

    const claimedBatch = await processingBatchRepository.claimAi(
      batchIdentity.batch_key,
      tenantId,
      traceId
    );
    if (!claimedBatch) {
      console.log(JSON.stringify({
        event: 'processing_batch_claim_skipped',
        reason: 'active_or_terminal'
      }));
      return;
    }
    durableBatchClaimed = true;

    // 5. Consultar en Supabase el perfil de paciente y el caso de financiamiento EN PARALELO
    const [patientProfile, activeFinancing] = await Promise.all([
      patientRepository.get(tenantId, contact_id).catch((e: any) => {
        console.warn('[Orchestrator] Error leyendo patientProfile de Supabase:', e.message);
        return null;
      }),
      financingRepository.getActive(tenantId, contact_id)
    ]);

    // Resolver de forma robusta el número de teléfono con prioridades
    // Prioridad 1: state.phone (guardado en base de datos al recibir webhook)
    // Prioridad 2: patientProfile.phone (guardado proactivamente al recibir webhook)
    // Prioridad 3: normalización directa de primer mensaje del buffer
    resolvedPhone = resolveOperationalPhone(state.phone, patientProfile?.phone, phone);

    // Detección de identidad: usar campos verificados de Supabase
    const profileStatus = evaluatePersistedProfile(
      patientProfile,
      resolvedPhone,
      tenantId,
      contact_id
    );
    const isProfileComplete = profileStatus.profileComplete;
    handoffPatientSnapshot = {
      first_name: profileStatus.identityComplete ? profileStatus.firstName : null,
      last_name: profileStatus.identityComplete ? profileStatus.lastName : null,
      identity_complete: profileStatus.identityComplete,
      crm_synced: profileStatus.crmSynced
    };
    const missingIdentityFields = deriveMissingIdentityFields(
      profileStatus,
      state.missing_fields
    );
    const missingBookingFields = deriveMissingBookingFields(profileStatus);

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

    // Las señales se recalculan aquí sobre el texto consolidado del lote.
    // No basta con leerlas de las filas: helios_inbound_buffer NO tiene columna
    // `signals`, así que m.signals es siempre undefined y todo salía en false.
    // Consecuencia real en producción: Hermes recibía las cuatro señales
    // apagadas en cada turno, y cada derivación se etiquetaba como «excepción
    // operativa» con prioridad alta en vez del motivo verdadero.
    // Se mantiene el OR con la fila para no romper los tests que construyen
    // mensajes en memoria con signals ya puestas.
    const batchSignals = detectSignals(consolidatedText);
    const possibleFrustration =
      rawMessages.some(m => m.signals?.possible_frustration || false) || batchSignals.possible_frustration;
    const possibleEmergency =
      rawMessages.some(m => m.signals?.possible_emergency || false) || batchSignals.possible_emergency;
    const asksForHuman =
      rawMessages.some(m => m.signals?.asks_for_human || false) || batchSignals.asks_for_human;
    const asksForFinancing =
      rawMessages.some(m => m.signals?.asks_for_financing || false) || batchSignals.asks_for_financing;

    const retryCount = Math.max(...rawMessages.map(m => m.retry_count || 0));
    const parentTraceId = retryCount > 0 ? rawMessages[0]?.trace_id : null;

    // Contexto del episodio humano: al volver a modo IA, Helios necesita poder
    // consultar lo que se habló mientras la conversación fue de una persona
    // (requisito D del bloque de handoff).
    const handoffContext = await loadHandoffContext(tenantId, conversationId, rawState);

    // El horario, el tono y la zona de ESTA clinica. Si no se pueden leer se sigue
    // con los del entorno: un ajuste que no se puede consultar no puede dejar a un
    // paciente sin respuesta.
    const contextoDeClinica = await leerContextoDeClinica(tenantId).catch(() => ({
      horario: null,
      tono: null,
      zona: config.CLINIC_TIMEZONE || 'Europe/Madrid',
      direccion: null
    }));

    // 6. Preparar el payload limpio para Hermes con identidad real desde Supabase
    const payload = {
      event: "patient_message_ready",
      account_id: tenantContext.account_id,
      tenant_id: tenantId,
      clinic_id: tenantContext.clinic_id,
      hermes_profile: tenantContext.hermes_profile,
      channel: "chatwoot",
      conversation: {
        conversation_id: conversationId,
        contact_id: contact_id,
        inbox_id: inboxId,
        phone: resolvedPhone
      },
      patient: {
        profile_exists: profileStatus.profileExists,
        // IDENTIFICADO Y RESERVABLE SON DOS COSAS DISTINTAS desde el 21-ago-2026.
        // identity_complete = se sabe QUIEN es -nombre, apellido, telefono usable-, y
        // con eso ya se crea el contacto en el CRM. booking_ready = ademas hay correo
        // valido, que es lo que hace falta para que Cal.com mande la confirmacion.
        //
        // Asi Helios pide nombre y apellido cuando alguien nuevo escribe, y el correo
        // solo cuando va a agendar: pedirlo todo de golpe en el primer mensaje suena a
        // interrogatorio y en Venezuela chirria.
        identity_complete: profileStatus.identityComplete,
        booking_ready: profileStatus.bookingReady,
        crm_synced: profileStatus.crmSynced,
        profile_complete: isProfileComplete,
        first_name: profileStatus.identityComplete ? profileStatus.firstName : null,
        last_name: profileStatus.identityComplete ? profileStatus.lastName : null,
        name: profileStatus.identityComplete
          ? [profileStatus.firstName, profileStatus.lastName].filter(Boolean).join(' ')
          : null,
        // El correo se manda SI LO HAY. Antes se condicionaba a identity_complete, que
        // exigia el correo, asi que la condicion era redundante; ahora la identidad no
        // lo incluye y esa condicion lo habria escondido justo cuando existe.
        email: profileStatus.email || null,
        phone: resolvedPhone,
        chatwoot_display_name: chatwootDisplayName,
        display_name_source: isProfileComplete ? "verified_profile" : "chatwoot"
      },
      state: {
        ai_enabled: state.ai_enabled,
        status: state.status,
        stage,
        pending_question: state.pending_question || null,
        pending_intent: state.pending_intent || null,
        missing_fields: missingIdentityFields,
        // Lo que falta para RESERVAR, aparte de lo que falta para identificar. Sin
        // esto Helios no tendria forma de saber que solo le falta el correo.
        missing_booking_fields: missingBookingFields,
        // Derivado de stage, no leído en crudo: aquí siempre es false porque el
        // gate de modo humano ya devolvió antes de llegar a este punto.
        human_handoff_active: humanHandoffActiveFor(stage),
        active_booking: state.active_booking || null,
        financing: activeFinancing ? { id: activeFinancing.id, status: activeFinancing.status } : null,
        last_intent: state.last_intent || null
      },
      ...(handoffContext ? { human_handoff: handoffContext } : {}),
      message: {
        text: consolidatedText,
        message_count: rawMessages.length,
        messages: rawMessages.map(m => ({ id: m.message_id, body: m.body, created_at: m.created_at }))
      },
      // EL CONTEXTO DE ESTA CLINICA, NO EL DEL ENTORNO.
      //
      // Aqui habia un fallo silencioso de los que peor sientan: el panel guardaba el
      // horario y el tono, decia «guardado», y a Hermes le seguian llegando los
      // valores de las variables de entorno. El horario semanal no se mandaba
      // siquiera. O sea que la pantalla de Ajustes era decorativa para estos dos
      // campos: se podia cambiar el horario y Helios seguia diciendo el de antes,
      // porque lo sabe por su SOUL.
      //
      // Y en multiclinica era peor que inutil: TODAS las clinicas habrian recibido
      // el horario y el tono de COI, que es lo que hay en el entorno.
      //
      // El horario solo viaja si la clinica lo ha configurado de verdad. Mandar el
      // horario por defecto haria creer a Hermes que es el real cuando nadie lo ha
      // confirmado, y de ahi a decirle a un paciente una hora inventada hay un paso.
      clinic_context: {
        timezone: contextoDeClinica.zona,
        tone: contextoDeClinica.tono || config.CLINIC_TONE || "es-ES",
        ...(contextoDeClinica.horario ? { clinic_hours: contextoDeClinica.horario } : {}),
        // LA DIRECCION VIAJA COMO DATO, NO COMO INSTRUCCION, y es deliberado.
        //
        // Estuvo escrita en el perfil de Hermes -«La clinica esta en Acarigua, CC
        // Mamanico, local 27»- y el modelo se NEGO a decirla: «no quiero darte una
        // direccion de memoria por si no es exacta». En el mismo minuto contesto el
        // horario sin dudar, porque el horario llegaba por aqui. La diferencia no es
        // el dato, es el canal: lo que viene en la peticion es un hecho, lo que esta
        // en el prompt compartido es un recuerdo del que el SOUL le enseña a
        // desconfiar -y bien, que es lo que evita que invente citas-.
        //
        // Solo se manda si la clinica la configuro. Sin direccion, Helios deriva; una
        // direccion inventada manda al paciente a otro sitio.
        ...(contextoDeClinica.direccion ? { clinic_address: contextoDeClinica.direccion } : {}),
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
        parent_trace_id: parentTraceId,
        batch_key: durableBatchKey,
        source_message_ids_hash: batchIdentity.source_message_ids_hash
      }
    };

    // Registrar inicio de llamada Hermes Real siempre
    debugTracker.updateEvent(traceId, { decision: 'sent_to_hermes', hermesRequest: payload });
    debugTracker.addTimelineStep(traceId, 'hermes_request', payload);

    console.log(`[Orchestrator] HERMES_CALL_STARTED: Llamando a Hermes. TraceId: ${traceId}, Phone: ${maskPhoneForLog(resolvedPhone)}`);
    const adapterStartedAt = Date.now();
    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contact_id,
      event_type: 'HERMES_CALL_STARTED',
      metadata: {
        message_count: rawMessages.length,
        phone: maskPhoneForLog(resolvedPhone),
        adapter_started_at: new Date(adapterStartedAt).toISOString()
      }
    });

    // Llamada HTTP real a Hermes
    processingStage = 'hermes.call';
    const hermesResponse = await callHermes(payload, traceId);
    hermesSucceeded = true;
    const adapterFinishedAt = Date.now();
    const adapterDurationMs = adapterFinishedAt - adapterStartedAt;
    recordComponentSuccess('adapter', adapterDurationMs);
    recordComponentSuccess('hermes', adapterDurationMs);

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
    //
    // ESTILO DEL NOMBRE, y va AQUÍ por un motivo que no es cosmético: la clave del
    // outbox se calcula a partir del CONTENIDO, así que el texto tiene que quedar
    // definitivo antes de eso. Ajustarlo después dejaría la clave sin corresponder
    // con lo que se manda, y esa clave es lo que impide enviar dos veces lo mismo.
    //
    // Se pasa el nombre VERIFICADO, nunca el alias de Chatwoot: el alias es lo que
    // el paciente tenga puesto en WhatsApp y puede ser cualquier cosa.
    const estiloNombre = ajustarUsoDelNombre(
      hermesResponse.message_for_client || '',
      profileStatus.identityComplete ? profileStatus.firstName : null
    );
    let replyText = estiloNombre.texto;
    if (estiloNombre.quitados > 0) {
      // Se registra el número para poder RESPONDER si esto sirve. El intento
      // anterior fue una regla en el prompt y, según el operador, «nunca funcionó»;
      // sin un contador no se puede saber si este sí.
      console.log(JSON.stringify({
        event: 'name_style_ajustado',
        trace_id: traceId,
        conversation_id: conversationId,
        quitados: estiloNombre.quitados,
        conservado: estiloNombre.conservado
      }));
    }
    const safeToSend = hermesResponse.safe_to_send !== false;
    const hasErrorCode = !!hermesResponse.error_code;
    const ok = hermesResponse.ok !== false;

    // Si hay algún error según la regla estricta: operación no completada
    if (!ok || !safeToSend || hasErrorCode || typeof replyText !== 'string' || replyText.trim() === '') {
      const errorCode = hermesResponse.error_code || 'ADAPTER_UNSAFE_RESPONSE';
      console.warn(`[Orchestrator] ADAPTER_RESPONSE_INCOMPLETE: ok=${ok}, safe_to_send=${safeToSend}, error_code=${errorCode}. No publicar en Chatwoot. TraceId: ${traceId}`);

      // Un fallo transitorio se deja recuperable y NO se convierte en handoff.
      // Solo cuando el fallo es definitivo escala a una persona (requisito A).
      const ids = rawMessages.map(m => m.id);
      const retryCount = Math.max(...rawMessages.map(m => m.retry_count || 0));
      const definitiveFailure = hermesResponse.recoverable === false
        || retryCount >= 5
        || !aiRecoveryIsRunning();
      if (definitiveFailure) {
        await bufferRepository.markFailed(ids, errorCode);
      } else {
        await bufferRepository.markRecoverableError(ids, errorCode, retryCount);
      }

      if (definitiveFailure && handoffEnabled) {
        await escalateTechnicalFailure({
          tenantContext,
          conversation_id: conversationId,
          contact_id,
          inbox_id: inboxId,
          phone: resolvedPhone,
          trace_id: traceId,
          trigger_key: durableBatchKey,
          error_code: errorCode,
          stage_of_failure: 'adapter_response_incomplete',
          // Aquí el lote SIEMPRE existe: hemos llegado a tener respuesta del
          // Adapter, así que se puede encolar el aviso al paciente.
          batch_key: durableBatchKey
        });
      }

      
      await logsRepository.save({
        trace_id: traceId, tenant_id: tenantId, conversation_id: conversationId, contact_id: contact_id,
        event_type: 'ADAPTER_RESPONSE_INCOMPLETE',
        metadata: { error_code: errorCode, safe_to_send: safeToSend, ok: ok, recoverable: hermesResponse.recoverable, adapter_duration_ms: adapterDurationMs }
      });
      if (durableBatchClaimed) {
        await processingBatchRepository.markAiFailed(
          durableBatchKey,
          tenantId,
          traceId,
          errorCode,
          hermesResponse.recoverable === false
        );
      }
      return; // No marcar processed, no publicar, no handoff técnico
    }

    // Handoff pedido por el modelo. El estado canónico se persiste ANTES de
    // encolar el mensaje al paciente: si el proceso muere en medio, la IA ya
    // está bloqueada y no puede seguir contestando por su cuenta (ítem 18).
    if (handoffEnabled && detectHandoffRequest(hermesResponse)) {
      processingStage = 'handoff.open';
      openedHandoff = await openHandoff({
        tenantContext,
        conversation_id: conversationId,
        contact_id,
        inbox_id: inboxId,
        phone: resolvedPhone,
        trace_id: traceId,
        trigger_key: durableBatchKey,
        request: normalizeHandoffRequest(
          deriveHandoffRequest({
            modelHandoff: (hermesResponse as any).handoff,
            signals: {
              possible_emergency: possibleEmergency,
              asks_for_human: asksForHuman,
              possible_frustration: possibleFrustration
            },
            patientMessage: consolidatedText,
            operationSummary: hermesResponse.operation?.summary ?? null
          }),
          'model'
        )
      });

      // Encuesta de satisfacción: una conversación que ha necesitado a una
      // persona queda fuera, por decisión del operador. Se guarda el motivo MÁS
      // ESPECÍFICO que se conozca, no un simple «hubo handoff»: así el recuento
      // de exclusiones sirve como métrica de calidad y no solo como descarte.
      const motivoLead = openedHandoff.request.reason_code === 'complaint'
        ? 'complaint'
        : 'human_handoff';
      await markExcluded({
        tenantId,
        conversationId,
        contactId: contact_id,
        traceId,
        reason: motivoLead
      });
      // A quien lleva una persona, o se fue enfadado, no se le hace seguimiento
      // comercial. No es el momento de vender.
      await blockLead({
        tenantId, conversationId, contactId: contact_id, traceId, reason: motivoLead
      });
    }

    // Frustración detectada por texto: fuera de la encuesta aunque no se haya
    // llegado a derivar. Se usa la señal CRUDA, no la que se le manda a Hermes
    // (que suma asks_for_human): pedir un humano no es estar enfadado.
    // Salida fácil del seguimiento comercial. Se comprueba sobre el texto del
    // paciente, no sobre lo que interprete el modelo: es una petición explícita y
    // debe cumplirse igual aunque el modelo no la mencione.
    if (pideQueNoLeEscriban(consolidatedText)) {
      await blockLead({
        tenantId, conversationId, contactId: contact_id, traceId, reason: 'opted_out'
      });
    }

    if (possibleFrustration) {
      await markExcluded({
        tenantId,
        conversationId,
        contactId: contact_id,
        traceId,
        reason: 'frustration'
      });
      await blockLead({
        tenantId, conversationId, contactId: contact_id, traceId, reason: 'complaint'
      });
    }

    let transitionOutboxKey: string | null = null;

    // DERIVACION ABIERTA EN ESTE TURNO: al texto que escribio Hermes se le pega la
    // disponibilidad real del equipo. Hermes dice «te paso con una persona» pero no
    // sabe si la clinica esta abierta, asi que a las once de la noche prometia una
    // atencion que no iba a llegar.
    //
    // VA AQUI Y NO DESPUES a proposito: la clave del outbox se deriva del
    // contenido (regla 59). Tocar el texto despues de calcularla dejaria la clave
    // sin corresponder con el mensaje y se perderia la proteccion contra enviar
    // dos veces lo mismo.
    if (replyText && safeToSend && openedHandoff) {
      try {
        const { horario, zona } = await obtenerHorarioYVentana(tenantId);
        const frase = fraseDeDisponibilidad({ ahora: new Date(), zona, horario });
        // Solo si Hermes no lo ha dicho ya por su cuenta: dos frases seguidas
        // diciendo lo mismo se leen como un error.
        if (frase && !/fuera del horario|horario de atenci/i.test(replyText)) {
          replyText = `${replyText} ${frase}`;
        }
      } catch {
        /* sin horario legible se manda el texto de Hermes tal cual */
      }
    }

    if (replyText && safeToSend) {
      processingStage = 'chatwoot_outbox.create';
      const outboxIdentity = createOutboxIdentity({
        tenant_id: tenantId,
        account_id: tenantContext.account_id,
        conversation_id: conversationId,
        contact_id,
        source_message_ids_hash: batchIdentity.source_message_ids_hash,
        content: replyText
      });
      const adapterRequestKey = (hermesResponse as any).request_key || durableBatchKey;

      // ¿Se acabó la conversación? Lo declara Hermes; el Gateway no lo deduce del
      // texto. La intención viaja EN LA FILA del outbox porque quien resuelve la
      // conversación es el worker, después de confirmar que la despedida llegó.
      const decisionDeCierre = decidirCierre({
        operation: hermesResponse.operation,
        statePatch: hermesResponse.state_patch || (hermesResponse as any).state_update,
        // En el Gateway el campo se llama handoff_required: el Adapter ya traduce
        // el requires_handoff del contrato. Se mira también la decisión, porque
        // needs_handoff puede llegar sin el booleano.
        requiresHandoff: hermesResponse.handoff_required === true
          || hermesResponse.decision === 'needs_handoff',
        humanoAlMando: isHumanOwnedStage(stage) || openedHandoff !== null,
        hayRespuesta: true
      });
      if (decisionDeCierre.cerrar) {
        console.log(JSON.stringify({
          event: 'cierre_automatico_programado',
          trace_id: traceId,
          tenant_id: tenantId,
          conversation_id: conversationId,
          motivo: decisionDeCierre.motivo
        }));
      }

      await outboxRepository.create({
        ...outboxIdentity,
        batch_key: durableBatchKey,
        tenant_id: tenantId,
        account_id: tenantContext.account_id,
        conversation_id: conversationId,
        contact_id,
        source_message_ids_hash: batchIdentity.source_message_ids_hash,
        adapter_request_key: adapterRequestKey,
        content: replyText,
        cerrar_conversacion: decisionDeCierre.cerrar
      }, traceId);
      outboxCreated = true;
      transitionOutboxKey = outboxIdentity.outbox_key;
      await processingBatchRepository.markAiCompleted(
        durableBatchKey,
        tenantId,
        traceId,
        outboxIdentity.outbox_key,
        adapterRequestKey
      );
      for (const msg of rawMessages) {
        if (msg.trace_id) {
          debugTracker.addAction(msg.trace_id, 'reply_queued_for_chatwoot', true, {
            delivery_mode: 'durable_outbox',
            messages_consolidated_count: rawMessages.length
          });
        }
      }
      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id,
        event_type: 'CHATWOOT_OUTBOX_CREATED',
        metadata: {
          batch_key: durableBatchKey,
          outbox_key: outboxIdentity.outbox_key,
          adapter_request_key: adapterRequestKey,
          message_count: rawMessages.length
        }
      });
      await logsRepository.save({
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id,
        event_type: 'DIRECT_REPLY_SKIPPED_OUTBOX_HANDLES_DELIVERY',
        metadata: {
          reason: 'outbox_delivery_active',
          hermes_succeeded: true,
          outbox_created: true,
          batch_key: durableBatchKey,
          outbox_key: outboxIdentity.outbox_key
        }
      });
    }

    // El mensaje de transición ya está encolado y es único: ahora se ejecutan
    // los efectos en Chatwoot, la alerta al equipo y el paso a human_queue.
    if (openedHandoff) {
      processingStage = 'handoff.complete';
      await completeHandoff({
        opened: openedHandoff,
        transition_outbox_key: transitionOutboxKey,
        patient: handoffPatientSnapshot
      });
      openedHandoff = null;
    }

    // La transcripción del episodio humano ya viajó en el payload: se marca
    // entregada para no reenviarla en cada turno posterior.
    if (handoffContext) {
      processingStage = 'conversation_state.handoff_context_delivered';
      await stateRepository.upsert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id,
        inbox_id: inboxId,
        handoff_context_delivered_at: new Date().toISOString()
      });
    }

    // Post-procesamiento: estado, perfil y herramientas (ya no bloquea la respuesta al paciente)

    // A. Aplicar parches de identidad si Hermes los retorna (profile_patch)
    const incomingPatch = hermesResponse.profile_patch || hermesResponse.patient_profile_update;
    if (incomingPatch) {
      const normalized = normalizeProfilePatch(patientProfile, incomingPatch, resolvedPhone);

      // ¿Este paciente llegó de verdad al CRM? Se mira el RESULTADO, no lo que
      // diga el modelo: si la identidad está completa y no hay identificador de
      // HubSpot, ese paciente no tiene ficha, se cuente lo que se cuente. Nada
      // vigilaba esto, y el acceso a HubSpot se renueva por OAuth: el día que la
      // renovación falle, Helios seguirá contestando con normalidad y la clínica se
      // quedará sin fichas sin que nadie se entere.
      registrarTurnoDeCrm(tenantId, {
        identidadCompleta: Boolean(
          normalized.first_name && normalized.last_name && normalized.email
        ),
        crmContactId: normalized.crm_contact_id,
        tipoDeOperacion: hermesResponse.operation?.type
      });

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
      let nextHandoffActive = humanHandoffActiveFor(stage);

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

      processingStage = 'conversation_state.upsert';
      await stateRepository.upsert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contact_id,
        inbox_id: inboxId,
        phone: resolvedPhone,
        status: su.status !== undefined ? su.status : state.status,
        pending_question: su.pending_question !== undefined ? su.pending_question : state.pending_question,
        pending_intent: su.pending_intent !== undefined ? su.pending_intent : state.pending_intent,
        ai_enabled: nextAiEnabled,
        // Un handoff ya abierto manda: este parche no puede devolver la
        // conversación a la IA por debajo de la máquina de estados. Sin handoff,
        // la clave stage NO se envía y la columna conserva su valor.
        human_handoff_active: openedHandoff ? true : nextHandoffActive,
        ...(openedHandoff ? { stage: 'human_queue' as const } : {}),
        last_intent: hermesResponse.intent || state.last_intent
      });
      statePatchApplied = true;

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
          phone: resolvedPhone,
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

        // Encuesta de satisfacción: una cita agendada o reprogramada CON ÉXITO es
        // lo que convierte la conversación en encuestable. El dato sale del propio
        // contrato de salida de Hermes, no de una interpretación del texto.
        await markEligibleIfAppointment({
            tenantId,
            conversationId,
            contactId: contact_id,
            traceId,
            operation: hermesResponse.operation
        });

        // Seguimiento de leads. Preguntar por huecos y no reservar deja un lead;
        // reservar de verdad lo cierra, porque escribirle "¿te sigue interesando?"
        // a quien ya tiene hora no es insistir: es no habernos enterado.
        const tipoOperacion = String(hermesResponse.operation?.type ?? '').toLowerCase();
        const operacionOk = String(hermesResponse.operation?.status ?? '').toLowerCase() === 'success';
        if (tipoOperacion === 'appointment_created' && operacionOk) {
            await blockLead({
                tenantId, conversationId, contactId: contact_id, traceId, reason: 'booked'
            });
        } else {
            await markLeadInterest({
                tenantId,
                conversationId,
                contactId: contact_id,
                traceId,
                operation: hermesResponse.operation
            });
        }
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
        phone: resolvedPhone,
        trace_id: traceId
      });

      for (const tr of toolResults) {
        debugTracker.addAction(traceId, `tool:${tr.name}`, !tr.error, tr.result || { error: tr.error });
      }
    }

    // 14. Marcar todos los mensajes procesados del buffer
    const ids = rawMessages.map(m => m.id);
    processingStage = 'inbound_buffer.mark_processed';
    await bufferRepository.markProcessed(ids, traceId);
    bufferMarkedProcessed = true;
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
    // Un handoff ya abierto tiene que llegar al equipo aunque el resto del turno
    // haya fallado: si no, la conversación queda bloqueada sin nota ni alerta.
    if (openedHandoff) {
      try {
        await completeHandoff({
          opened: openedHandoff,
          transition_outbox_key: null,
          patient: handoffPatientSnapshot
        });
        console.warn(JSON.stringify({
          event: 'handoff_completed_after_turn_failure',
          handoff_id: openedHandoff.handoff_id,
          failed_stage: processingStage
        }));
      } catch (completionError: any) {
        console.error(JSON.stringify({
          event: 'handoff_completion_after_failure_failed',
          handoff_id: openedHandoff.handoff_id,
          error_code: completionError?.code || 'HANDOFF_COMPLETION_FAILED'
        }));
      } finally {
        openedHandoff = null;
      }
    }

    const outcomeFlags: ProcessingOutcomeFlags = {
      hermesSucceeded,
      outboxCreated,
      statePatchApplied,
      bufferMarkedProcessed,
      stage: processingStage
    };
    const failure = classifyProcessingFailure(error, outcomeFlags);

    if (failure.preserveHermesSuccess) {
      const errorCode = String(error?.code || 'POSTPROCESSING_ERROR');
      if (failure.component === 'supabase') {
        recordComponentError('supabase', errorCode);
      }
      for (const msg of rawMessages) {
        if (msg.trace_id) {
          debugTracker.addTimelineStep(msg.trace_id, 'error', {
            component: failure.component,
            stage: failure.stage,
            error_code: errorCode,
            hermes_succeeded: true,
            outbox_created: outboxCreated
          });
        }
      }
      const diagnostic = error instanceof SupabaseOperationError
        ? {
            code: error.original_code,
            message: error.original_message,
            details: error.original_details,
            hint: error.original_hint
          }
        : { code: error?.code || null, message: null, details: null, hint: null };
      try {
        await logsRepository.save({
          trace_id: traceId,
          tenant_id: tenantId,
          conversation_id: conversationId,
          contact_id: contact_id || 'unknown',
          event_type: failure.eventType,
          metadata: {
            component: failure.component,
            stage: failure.stage,
            original_error_code: diagnostic.code,
            original_error_message: diagnostic.message,
            original_error_details: diagnostic.details,
            original_error_hint: diagnostic.hint,
            hermes_succeeded: true,
            outbox_created: outboxCreated,
            state_patch_applied: statePatchApplied,
            buffer_marked_processed: bufferMarkedProcessed
          }
        });
      } catch (logError: any) {
        console.error(JSON.stringify({
          event: 'postprocessing_error_log_failed',
          component: failure.component,
          stage: failure.stage,
          error_code: logError?.code || 'LOG_WRITE_FAILED'
        }));
      }
      console.error(JSON.stringify({
        event: failure.eventType,
        component: failure.component,
        stage: failure.stage,
        error_code: errorCode,
        hermes_succeeded: true,
        outbox_created: outboxCreated
      }));
      return;
    }
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
    
    const componentErrorCode = error?.code || error?.message || 'ORCHESTRATOR_FAILED';
    if (String(componentErrorCode).startsWith('SUPABASE_')) {
      recordComponentError('supabase', String(componentErrorCode));
    } else {
      recordComponentError('adapter', String(componentErrorCode), 'UNAVAILABLE');
    }
    
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

      const maxRetryCount = Math.max(...rawMessages.map(m => m.retry_count || 0));
      const definitiveFailure = !isRecoverable
        || maxRetryCount >= 5
        || !aiRecoveryIsRunning();
      if (isRecoverable) {
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
      if (durableBatchClaimed) {
        await processingBatchRepository.markAiFailed(
          durableBatchKey,
          tenantId,
          traceId,
          errorCode,
          definitiveFailure
        );
      }

      // Requisito A: un mensaje nunca puede quedar muerto. Agotados los
      // reintentos, la conversación pasa a una persona de Soporte Helios.
      if (definitiveFailure && config.HELIOS_HANDOFF_ENABLED) {
        try {
          await escalateTechnicalFailure({
            tenantContext: resolveTenantContextByTenantId(tenantId),
            conversation_id: conversationId,
            contact_id: contact_id || 'unknown',
            inbox_id: inboxId || 'unknown',
            phone: resolvedPhone,
            trace_id: traceId,
            trigger_key: durableBatchKey || `conversation:${conversationId}`,
            error_code: errorCode,
            stage_of_failure: processingStage,
            // Aquí el lote puede no existir todavía: si el fallo ocurrió antes de
            // crearlo no hay contra qué encolar, y el aviso al paciente lo escribe
            // recepción, que ya tiene la conversación asignada.
            batch_key: durableBatchClaimed ? durableBatchKey : null
          });
        } catch (escalationError: any) {
          console.error(JSON.stringify({
            event: 'handoff_technical_escalation_unavailable',
            error_code: escalationError?.code || 'TENANT_CONTEXT_UNAVAILABLE'
          }));
        }
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

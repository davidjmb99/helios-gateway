/**
 * Ejecución durable del handoff humano (ítems 18, 20 y 23).
 *
 * El orden es obligatorio y está partido en dos fases para que el estado sea
 * durable ANTES de que el paciente reciba el mensaje de transición:
 *
 *   openHandoff()      1. persistir handoff_requested + handoff_id
 *                      2. bloquear Hermes (consecuencia directa del stage)
 *   — el llamador encola el único mensaje de transición en el outbox —
 *   completeHandoff()  3. Chatwoot a open
 *                      4. escribir Helios Case ID, Stage y Clinical Priority
 *                      5. aplicar etiqueta
 *                      6. asignar equipo
 *                      7. crear una nota privada
 *                      8. registrar el mensaje de transición ya encolado
 *                      9. crear la alerta del equipo
 *                     10. persistir human_queue
 *
 * Si el proceso muere entre fases, el estado ya bloquea la IA y chatwoot_steps
 * permite reintentar sin repetir la nota, la etiqueta ni la alerta.
 */

import { config } from '../config.js';
import { chatwootClient } from '../chatwoot/client.js';
import { logsRepository, stateRepository, bufferRepository } from '../repositories/database.js';
import { handoffEventRepository, notificationOutboxRepository } from '../repositories/handoff.js';
import { createHandoffIdentity } from '../durable/identity.js';
import type { TenantContext } from '../tenants/context.js';
import {
  HandoffDestination,
  HandoffStage,
  NormalizedHandoffRequest,
  humanHandoffActiveFor
} from './stage.js';
import {
  HandoffRouting,
  conversationDeepLink,
  labelForStage,
  managedLabels,
  resolveHandoffRouting,
  DEFAULT_TRANSITION_MESSAGE
} from './routing.js';

export interface OpenHandoffInput {
  tenantContext: TenantContext;
  conversation_id: string;
  contact_id: string;
  inbox_id: string;
  phone: string;
  trace_id: string;
  /** Disparador estable: mismo disparador, mismo handoff_id. */
  trigger_key: string;
  request: NormalizedHandoffRequest;
}

export interface OpenedHandoff {
  handoff_id: string;
  created: boolean;
  routing: HandoffRouting;
  request: NormalizedHandoffRequest;
  destination_team_id: string | null;
  conversation_id: string;
  contact_id: string;
  inbox_id: string;
  phone: string;
  trace_id: string;
  tenantContext: TenantContext;
}

/** Prioridad de Chatwoot equivalente. 'normal' no tiene prioridad nativa. */
function nativePriority(priority: string): 'low' | 'medium' | 'high' | 'urgent' | null {
  if (priority === 'urgent') return 'urgent';
  if (priority === 'high') return 'high';
  if (priority === 'low') return 'low';
  return null;
}

const DESTINATION_LABELS: Record<string, string> = {
  reception: 'Recepción Clínica',
  clinical_lead: 'Responsable Clínico',
  helios_support: 'Soporte Helios'
};

const REASON_LABELS: Record<string, string> = {
  human_requested: 'el paciente pide hablar con una persona',
  clinical_question: 'pregunta clínica',
  possible_urgency: 'posible urgencia',
  complaint: 'queja',
  price_exception: 'excepción de precio',
  financing_exception: 'excepción de financiación',
  operational_exception: 'excepción operativa'
};

/**
 * Fase 1: el estado canónico. Es lo único que debe existir antes de que el
 * paciente reciba nada, porque es lo que impide que Hermes siga contestando.
 */
export async function openHandoff(input: OpenHandoffInput): Promise<OpenedHandoff> {
  const { tenantContext, request } = input;
  const routing = resolveHandoffRouting(tenantContext.tenant_id);
  const { handoff_id } = createHandoffIdentity({
    tenant_id: tenantContext.tenant_id,
    account_id: tenantContext.account_id,
    conversation_id: input.conversation_id,
    contact_id: input.contact_id,
    trigger_key: input.trigger_key
  });
  const destinationTeamId = routing.teams[request.destination] ?? null;
  const now = new Date().toISOString();

  const { created } = await handoffEventRepository.createOrGet({
    handoff_id,
    tenant_id: tenantContext.tenant_id,
    account_id: tenantContext.account_id,
    conversation_id: input.conversation_id,
    contact_id: input.contact_id,
    trace_id: input.trace_id,
    reason_code: request.reason_code,
    destination: request.destination,
    destination_team_id: destinationTeamId,
    priority: request.priority,
    summary: request.summary,
    treatment_interest: request.treatment_interest,
    origin: request.origin
  });

  const stage: HandoffStage = 'handoff_requested';
  await stateRepository.upsert({
    tenant_id: tenantContext.tenant_id,
    conversation_id: input.conversation_id,
    contact_id: input.contact_id,
    inbox_id: input.inbox_id,
    phone: input.phone,
    stage,
    handoff_id,
    handoff_reason: request.reason_code,
    handoff_priority: request.priority,
    handoff_destination: request.destination,
    handoff_requested_at: now,
    returned_to_bot_at: null,
    return_requested_at: null,
    human_handoff_active: humanHandoffActiveFor(stage)
  });

  await logsRepository.save({
    trace_id: input.trace_id,
    tenant_id: tenantContext.tenant_id,
    conversation_id: input.conversation_id,
    contact_id: input.contact_id,
    event_type: created ? 'HANDOFF_REQUESTED' : 'HANDOFF_REQUEST_DEDUPLICATED',
    metadata: {
      handoff_id,
      stage,
      reason_code: request.reason_code,
      destination: request.destination,
      destination_team_configured: Boolean(destinationTeamId),
      priority: request.priority,
      origin: request.origin,
      trigger_key: input.trigger_key
    }
  });

  return {
    handoff_id,
    created,
    routing,
    request,
    destination_team_id: destinationTeamId,
    conversation_id: input.conversation_id,
    contact_id: input.contact_id,
    inbox_id: input.inbox_id,
    phone: input.phone,
    trace_id: input.trace_id,
    tenantContext
  };
}

export interface CompleteHandoffInput {
  opened: OpenedHandoff;
  /** Clave del único mensaje de transición ya encolado en el outbox, si lo hay. */
  transition_outbox_key: string | null;
  /** Identidad verificada para la nota privada. Nunca el alias de Chatwoot. */
  patient: {
    first_name: string | null;
    last_name: string | null;
    identity_complete: boolean;
    crm_synced: boolean;
  };
  /**
   * Etapa final. Un handoff normal termina en human_queue; un fallo técnico
   * termina en handoff_failed, que es lo que espera Soporte Helios.
   */
  final_stage?: HandoffStage;
}

export interface CompleteHandoffResult {
  handoff_id: string;
  stage: HandoffStage;
  steps: Record<string, any>;
  failed_steps: string[];
  notification_key: string | null;
}

/**
 * Fase 2: efectos en Chatwoot, alerta al equipo y paso a human_queue.
 *
 * Cada paso se registra en chatwoot_steps y se omite si ya estaba hecho. Un
 * paso que falla no aborta los siguientes: el estado durable y el mensaje al
 * paciente ya están garantizados, y lo que falta se registra para reintento.
 */
export async function completeHandoff(input: CompleteHandoffInput): Promise<CompleteHandoffResult> {
  const { opened, transition_outbox_key } = input;
  const { tenantContext, routing, request } = opened;
  const accountId = tenantContext.account_id;
  const conversationId = opened.conversation_id;

  const finalStage: HandoffStage = input.final_stage ?? 'human_queue';

  const existing = await handoffEventRepository.getByHandoffId(opened.handoff_id);
  let steps: Record<string, any> = { ...(existing?.chatwoot_steps || {}) };
  const failedSteps: string[] = [];

  const runStep = async (name: string, action: () => Promise<Record<string, unknown> | void>) => {
    if (steps[name]?.done) return;
    try {
      const detail = (await action()) || {};
      steps = await handoffEventRepository.recordChatwootStep(
        opened.handoff_id,
        tenantContext.tenant_id,
        name,
        detail
      );
    } catch (error: any) {
      failedSteps.push(name);
      console.error(JSON.stringify({
        event: 'handoff_chatwoot_step_failed',
        step: name,
        handoff_id: opened.handoff_id,
        error_code: error?.code || error?.response?.status || 'CHATWOOT_ERROR'
      }));
    }
  };

  // 3. Chatwoot a open: la conversación tiene que aparecer en la bandeja.
  await runStep('status_open', async () => {
    await chatwootClient.setStatus(accountId, conversationId, 'open');
    return { status: 'open' };
  });

  // 4. Atributos personalizados. Las macros no pueden escribirlos.
  await runStep('custom_attributes', async () => {
    await chatwootClient.setCustomAttributes(accountId, conversationId, {
      [routing.attribute_keys.case_id]: opened.handoff_id,
      [routing.attribute_keys.stage]: finalStage,
      [routing.attribute_keys.priority]: request.priority
    });
    return { keys: Object.values(routing.attribute_keys) };
  });

  // Prioridad nativa, solo cuando hay una equivalente.
  const priority = nativePriority(request.priority);
  if (priority) {
    await runStep('native_priority', async () => {
      await chatwootClient.setPriority(accountId, conversationId, priority);
      return { priority };
    });
  }

  // 5. Etiqueta. Se fusiona con las existentes: POST /labels reemplaza la lista.
  await runStep('label', async () => {
    const label = labelForStage(routing, finalStage);
    const applied = label
      ? await chatwootClient.addLabelsPreserving(accountId, conversationId, [label])
      : [];
    return { label, resulting_label_count: applied.length };
  });

  // 6. Equipo. Si el tenant no tiene el ID configurado, se deja constancia.
  await runStep('assign_team', async () => {
    if (!opened.destination_team_id) {
      return { assigned: false, reason: 'team_not_configured', destination: request.destination };
    }
    await chatwootClient.assignTeam(accountId, conversationId, opened.destination_team_id);
    return { assigned: true, team_id: opened.destination_team_id };
  });

  // 7. Una sola nota privada.
  await runStep('private_note', async () => {
    const noteId = await chatwootClient.createHandoffPrivateNote(
      accountId,
      conversationId,
      buildPrivateNote(opened, input.patient)
    );
    return { chatwoot_message_id: noteId };
  });

  // 8. El mensaje de transición es único: lo encola el llamador en el outbox de
  //    Chatwoot, que ya garantiza entrega exactamente una vez.
  if (transition_outbox_key) {
    await runStep('transition_message', async () => ({ outbox_key: transition_outbox_key }));
  }

  // 9. Alerta al equipo, en su propio outbox.
  const notificationKey = `handoff:${opened.handoff_id}:telegram:created`;
  await runStep('team_notification', async () => {
    const { created } = await notificationOutboxRepository.create({
      notification_key: notificationKey,
      tenant_id: tenantContext.tenant_id,
      account_id: accountId,
      handoff_id: opened.handoff_id,
      conversation_id: conversationId,
      contact_id: opened.contact_id,
      channel: 'telegram',
      destination: routing.telegram_chat_id,
      payload: buildNotificationPayload(opened, input.patient)
    });
    return { notification_key: notificationKey, row_created: created, configured: Boolean(routing.telegram_chat_id) };
  });

  // 10. Etapa final: el handoff está entregado al equipo.
  await stateRepository.upsert({
    tenant_id: tenantContext.tenant_id,
    conversation_id: conversationId,
    contact_id: opened.contact_id,
    inbox_id: opened.inbox_id,
    phone: opened.phone,
    stage: finalStage,
    human_handoff_active: humanHandoffActiveFor(finalStage)
  });
  await handoffEventRepository.updateLifecycle(opened.handoff_id, tenantContext.tenant_id, {
    stage: finalStage,
    transition_outbox_key: transition_outbox_key || null,
    notification_key: notificationKey
  });

  await logsRepository.save({
    trace_id: opened.trace_id,
    tenant_id: tenantContext.tenant_id,
    conversation_id: conversationId,
    contact_id: opened.contact_id,
    event_type: failedSteps.length === 0 ? 'HANDOFF_EXECUTED' : 'HANDOFF_EXECUTED_PARTIAL',
    metadata: {
      handoff_id: opened.handoff_id,
      stage: finalStage,
      reason_code: request.reason_code,
      destination: request.destination,
      priority: request.priority,
      completed_steps: Object.keys(steps),
      failed_steps: failedSteps,
      transition_outbox_key: transition_outbox_key || null,
      notification_key: notificationKey
    }
  });

  return {
    handoff_id: opened.handoff_id,
    stage: finalStage,
    steps,
    failed_steps: failedSteps,
    notification_key: notificationKey
  };
}

/**
 * Nota privada (ítem 20): motivo, resumen, datos administrativos confirmados,
 * prioridad, acción requerida e identificadores.
 *
 * Deliberadamente NO incluye teléfono ni correo: Chatwoot ya muestra el
 * contacto y repetirlos solo añade PII. Tampoco incluye razonamiento interno
 * del modelo ni nada que se parezca a un diagnóstico.
 */
/**
 * Mención al equipo dentro de la nota privada. Chatwoot resuelve la mención por el
 * ID numérico —`(mention://team/{id}/{nombre})`, verificado en MentionService— y
 * notifica a todos sus miembros. Sin ID configurado no se inventa ninguna mención.
 */
export function teamMention(teamId: string | null, destination: HandoffDestination): string | null {
  const normalizedId = String(teamId ?? '').trim();
  if (!normalizedId) return null;
  const label = DESTINATION_LABELS[destination] || destination;
  const slug = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `[@${label}](mention://team/${normalizedId}/${slug})`;
}

export function buildPrivateNote(
  opened: OpenedHandoff,
  patient: CompleteHandoffInput['patient']
): string {
  const { request } = opened;
  const destination = DESTINATION_LABELS[request.destination] || request.destination;
  const mention = teamMention(opened.destination_team_id, request.destination);
  const reason = REASON_LABELS[request.reason_code] || request.reason_code;
  const identity = patient.identity_complete
    ? [patient.first_name, patient.last_name].filter(Boolean).join(' ') || 'identidad completa sin nombre legible'
    : 'identidad incompleta: el paciente aún no ha dado nombre, apellido y correo';

  const action = request.origin === 'technical_failure'
    ? 'Helios no ha podido atender el mensaje. Responder manualmente y avisar a Soporte Helios.'
    : 'Atender al paciente desde esta conversación. Al terminar, aplicar la macro de retorno para devolverla a Helios.';

  return [
    '🔻 Handoff de Helios',
    // La mención va arriba para que el equipo mencionado lo vea al abrir la nota.
    mention,
    '',
    `Motivo: ${reason} (${request.reason_code})`,
    `Prioridad: ${request.priority}`,
    `Destino: ${destination}`,
    request.summary ? `Resumen: ${request.summary}` : null,
    request.treatment_interest ? `Interés de tratamiento: ${request.treatment_interest}` : null,
    `Identidad: ${identity}`,
    `Alta en CRM: ${patient.crm_synced ? 'sí' : 'no'}`,
    '',
    `Acción requerida: ${action}`,
    '',
    `Helios Case ID: ${opened.handoff_id}`,
    `Conversación: ${opened.conversation_id}`,
    `Trace: ${opened.trace_id}`
  ].filter(line => line !== null).join('\n');
}

/**
 * Contenido de la alerta al equipo. Lleva el contexto mínimo y el enlace
 * directo a la conversación; nunca secretos ni PII innecesaria.
 */
export function buildNotificationPayload(
  opened: OpenedHandoff,
  patient: CompleteHandoffInput['patient']
): Record<string, unknown> {
  const { request, tenantContext } = opened;
  return {
    kind: 'handoff_created',
    handoff_id: opened.handoff_id,
    tenant_id: tenantContext.tenant_id,
    clinic_id: tenantContext.clinic_id,
    conversation_id: opened.conversation_id,
    reason_code: request.reason_code,
    reason_label: REASON_LABELS[request.reason_code] || request.reason_code,
    destination: request.destination,
    destination_label: DESTINATION_LABELS[request.destination] || request.destination,
    priority: request.priority,
    summary: request.summary,
    treatment_interest: request.treatment_interest,
    patient_first_name: patient.identity_complete ? patient.first_name : null,
    identity_complete: patient.identity_complete,
    origin: request.origin,
    conversation_url: conversationDeepLink(
      config.CHATWOOT_BASE_URL,
      tenantContext.account_id,
      opened.conversation_id
    )
  };
}

/** Texto del mensaje de transición para el paciente cuando el modelo no aporta uno. */
export function resolveTransitionMessage(tenantId: string, provided: string | null): string {
  const normalized = String(provided ?? '').trim();
  if (normalized) return normalized;
  const routing = resolveHandoffRouting(tenantId);
  return routing.transition_message || DEFAULT_TRANSITION_MESSAGE;
}

/**
 * Devuelve la conversación al bot (ítem 22). Idempotente: solo actúa desde
 * human_active, waiting_patient o return_requested, y repetirlo no duplica nada.
 */
export async function returnConversationToBot(input: {
  tenantContext: TenantContext;
  conversation_id: string;
  contact_id: string;
  inbox_id: string;
  phone: string;
  trace_id: string;
  handoff_id: string | null;
  accepted_by?: string | null;
}): Promise<void> {
  const { tenantContext } = input;
  const routing = resolveHandoffRouting(tenantContext.tenant_id);
  const now = new Date().toISOString();
  const stage: HandoffStage = 'bot_active';

  await stateRepository.upsert({
    tenant_id: tenantContext.tenant_id,
    conversation_id: input.conversation_id,
    contact_id: input.contact_id,
    inbox_id: input.inbox_id,
    phone: input.phone,
    stage,
    human_handoff_active: humanHandoffActiveFor(stage),
    ai_enabled: true,
    return_requested_at: null,
    returned_to_bot_at: now,
    handoff_id: null,
    handoff_reason: null,
    handoff_priority: null,
    handoff_destination: null
  });

  const failures: string[] = [];
  const attempt = async (name: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error: any) {
      failures.push(name);
      console.error(JSON.stringify({
        event: 'handoff_return_step_failed',
        step: name,
        error_code: error?.code || error?.response?.status || 'CHATWOOT_ERROR'
      }));
    }
  };

  await attempt('remove_labels', () => chatwootClient.removeLabelsPreserving(
    tenantContext.account_id,
    input.conversation_id,
    managedLabels(routing)
  ));
  await attempt('custom_attributes', () => chatwootClient.setCustomAttributes(
    tenantContext.account_id,
    input.conversation_id,
    { [routing.attribute_keys.stage]: 'bot_active', [routing.attribute_keys.case_id]: null }
  ));
  await attempt('status_pending', () => chatwootClient.setStatus(
    tenantContext.account_id,
    input.conversation_id,
    'pending'
  ));

  if (input.handoff_id) {
    await handoffEventRepository.updateLifecycle(input.handoff_id, tenantContext.tenant_id, {
      stage,
      status: 'resolved',
      returned_to_bot_at: now,
      resolved_at: now,
      human_accepted_by: input.accepted_by || null
    });
  }

  await logsRepository.save({
    trace_id: input.trace_id,
    tenant_id: tenantContext.tenant_id,
    conversation_id: input.conversation_id,
    contact_id: input.contact_id,
    event_type: 'HANDOFF_RETURNED_TO_BOT',
    metadata: {
      handoff_id: input.handoff_id,
      stage,
      returned_to_bot_at: now,
      failed_steps: failures
    }
  });
}

export interface HandoffContext {
  handoff_id: string | null;
  last_stage: string | null;
  requested_at: string | null;
  returned_to_bot_at: string | null;
  reason_code: string | null;
  transcript: Array<{ role: 'patient' | 'clinic_team'; text: string; at: string }>;
  truncated: boolean;
}

/**
 * Lo que se habló mientras la conversación estuvo en manos de una persona
 * (requisito D). Se lee del buffer durable: los mensajes del equipo se guardan
 * con direction='outgoing' y processed_at ya puesto.
 */
export async function loadHandoffContext(
  tenantId: string,
  conversationId: string,
  state: any
): Promise<HandoffContext | null> {
  const requestedAt = state?.handoff_requested_at || null;
  if (!requestedAt) return null;

  // Ya entregado para este episodio: no se reenvía en cada turno posterior.
  const deliveredAt = state?.handoff_context_delivered_at || null;
  if (deliveredAt && new Date(deliveredAt).getTime() >= new Date(requestedAt).getTime()) {
    return null;
  }

  // Ventana cerrada del episodio humano: desde que se pidió el handoff hasta
  // que la conversación volvió al bot.
  const until = state?.returned_to_bot_at || null;
  const limit = Math.max(1, config.HELIOS_HUMAN_TRANSCRIPT_LIMIT);
  const rows = await bufferRepository
    .listMessagesSince(tenantId, conversationId, requestedAt, limit + 1, until)
    .catch((error: any) => {
      console.warn(JSON.stringify({
        event: 'handoff_context_read_failed',
        error_code: error?.code || 'SUPABASE_ERROR'
      }));
      return [] as any[];
    });

  const truncated = rows.length > limit;
  const transcript = rows.slice(-limit).map((row: any) => ({
    role: row.direction === 'outgoing' ? ('clinic_team' as const) : ('patient' as const),
    text: String(row.body ?? ''),
    at: row.created_at
  }));

  return {
    handoff_id: state?.handoff_id || null,
    last_stage: state?.stage || null,
    requested_at: requestedAt,
    returned_to_bot_at: state?.returned_to_bot_at || null,
    reason_code: state?.handoff_reason || null,
    transcript,
    truncated
  };
}

/**
 * Requisito A: un mensaje nunca puede quedar muerto.
 *
 * Cuando el buffer agota los reintentos o el fallo es no recuperable, la
 * conversación pasa a Soporte Helios con stage handoff_failed. Deliberadamente
 * NO publica mensaje al paciente: el batch está en estado de fallo y crear una
 * fila de outbox contra él dejaría el lote en un estado de entrega inconsistente.
 * El aviso llega al equipo por la nota privada y por Telegram en segundos, y es
 * la persona quien escribe al paciente.
 */
export async function escalateTechnicalFailure(input: {
  tenantContext: TenantContext;
  conversation_id: string;
  contact_id: string;
  inbox_id: string;
  phone: string;
  trace_id: string;
  trigger_key: string;
  error_code: string;
  stage_of_failure: string;
}): Promise<CompleteHandoffResult | null> {
  try {
    const opened = await openHandoff({
      tenantContext: input.tenantContext,
      conversation_id: input.conversation_id,
      contact_id: input.contact_id,
      inbox_id: input.inbox_id,
      phone: input.phone,
      trace_id: input.trace_id,
      trigger_key: `technical:${input.trigger_key}:${input.error_code}`,
      request: {
        reason_code: 'operational_exception',
        destination: 'helios_support',
        priority: 'high',
        summary: `Helios no pudo atender el mensaje: ${input.error_code} en ${input.stage_of_failure}.`,
        treatment_interest: null,
        origin: 'technical_failure'
      }
    });

    return await completeHandoff({
      opened,
      transition_outbox_key: null,
      patient: {
        first_name: null,
        last_name: null,
        identity_complete: false,
        crm_synced: false
      },
      final_stage: 'handoff_failed'
    });
  } catch (error: any) {
    // El escalado no puede tapar el fallo original ni romper el manejo de error.
    console.error(JSON.stringify({
      event: 'handoff_technical_escalation_failed',
      original_error_code: input.error_code,
      escalation_error_code: error?.code || 'HANDOFF_ESCALATION_FAILED'
    }));
    return null;
  }
}

/**
 * Atajo para el camino del modelo: abre el handoff y devuelve el resultado sin
 * los efectos de Chatwoot, que el llamador ejecuta después de encolar el único
 * mensaje de transición.
 */
export async function requestHandoff(input: OpenHandoffInput): Promise<OpenedHandoff> {
  return openHandoff(input);
}

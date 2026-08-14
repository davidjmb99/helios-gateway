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
import { markExcluded } from '../csat/service.js';
import { blockLead } from '../leads/service.js';
import { chatwootClient } from '../chatwoot/client.js';
import { logsRepository, stateRepository, bufferRepository } from '../repositories/database.js';
import { handoffEventRepository, notificationOutboxRepository } from '../repositories/handoff.js';
import { outboxRepository } from '../repositories/durable.js';
import { createHandoffIdentity, createOutboxIdentity, shortFingerprint } from '../durable/identity.js';
import { ConversationRecap, buildRecap, renderRecap } from './recap.js';
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
  /** Quién ATIENDE al paciente y se queda la conversación asignada. */
  destination_team_id: string | null;
  /**
   * Quién más tiene que enterarse, sin quedarse la conversación. Hoy solo se usa
   * en los fallos técnicos: soporte arregla el error, pero NO atiende pacientes.
   */
  support_team_id: string | null;
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

/**
 * Nombres de los equipos TAL COMO EXISTEN EN CHATWOOT. No son decorativos: de
 * aquí sale el texto de la mención, así que si no coinciden con el equipo real el
 * equipo lee un nombre que no reconoce.
 *
 * Actualizados el 13-08-2026, cuando la clínica reorganizó sus equipos:
 * «Helios Recepción Digital» es la IA y NO es destino de derivación; las personas
 * están en «Equipo De Recepción» y los fallos técnicos en «Soporte Técnico Helios».
 */
const DESTINATION_LABELS: Record<string, string> = {
  reception: 'Equipo De Recepción',
  clinical_lead: 'Equipo De Recepción',
  helios_support: 'Soporte Técnico Helios'
};

/**
 * Los atributos personalizados los lee el equipo de la clínica en Chatwoot, no una
 * máquina: el Gateway nunca los vuelve a leer. Así que se escriben en castellano y
 * no con los nombres internos de la máquina de estados.
 */
const STAGE_LABELS_ES: Record<HandoffStage, string> = {
  bot_active: 'Helios atendiendo',
  handoff_requested: 'Derivación solicitada',
  human_queue: 'En cola del equipo',
  human_active: 'Atendiendo una persona',
  waiting_patient: 'Esperando al paciente',
  return_requested: 'Retorno solicitado',
  handoff_failed: 'Fallo técnico — Soporte Helios',
  closed: 'Cerrada'
};

const PRIORITY_LABELS_ES: Record<string, string> = {
  low: 'Baja',
  normal: 'Normal',
  high: 'Alta',
  urgent: 'Urgente'
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
  // RESPALDO DE DESTINO. Una derivación NUNCA puede quedarse sin equipo: sin
  // equipo no hay mención ni asignación, y nadie se enteraría. El caso que lo
  // motiva es real: la clínica reorganizó sus equipos y desapareció el de
  // «Responsable Clínico», al que apuntaban `clinical_question` y
  // `possible_urgency`. Sin este respaldo, la derivación por POSIBLE URGENCIA —el
  // caso más grave que existe— habría quedado sin nadie asignado.
  // El respaldo va a recepción porque es quien está siempre presente, y queda
  // registrado para que un destino mal configurado sea visible y no silencioso.
  //
  // UN FALLO TÉCNICO TIENE DOS DESTINATARIOS DISTINTOS, y confundirlos deja al
  // paciente esperando a alguien que no le va a escribir: el equipo técnico
  // arregla errores, no atiende pacientes. Así que la conversación se ASIGNA a
  // recepción, que es quien sigue hablando con el paciente, y a soporte se le
  // MENCIONA para que vea el error y lo arregle.
  const isTechnical = request.origin === 'technical_failure';
  const requestedTeamId = isTechnical
    ? (routing.teams.reception ?? null)
    : (routing.teams[request.destination] ?? null);
  const destinationTeamId = requestedTeamId ?? routing.teams.reception ?? null;
  const supportTeamId = isTechnical ? (routing.teams.helios_support ?? null) : null;
  if (!requestedTeamId && destinationTeamId) {
    console.warn(JSON.stringify({
      event: 'handoff_destination_team_fallback',
      requested_destination: request.destination,
      fell_back_to: 'reception',
      reason_code: request.reason_code
    }));
  }
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
    support_team_id: supportTeamId,
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

  // El resumen que verá el equipo: los últimos mensajes reales de la conversación.
  const recap = await loadConversationRecap(
    tenantContext.tenant_id,
    conversationId
  ).catch(() => null);

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
    await chatwootClient.mergeCustomAttributes(accountId, conversationId, {
      [routing.attribute_keys.case_id]: opened.handoff_id,
      [routing.attribute_keys.stage]: STAGE_LABELS_ES[finalStage],
      [routing.attribute_keys.priority]: PRIORITY_LABELS_ES[request.priority] ?? request.priority
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

  // 7. El aviso, con la mención. ESTA es la nota que genera el correo, y por eso
  //    va corta: Chatwoot añade su propio bloque «Previous messages» al final del
  //    correo, así que meter aquí el resumen lo duplicaba.
  await runStep('private_note', async () => {
    const noteId = await chatwootClient.createHandoffPrivateNote(
      accountId,
      conversationId,
      buildPrivateNote(opened, input.patient)
    );
    return { chatwoot_message_id: noteId };
  });

  // 7b. El resumen, en una nota aparte y SIN mención. Una nota privada sin
  //     mención no avisa a nadie por correo, así que el resumen se ve en Chatwoot
  //     —donde hace falta, sobre todo en el móvil— y no viaja al correo, donde
  //     estaría repetido. Va después del aviso a propósito: si esta falla, el
  //     aviso con la mención ya salió y el handoff no se queda a medias.
  const recapNote = buildRecapNote(recap);
  if (recapNote) {
    await runStep('private_note_recap', async () => {
      const noteId = await chatwootClient.createHandoffPrivateNote(
        accountId,
        conversationId,
        recapNote
      );
      return { chatwoot_message_id: noteId };
    });
  }

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
      payload: buildNotificationPayload(opened, input.patient, recap)
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
 * Lee el diálogo real de las dos tablas donde vive: el buffer guarda lo que
 * escribieron el paciente y el equipo, y el outbox lo que envió Helios.
 */
export async function loadConversationRecap(
  tenantId: string,
  conversationId: string
): Promise<ConversationRecap> {
  const limit = Math.max(1, config.HELIOS_RECAP_MESSAGE_LIMIT);
  const [bufferRows, outboxRows] = await Promise.all([
    bufferRepository.listRecentForConversation(tenantId, conversationId, limit * 2)
      .catch(() => [] as any[]),
    outboxRepository.listRecentForConversation(tenantId, conversationId, limit)
      .catch(() => [] as any[])
  ]);
  return buildRecap(bufferRows, outboxRows, limit);
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
  const nombre = patient.identity_complete
    ? [patient.first_name, patient.last_name].filter(Boolean).join(' ')
    : null;

  // UN FALLO TÉCNICO SE AVISA A DOS EQUIPOS, con encargos distintos. Recepción
  // continúa la conversación para que el paciente no se quede colgado, y soporte
  // ve el error para arreglarlo. Si solo se avisara a soporte, el paciente
  // esperaría una respuesta de alguien que arregla programas, no que atiende
  // pacientes.
  if (request.origin === 'technical_failure') {
    const avisoRecepcion = teamMention(opened.destination_team_id, 'reception');
    const avisoSoporte = teamMention(opened.support_team_id, 'helios_support');
    return [
      '**Helios ha tenido un fallo técnico**',
      '',
      avisoRecepcion ? `${avisoRecepcion} — continúa tú la conversación con el paciente.` : null,
      avisoSoporte ? `${avisoSoporte} — revisad el error y arregladlo.` : null,
      '',
      `- **Paciente:** ${nombre || 'todavía no ha dado su nombre'}`,
      `- **Prioridad:** ${PRIORITY_LABELS_ES[request.priority] ?? request.priority}`,
      // Aquí SÍ va el detalle técnico, al revés que en una derivación normal: es
      // justo lo que soporte necesita para saber por dónde empezar.
      request.summary ? `- **Qué falló:** ${request.summary}` : null,
      '',
      'El paciente ya ha recibido un aviso de que le atenderá una persona.',
      'Cuando termines de atenderle, escribe /fin en una nota privada para devolvérsela a Helios.'
    ].filter(line => line !== null).join('\n');
  }

  const accion = 'Atiende al paciente desde esta conversación. Cuando termines, escribe /fin en una nota privada para devolvérsela a Helios.';

  // Markdown, no texto plano. Chatwoot renderiza el cuerpo de la nota y un salto
  // de línea suelto se pierde al pasar a HTML: el correo de la mención llegaba
  // con los datos amontonados en un párrafo. Con encabezado, lista y líneas en
  // blanco entre bloques se lee igual de bien en la app y en el correo. Que el
  // markdown se procesa está comprobado: la mención llega como
  // «@Recepción Clínica» y no con su sintaxis cruda.
  //
  // El resumen NO va aquí: viaja en su propia nota sin mención (buildRecapNote).
  return [
    '**Un paciente necesita atención humana**',
    '',
    mention,
    '',
    `- **Paciente:** ${nombre || 'todavía no ha dado su nombre'}`,
    `- **Motivo:** ${REASON_LABELS[request.reason_code] || request.reason_code}`,
    `- **Prioridad:** ${PRIORITY_LABELS_ES[request.priority] ?? request.priority}`,
    `- **Para:** ${destination}`,
    request.treatment_interest ? `- **Le interesa:** ${request.treatment_interest}` : null,
    request.summary ? ['', `**Contexto:** ${request.summary}`].join('\n') : null,
    '',
    accion
  ].filter(line => line !== null).join('\n');
}

/**
 * El resumen de la conversación, en su propia nota privada y SIN mención.
 *
 * POR QUÉ VA APARTE. La nota que lleva la mención es la que Chatwoot convierte en
 * correo, y a ese correo le añade por su cuenta su bloque «Previous messages» con
 * los últimos mensajes. Con el resumen dentro, el correo llegaba con la misma
 * conversación dos veces. Una nota privada SIN mención no avisa a nadie por
 * correo, así que el resumen se queda donde hace falta —Chatwoot, sobre todo en
 * el móvil, donde no se ve el hilo completo— y no viaja duplicado.
 *
 * Devuelve null si no hay nada que resumir, y entonces no se crea ninguna nota.
 */
export function buildRecapNote(recap?: ConversationRecap | null): string | null {
  const lines = recap
    ? renderRecap(recap, config.CLINIC_TIMEZONE || 'Europe/Madrid', 'markdown')
    : [];
  if (lines.length === 0) return null;
  return ['**Últimos mensajes de la conversación**', '', ...lines].join('\n');
}

/**
 * Contenido de la alerta al equipo. Lleva el contexto mínimo y el enlace
 * directo a la conversación; nunca secretos ni PII innecesaria.
 */
export function buildNotificationPayload(
  opened: OpenedHandoff,
  patient: CompleteHandoffInput['patient'],
  recap?: ConversationRecap | null
): Record<string, unknown> {
  const { request, tenantContext } = opened;
  return {
    patient_full_name: patient.identity_complete
      ? [patient.first_name, patient.last_name].filter(Boolean).join(' ') || null
      : null,
    recap: recap
      ? {
          lines: renderRecap(recap, config.CLINIC_TIMEZONE || 'Europe/Madrid'),
          total_messages: recap.total_messages,
          truncated: recap.truncated
        }
      : null,
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
    handoff_destination: null,
    // Quién atendió pertenece al episodio, no a la conversación. Si no se limpia
    // aquí, el siguiente handoff aparece con un agente asignado antes de que
    // nadie lo haya cogido, justo en la consulta que se usa para diagnosticar.
    // El histórico no se pierde: queda en la fila de helios_handoff_events.
    human_accepted_at: null,
    human_accepted_by: null
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
  await attempt('custom_attributes', () => chatwootClient.mergeCustomAttributes(
    tenantContext.account_id,
    input.conversation_id,
    { [routing.attribute_keys.stage]: STAGE_LABELS_ES.bot_active, [routing.attribute_keys.case_id]: null }
  ));
  // Una conversación RESUELTA no se reabre al devolverla al bot. En esta clínica
  // el cierre dispara la encuesta de satisfacción (csat-enviar), y reabrirla la
  // sacaría de la bandeja y podría desbaratar ese flujo. El estado canónico ya
  // queda en bot_active, así que el siguiente mensaje del paciente vuelve a la IA
  // igual, y Chatwoot reabrirá la conversación por su cuenta cuando eso ocurra.
  await attempt('status_pending', async () => {
    const current = await chatwootClient.getConversationStatus(
      tenantContext.account_id,
      input.conversation_id
    );
    if (current === 'resolved') {
      console.log(JSON.stringify({
        event: 'handoff_return_kept_resolved',
        conversation_fingerprint: shortFingerprint(input.conversation_id)
      }));
      return;
    }
    await chatwootClient.setStatus(tenantContext.account_id, input.conversation_id, 'pending');
  });

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
/**
 * Lo que se le dice al paciente cuando Helios falla.
 *
 * No se le pide perdón por algo que no entiende ni se le dan códigos de error: se
 * le dice que hubo un problema y que sigue una persona. Callarse, que es lo que
 * hacía antes, es lo peor de las tres opciones: el paciente se queda mirando el
 * chat sin saber si le han leído.
 */
const MENSAJE_FALLO_TECNICO =
  'Disculpe, he tenido un problema técnico y no he podido completar su solicitud. '
  + 'Ya he avisado al equipo de la clínica: una persona continuará con usted por aquí mismo.';

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
  /**
   * Lote al que pertenece el mensaje. Hace falta para poder encolar el aviso al
   * paciente: helios_chatwoot_outbox tiene clave foránea contra
   * helios_processing_batches, así que sin lote real NO se puede encolar nada.
   * Cuando falta, el handoff se hace igual y recepción sigue viendo la
   * conversación: simplemente el aviso lo escribe una persona.
   */
  batch_key?: string | null;
}): Promise<CompleteHandoffResult | null> {
  // Encuesta de satisfacción: si Helios ha fallado, no se le pregunta al paciente
  // qué tal el servicio. Se marca AQUÍ, en el único sitio por el que pasan todos
  // los fallos técnicos, para que no se pueda olvidar en una rama nueva. Es el
  // motivo de exclusión más grave y pisa a cualquier otro ya anotado.
  await markExcluded({
    tenantId: input.tenantContext.tenant_id,
    conversationId: input.conversation_id,
    contactId: input.contact_id,
    traceId: input.trace_id,
    reason: 'technical_failure'
  });
  // Si Helios acaba de fallarle, no se le persigue al día siguiente con un
  // «¿te sigue interesando?».
  await blockLead({
    tenantId: input.tenantContext.tenant_id,
    conversationId: input.conversation_id,
    contactId: input.contact_id,
    traceId: input.trace_id,
    reason: 'technical_failure'
  });

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

    // Aviso al paciente. Va por el outbox durable, igual que cualquier otro
    // mensaje: si Chatwoot es justo lo que está fallando, la fila espera y se
    // entrega cuando se recupere, en vez de perderse.
    let transitionOutboxKey: string | null = null;
    if (input.batch_key) {
      try {
        const identity = createOutboxIdentity({
          tenant_id: input.tenantContext.tenant_id,
          account_id: input.tenantContext.account_id,
          conversation_id: input.conversation_id,
          contact_id: input.contact_id,
          source_message_ids_hash: `technical:${input.error_code}`,
          content: MENSAJE_FALLO_TECNICO
        });
        await outboxRepository.create({
          outbox_key: identity.outbox_key,
          batch_key: input.batch_key,
          tenant_id: input.tenantContext.tenant_id,
          account_id: input.tenantContext.account_id,
          conversation_id: input.conversation_id,
          contact_id: input.contact_id,
          source_message_ids_hash: `technical:${input.error_code}`,
          adapter_request_key: `technical:${input.trigger_key}`,
          content: MENSAJE_FALLO_TECNICO,
          content_hash: identity.content_hash
        }, input.trace_id);
        transitionOutboxKey = identity.outbox_key;
      } catch (outboxError: any) {
        // Que no se pueda avisar al paciente NO puede impedir que el equipo se
        // entere: eso dejaría la conversación muerta, que es lo que se quiere
        // evitar. Se registra y se sigue.
        console.error(JSON.stringify({
          event: 'technical_failure_patient_notice_failed',
          error_code: outboxError?.code || 'OUTBOX_CREATE_FAILED'
        }));
      }
    }

    return await completeHandoff({
      opened,
      transition_outbox_key: transitionOutboxKey,
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

/**
 * Seguimiento de leads: los efectos. La decisión vive en policy.ts, que es puro.
 *
 * DOS NIVELES DE SEGURIDAD, igual que en la encuesta:
 *
 *  1. Anotar en Supabase quién es lead y a quién NO se le escribe ocurre SIEMPRE,
 *     también con HELIOS_LEADS_ENABLED apagado. Así se puede ver con datos reales
 *     a quién se le habría escrito, y con qué texto exacto, antes de encender.
 *
 *  2. Mandar el mensaje solo ocurre con el flag encendido, porque eso sí le llega
 *     a un paciente.
 *
 * Ningún fallo de aquí puede tumbar un turno: un seguimiento comercial vale mucho
 * menos que contestarle a quien está escribiendo ahora mismo.
 */

import { config } from '../config.js';
import { supabase } from '../supabase/client.js';
import { logsRepository } from '../repositories/database.js';
import { chatwootClient } from '../chatwoot/client.js';
import { resolveTenantContextByTenantId } from '../tenants/context.js';
import {
  decidirSeguimiento,
  detectLeadInterest,
  BLOQUEOS_QUE_LEVANTA_UN_INTERES_NUEVO,
  VENTANA_POR_DEFECTO,
  type LeadBlockReason,
  type LeadInterest
} from './policy.js';
import { construirMensaje } from './messages.js';
import { obtenerHorarioYVentana, obtenerModoLeads } from '../tenants/settings.js';

export const leadMetrics = {
  marked_interest: 0,
  blocked: 0,
  sent: 0,
  skipped_no_window: 0,
  skipped_off: 0,
  skipped_ya_observado: 0,
  last_error_code: null as string | null
};

async function patch(tenantId: string, conversationId: string, cambios: Record<string, unknown>) {
  const result = await supabase
    .from('helios_conversation_state')
    .update(cambios)
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId);
  if (result.error) throw Object.assign(new Error('LEAD_STATE_WRITE_FAILED'), { cause: result.error });
}

/**
 * Anota que esta conversación es un lead, si el turno lo demuestra.
 *
 * El reloj se REINICIA en cada muestra de interés: si el paciente vuelve a
 * preguntar por huecos tres días después, el seguimiento se cuenta desde esa
 * última vez y no desde la primera. Es lo que evita escribirle sobre algo que ya
 * no viene a cuento.
 */
export async function markLeadInterest(input: {
  tenantId: string;
  conversationId: string;
  contactId: string;
  traceId: string;
  operation: any;
  /** Lo que se vio en el texto del paciente en ESTE turno. */
  señales?: { asks_for_price?: boolean } | null;
}): Promise<void> {
  const interest = detectLeadInterest(input.operation, input.señales);
  if (!interest) return;
  try {
    await patch(input.tenantId, input.conversationId, {
      lead_interest: interest,
      lead_interest_at: new Date().toISOString(),
      // Un interés nuevo reabre la puerta: si antes se le escribió, puede volver
      // a recibir seguimiento por ESTA consulta nueva.
      lead_followup_at: null,
      // Y lo mismo con la observación: si se simuló por la consulta ANTERIOR, esta es
      // otra y merece su propia decisión. Sin esto, una conversación observada una vez
      // no volvería a registrar nada nunca.
      lead_simulado_at: null
    });

    // Y SE LEVANTAN LOS BLOQUEOS SITUACIONALES.
    //
    // Lo pregunto David: «¿qué tal si a la semana vuelve a escribir y deja algo a
    // medias? ¿No se le hace el seguimiento?». No se le hacía. El 19 de agosto siete
    // conversaciones quedaron con lead_blocked_reason = 'booked' y el barrido filtra
    // por ese campo en null: reservaron una vez y quedaban excluidas de por vida.
    //
    // El filtro `.in(...)` hace la condición EN EL SERVIDOR, así que no hace falta leer
    // antes y no hay carrera: si el motivo guardado es uno de los que la voluntad del
    // paciente no sostiene -booked, human_handoff, technical_failure- se limpia; si es
    // opted_out, not_interested o complaint, la fila no se toca.
    const desbloqueo = await supabase
      .from('helios_conversation_state')
      .update({ lead_blocked_reason: null })
      .eq('tenant_id', input.tenantId)
      .eq('conversation_id', input.conversationId)
      .in('lead_blocked_reason', BLOQUEOS_QUE_LEVANTA_UN_INTERES_NUEVO as unknown as string[]);
    if (desbloqueo.error) {
      // No es motivo para tirar el turno: el interés ya está anotado y lo peor que
      // pasa es que este lead siga bloqueado. Se registra y se sigue.
      leadMetrics.last_error_code = 'LEAD_DESBLOQUEO_FALLIDO';
      console.warn(JSON.stringify({
        event: 'lead_desbloqueo_fallido',
        conversation_id: input.conversationId
      }));
    }
    leadMetrics.marked_interest += 1;
    await logsRepository.save({
      trace_id: input.traceId,
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      event_type: 'LEAD_INTEREST_MARKED',
      metadata: { interest, operation_type: input.operation?.type }
    }).catch(() => undefined);
  } catch (error: any) {
    leadMetrics.last_error_code = error?.message || 'LEAD_MARK_FAILED';
    console.warn(JSON.stringify({
      event: 'lead_mark_interest_failed',
      conversation_id: input.conversationId,
      error_code: leadMetrics.last_error_code
    }));
  }
}

/**
 * Cierra la puerta: a esta conversación no se le escribe.
 *
 * NO se sobreescribe un bloqueo anterior. El primero que llega manda, porque el
 * primero suele ser el más específico: si alguien se quejó y luego pidió que no
 * le escribieran, el motivo interesante sigue siendo la queja.
 */
export async function blockLead(input: {
  tenantId: string;
  conversationId: string;
  contactId: string;
  traceId: string;
  reason: LeadBlockReason;
}): Promise<void> {
  try {
    const actual = await supabase
      .from('helios_conversation_state')
      .select('lead_blocked_reason')
      .eq('tenant_id', input.tenantId)
      .eq('conversation_id', input.conversationId)
      .maybeSingle();
    if (actual.error) throw Object.assign(new Error('LEAD_STATE_READ_FAILED'), { cause: actual.error });
    if (actual.data?.lead_blocked_reason) return;

    await patch(input.tenantId, input.conversationId, { lead_blocked_reason: input.reason });
    leadMetrics.blocked += 1;
    await logsRepository.save({
      trace_id: input.traceId,
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      event_type: 'LEAD_BLOCKED',
      metadata: { reason: input.reason }
    }).catch(() => undefined);
  } catch (error: any) {
    leadMetrics.last_error_code = error?.message || 'LEAD_BLOCK_FAILED';
    console.warn(JSON.stringify({
      event: 'lead_block_failed',
      conversation_id: input.conversationId,
      error_code: leadMetrics.last_error_code
    }));
  }
}

/** Nombre de pila verificado. Nunca el alias de Chatwoot, que no es de fiar. */
async function nombreVerificado(tenantId: string, contactId: string): Promise<string | null> {
  const result = await supabase
    .from('helios_patient_profiles')
    .select('first_name, profile_complete')
    .eq('tenant_id', tenantId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (result.error || !result.data?.profile_complete) return null;
  const nombre = String(result.data.first_name ?? '').trim();
  return nombre || null;
}

/**
 * Deja constancia del seguimiento en su propia tabla.
 *
 * Va aparte de los logs a propósito: esto es una métrica de negocio que se le va
 * a enseñar a la clínica a fin de mes, y un log puede rotarse o cambiar de forma
 * cuando cambia el código. La clave es determinista para que un reintento del
 * barrido no cuente dos veces el mismo seguimiento e infle el número.
 */
async function registrarSeguimiento(input: {
  fila: any;
  interest: string;
  mensaje: string;
  estado: 'sent' | 'simulated';
  providerMessageId: string | null;
}): Promise<void> {
  const { fila } = input;
  const clave = `lead:${fila.tenant_id}:${fila.conversation_id}:${fila.lead_interest_at}`;
  const result = await supabase
    .from('helios_lead_followups')
    .upsert({
      followup_key: clave,
      tenant_id: fila.tenant_id,
      conversation_id: fila.conversation_id,
      contact_id: fila.contact_id || 'unknown',
      interest: input.interest,
      interest_at: fila.lead_interest_at,
      message: input.mensaje,
      status: input.estado,
      provider_message_id: input.providerMessageId
    }, { onConflict: 'followup_key', ignoreDuplicates: true });
  if (result.error) throw Object.assign(new Error('LEAD_LOG_WRITE_FAILED'), { cause: result.error });
}

/**
 * La ventana de ESTA clínica: su horario, su franja de envío y su zona.
 *
 * Antes era una constante con el horario de COI escrito en el código. Si la lectura
 * falla se usa la de siempre, porque un ajuste caído no puede parar el barrido.
 */
async function ventanaDe(tenantId: string) {
  try {
    const { horario, envio, zona } = await obtenerHorarioYVentana(tenantId);
    return { ...VENTANA_POR_DEFECTO, horario, envio, zona };
  } catch {
    return VENTANA_POR_DEFECTO;
  }
}

/**
 * SE EXPORTA PARA PODER PROBARLA CON UN RELOJ FIJO, y merece la explicacion.
 *
 * La ventana de seguimiento cruza el horario de la clinica, la franja en que es
 * decente escribir y el plazo de WhatsApp, asi que si la prueba entrara por
 * runLeadFollowupSweep -que usa new Date()- pasaria o fallaria segun la hora a la que
 * se lance la suite. Una prueba intermitente sobre el paso que decide si se le escribe
 * a un paciente es peor que no tenerla.
 *
 * Aqui `ahora` ya era un parametro: solo hacia falta poder llamarla.
 */
export async function procesarLead(fila: any, ahora: Date): Promise<void> {
  const decision = decidirSeguimiento(fila, ahora, await ventanaDe(fila.tenant_id));
  if (decision.action === 'skip') {
    if (decision.reason === 'no_window') {
      leadMetrics.skipped_no_window += 1;
      // Se cierra para que no se vuelva a evaluar cada diez minutos eternamente.
      await patch(fila.tenant_id, fila.conversation_id, { lead_blocked_reason: 'opted_out' })
        .catch(() => undefined);
      await logsRepository.save({
        trace_id: `lead-${fila.conversation_id}`,
        tenant_id: fila.tenant_id,
        conversation_id: fila.conversation_id,
        contact_id: fila.contact_id || 'unknown',
        event_type: 'LEAD_SKIPPED_NO_WINDOW',
        metadata: { interest: fila.lead_interest, interest_at: fila.lead_interest_at }
      }).catch(() => undefined);
    }
    return;
  }

  const nombre = await nombreVerificado(fila.tenant_id, fila.contact_id).catch(() => null);
  const mensaje = construirMensaje(decision.interest as LeadInterest, { nombre });

  // EL MODO SE COMPRUEBA ANTES DE MARCAR NADA, y ese orden es el arreglo.
  //
  // EL FALLO QUE HABIA AQUI: lead_followup_at se escribia arriba, sin condicion, y
  // solo despues se miraba el modo. En observacion eso marcaba la conversacion como
  // «seguimiento hecho» sin haber escrito a nadie, y como el barrido filtra por
  // lead_followup_at IS NULL, esa conversacion NO SE VOLVIA A MIRAR NUNCA. El modo
  // observacion no observaba: consumia el lead y no lo entregaba.
  //
  // Paso de verdad. El 20 de agosto de 2026 a las 12:09:03 el barrido marco tres
  // conversaciones con el mismo timestamp al centisegundo. David habia activado el
  // seguimiento, espero el mensaje, y nunca llego; y al encenderlo de verdad esos
  // leads ya estaban quemados.
  const modo = await obtenerModoLeads(fila.tenant_id).catch(() => 'observe' as const);

  if (modo !== 'on') {
    // OBSERVACION: se anota la decision y NO se toca lead_followup_at, para que el
    // dia que se enciendan estos leads sigan vivos.
    //
    // Se usa una columna propia para no repetir la simulacion en cada barrido: sin
    // ella, la misma conversacion generaria una fila de log cada diez minutos
    // durante dias, y un log lleno de ruido es un log que nadie lee.
    if (fila.lead_simulado_at) {
      leadMetrics.skipped_ya_observado += 1;
      return;
    }
    await patch(fila.tenant_id, fila.conversation_id, { lead_simulado_at: ahora.toISOString() });
    await registrarSeguimiento({
      fila, interest: decision.interest, mensaje, estado: 'simulated', providerMessageId: null
    }).catch(() => undefined);
    await logsRepository.save({
      trace_id: `lead-${fila.conversation_id}`,
      tenant_id: fila.tenant_id,
      conversation_id: fila.conversation_id,
      contact_id: fila.contact_id || 'unknown',
      event_type: 'LEAD_FOLLOWUP_SIMULATED',
      metadata: {
        interest: decision.interest,
        message: mensaje,
        observe_only: true,
        // Que quede escrito en el log: el lead SIGUE VIVO, no se ha gastado.
        lead_sigue_disponible: true
      }
    }).catch(() => undefined);
    return;
  }

  // SE MARCA ANTES DE ENVIAR, a propósito. Si se marcara después y el envío
  // saliera bien pero fallara la escritura, el paciente recibiría el mismo
  // mensaje otra vez en el siguiente barrido. Entre perder un seguimiento y
  // mandarlo dos veces, se pierde: molestar es peor que no insistir.
  await patch(fila.tenant_id, fila.conversation_id, { lead_followup_at: ahora.toISOString() });

  let providerMessageId: string | null = null;
  const estado: 'sent' = 'sent';

  {
    const tenantContext = resolveTenantContextByTenantId(fila.tenant_id);
    const respuesta = await chatwootClient.sendMessage(
      tenantContext.account_id,
      fila.conversation_id,
      mensaje,
      // ESTA MARCA NO ES DECORATIVA. El eco de las respuestas normales se
      // descarta buscando el message_id en el outbox, y este mensaje no pasa por
      // ahí: sin la marca, Helios leería su propio seguimiento como si lo hubiera
      // escrito una persona del equipo.
      { helios_lead_followup: decision.interest }
    );
    providerMessageId = respuesta?.data?.id ? String(respuesta.data.id) : null;
    leadMetrics.sent += 1;
  }

  // El registro se guarda SIEMPRE, también en observación: contar los simulados
  // por separado es justo lo que permite validar la decisión antes de encender.
  await registrarSeguimiento({
    fila,
    interest: decision.interest,
    mensaje,
    estado,
    providerMessageId
  }).catch(() => undefined);

  // Aqui solo se llega habiendo enviado de verdad: la rama de observacion vuelve
  // antes. Por eso el evento es fijo y no un ternario sobre `estado`.
  await logsRepository.save({
    trace_id: `lead-${fila.conversation_id}`,
    tenant_id: fila.tenant_id,
    conversation_id: fila.conversation_id,
    contact_id: fila.contact_id || 'unknown',
    event_type: 'LEAD_FOLLOWUP_SENT',
    metadata: { interest: decision.interest, message: mensaje, observe_only: false }
  }).catch(() => undefined);
}

/**
 * Barrido: busca leads maduros y les escribe.
 *
 * El filtro fino lo hace la política en memoria, no SQL: el cálculo del momento
 * válido cruza horario de clínica, zona horaria y plazo de WhatsApp, y eso en una
 * consulta sería ilegible y difícil de probar.
 */
export async function runLeadFollowupSweep(): Promise<void> {
  const ahora = new Date();
  const desde = new Date(ahora.getTime() - VENTANA_POR_DEFECTO.horasMaximas * 3600_000);

  const candidatos = await supabase
    .from('helios_conversation_state')
    .select('tenant_id, conversation_id, contact_id, lead_interest, lead_interest_at, lead_followup_at, lead_simulado_at, lead_blocked_reason, stage')
    .not('lead_interest', 'is', null)
    .is('lead_followup_at', null)
    .is('lead_blocked_reason', null)
    .gte('lead_interest_at', desde.toISOString())
    .limit(50);
  if (candidatos.error) {
    leadMetrics.last_error_code = 'LEAD_SWEEP_QUERY_FAILED';
    return;
  }

  for (const fila of candidatos.data || []) {
    try {
      // 'off' significa que esta función NO EXISTE para esta clínica: ni se decide
      // ni se anota. Se comprueba antes de cualquier escritura, porque en
      // 'observe' sí se escribe la marca de enviado y eso ya sería tocar sus datos.
      const modo = await obtenerModoLeads(fila.tenant_id).catch(() => 'observe' as const);
      if (modo === 'off') {
        leadMetrics.skipped_off += 1;
        continue;
      }
      await procesarLead(fila, ahora);
    } catch (error: any) {
      leadMetrics.last_error_code = error?.message || 'LEAD_SEND_FAILED';
      console.warn(JSON.stringify({
        event: 'lead_followup_failed',
        conversation_id: fila.conversation_id,
        error_code: leadMetrics.last_error_code
      }));
    }
  }
}

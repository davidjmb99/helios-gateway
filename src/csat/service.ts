/**
 * Escritura de la aptitud para la encuesta y aplicación de la etiqueta.
 *
 * La decisión vive en policy.ts, que es puro. Aquí solo están los efectos.
 *
 * DOS NIVELES DE SEGURIDAD, a propósito:
 *
 *  1. Anotar en Supabase (marcar apta / marcar excluida) ocurre SIEMPRE, incluso
 *     con HELIOS_CSAT_ENABLED apagado. Así se puede comprobar con datos reales a
 *     quién se le habría mandado la encuesta antes de encender nada.
 *
 *  2. Escribir la etiqueta en Chatwoot solo ocurre con el flag encendido, porque
 *     eso sí dispara la encuesta de verdad.
 *
 * Ningún fallo de aquí puede tumbar un turno: la encuesta es importante, pero
 * menos que contestarle al paciente. Todo va con captura y registro.
 */

import { config } from '../config.js';
import { supabase } from '../supabase/client.js';
import { logsRepository } from '../repositories/database.js';
import { chatwootClient } from '../chatwoot/client.js';
import { resolveHandoffRouting } from '../handoff/routing.js';
import {
  type CsatState,
  decideOnResolution,
  isEligibleOperation,
  mergeExclusionReason,
  type CsatExclusionReason
} from './policy.js';

export const csatMetrics = {
  marked_eligible: 0,
  marked_excluded: 0,
  label_sent: 0,
  label_excluded: 0,
  skipped_not_eligible: 0,
  last_error_code: null as string | null
};

async function loadCsatState(tenantId: string, conversationId: string): Promise<CsatState> {
  const result = await supabase
    .from('helios_conversation_state')
    .select('csat_eligible_at, csat_excluded_reason, csat_label_applied_at')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (result.error) throw Object.assign(new Error('CSAT_STATE_READ_FAILED'), { cause: result.error });
  return (result.data ?? {}) as CsatState;
}

async function patchCsat(
  tenantId: string,
  conversationId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const result = await supabase
    .from('helios_conversation_state')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId);
  if (result.error) throw Object.assign(new Error('CSAT_STATE_WRITE_FAILED'), { cause: result.error });
}

/**
 * Marca la conversación como apta si este turno agendó o reprogramó una cita.
 *
 * No pisa una aptitud anterior: la primera cita es la que cuenta, y volver a
 * escribir la fecha en cada turno no aporta nada y gasta escrituras.
 */
export async function markEligibleIfAppointment(input: {
  tenantId: string;
  conversationId: string;
  contactId: string;
  traceId: string;
  operation: any;
}): Promise<void> {
  if (!isEligibleOperation(input.operation)) return;
  try {
    const state = await loadCsatState(input.tenantId, input.conversationId);
    if (state.csat_eligible_at) return;

    await patchCsat(input.tenantId, input.conversationId, {
      csat_eligible_at: new Date().toISOString()
    });
    csatMetrics.marked_eligible += 1;

    await logsRepository.save({
      trace_id: input.traceId,
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      event_type: 'CSAT_MARKED_ELIGIBLE',
      metadata: { operation_type: input.operation?.type }
    }).catch(() => undefined);
  } catch (error: any) {
    csatMetrics.last_error_code = error?.message || 'CSAT_MARK_ELIGIBLE_FAILED';
    console.warn(JSON.stringify({
      event: 'csat_mark_eligible_failed',
      conversation_id: input.conversationId,
      error_code: csatMetrics.last_error_code
    }));
  }
}

/**
 * Marca la conversación como excluida. La exclusión gana sobre la aptitud y da
 * igual el orden: un paciente puede agendar y enfadarse después.
 */
export async function markExcluded(input: {
  tenantId: string;
  conversationId: string;
  contactId: string;
  traceId: string;
  reason: CsatExclusionReason;
}): Promise<void> {
  try {
    const state = await loadCsatState(input.tenantId, input.conversationId);
    const reason = mergeExclusionReason(state.csat_excluded_reason, input.reason);
    if (!reason) return;

    await patchCsat(input.tenantId, input.conversationId, { csat_excluded_reason: reason });
    csatMetrics.marked_excluded += 1;

    await logsRepository.save({
      trace_id: input.traceId,
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      event_type: 'CSAT_MARKED_EXCLUDED',
      metadata: { reason, previous_reason: state.csat_excluded_reason ?? null }
    }).catch(() => undefined);
  } catch (error: any) {
    csatMetrics.last_error_code = error?.message || 'CSAT_MARK_EXCLUDED_FAILED';
    console.warn(JSON.stringify({
      event: 'csat_mark_excluded_failed',
      conversation_id: input.conversationId,
      error_code: csatMetrics.last_error_code
    }));
  }
}

/**
 * La conversación se ha resuelto: aquí se decide y se escribe la etiqueta.
 *
 * Se aplica al resolver y no al agendar porque, si se aplicara al agendar, la
 * encuesta podría salir mientras el paciente sigue escribiendo.
 */
export async function applyCsatOnResolution(input: {
  tenantId: string;
  accountId: string;
  conversationId: string;
  contactId: string;
  traceId: string;
}): Promise<void> {
  try {
    const state = await loadCsatState(input.tenantId, input.conversationId);
    const outcome = decideOnResolution(state);

    if (outcome.action === 'none') {
      if (outcome.reason === 'not_eligible') csatMetrics.skipped_not_eligible += 1;
      return;
    }

    const routing = resolveHandoffRouting(input.tenantId);
    const label = outcome.action === 'send'
      ? routing.csat_labels.send
      : routing.csat_labels.exclude;

    // Con el flag apagado la decisión queda registrada pero NO se toca Chatwoot.
    // Es el modo de observación: sirve para comprobar a quién se le habría
    // mandado la encuesta, con datos reales, sin arriesgar ni una.
    if (config.HELIOS_CSAT_ENABLED && label) {
      await chatwootClient.addLabelsPreserving(input.accountId, input.conversationId, [label]);
      await patchCsat(input.tenantId, input.conversationId, {
        csat_label_applied_at: new Date().toISOString()
      });
    }

    if (outcome.action === 'send') csatMetrics.label_sent += 1;
    else csatMetrics.label_excluded += 1;

    await logsRepository.save({
      trace_id: input.traceId,
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      contact_id: input.contactId,
      event_type: outcome.action === 'send' ? 'CSAT_SURVEY_LABELLED' : 'CSAT_SURVEY_EXCLUDED',
      metadata: {
        reason: outcome.reason,
        label,
        applied_to_chatwoot: config.HELIOS_CSAT_ENABLED,
        observe_only: !config.HELIOS_CSAT_ENABLED
      }
    }).catch(() => undefined);

    console.log(JSON.stringify({
      event: 'csat_decision',
      conversation_id: input.conversationId,
      action: outcome.action,
      reason: outcome.reason,
      applied: config.HELIOS_CSAT_ENABLED
    }));
  } catch (error: any) {
    csatMetrics.last_error_code = error?.message || 'CSAT_APPLY_FAILED';
    console.warn(JSON.stringify({
      event: 'csat_apply_failed',
      conversation_id: input.conversationId,
      error_code: csatMetrics.last_error_code
    }));
  }
}

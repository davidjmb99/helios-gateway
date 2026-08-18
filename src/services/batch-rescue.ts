/**
 * Rescate de lotes abandonados: nadie se queda sin respuesta.
 *
 * Cuando un lote agota sus reintentos, hasta ahora desaparecía. Aquí se le da la
 * única salida honesta que queda: derivarlo a una persona y decírselo al paciente.
 *
 * Todo el trabajo pesado ya existía en escalateTechnicalFailure() —abre la
 * derivación, avisa al paciente por el outbox durable, lo saca de la encuesta y
 * del seguimiento comercial—. Lo que faltaba era llamarla desde aquí.
 */

import { supabase } from '../supabase/client.js';
import { assertSupabaseSuccess } from '../supabase/assert-success.js';
import { resolveTenantContextByTenantId } from '../tenants/context.js';
import { escalateTechnicalFailure } from '../handoff/service.js';
import { isValidOperationalPhone } from '../utils/normalizeProfilePatch.js';

export const rescueMetrics = {
  rescatados: 0,
  fallidos: 0,
  ultimo_error: null as string | null,
  ultimo_rescate: null as string | null
};

/**
 * Datos que escalateTechnicalFailure necesita y el lote no guarda.
 *
 * El buzón sale del último mensaje entrante: es exactamente el mensaje que se
 * quedó sin contestar. El teléfono NO está en el buffer, así que se busca donde
 * vive —el estado de la conversación y, si no, la ficha del paciente— y se
 * descarta cualquier valor enmascarado, igual que hace el orquestador.
 */
async function datosDeContacto(
  tenantId: string,
  conversationId: string,
  contactId: string
): Promise<{ inbox_id: string; phone: string }> {
  const buzon = await supabase
    .from('helios_inbound_buffer')
    .select('inbox_id')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  assertSupabaseSuccess(buzon, 'rescate.buzon', { tenant_id: tenantId });

  const estado = await supabase
    .from('helios_conversation_state')
    .select('phone')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  assertSupabaseSuccess(estado, 'rescate.estado', { tenant_id: tenantId });

  let phone = String(estado.data?.phone ?? '').trim();
  if (!isValidOperationalPhone(phone)) {
    const ficha = await supabase
      .from('helios_patient_profiles')
      .select('phone')
      .eq('tenant_id', tenantId)
      .eq('contact_id', contactId)
      .maybeSingle();
    assertSupabaseSuccess(ficha, 'rescate.ficha', { tenant_id: tenantId });
    phone = String(ficha.data?.phone ?? '').trim();
  }

  return {
    inbox_id: String(buzon.data?.inbox_id ?? ''),
    // Sin teléfono válido se manda vacío: la derivación tiene que salir igual. El
    // equipo ve la conversación en Chatwoot, que es lo que hace falta para
    // atender al paciente; el teléfono solo enriquece la nota.
    phone: isValidOperationalPhone(phone) ? phone : ''
  };
}

/**
 * Deriva un lote agotado y lo marca para no volver a tocarlo.
 *
 * EL ORDEN IMPORTA: primero se deriva y solo después se marca. Al revés, un fallo
 * a mitad dejaría el lote marcado como rescatado sin que nadie lo haya visto, que
 * es justo el problema que veníamos a resolver. Marcado de más = paciente perdido;
 * marcado de menos = como mucho una derivación repetida, que se ve y se cierra.
 */
export async function rescatarLote(lote: any): Promise<boolean> {
  try {
    // Lanza TenantContextError si la clinica no esta configurada, y eso es lo
    // correcto: sin contexto no se sabe a que cuenta de Chatwoot derivar.
    const tenantContext = resolveTenantContextByTenantId(lote.tenant_id);
    const contacto = await datosDeContacto(
      lote.tenant_id,
      String(lote.conversation_id),
      String(lote.contact_id)
    );

    await escalateTechnicalFailure({
      tenantContext,
      conversation_id: String(lote.conversation_id),
      contact_id: String(lote.contact_id),
      inbox_id: contacto.inbox_id,
      phone: contacto.phone,
      trace_id: `rescate-${lote.batch_key}`,
      trigger_key: `rescate:${lote.batch_key}`,
      error_code: lote.last_error_code || 'INTENTOS_AGOTADOS',
      stage_of_failure: 'recovery.intentos_agotados',
      batch_key: lote.batch_key
    });

    const marca = await supabase
      .from('helios_processing_batches')
      .update({ rescatado_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('batch_key', lote.batch_key);
    assertSupabaseSuccess(marca, 'rescate.marcar', { tenant_id: lote.tenant_id });

    rescueMetrics.rescatados += 1;
    rescueMetrics.ultimo_rescate = new Date().toISOString();
    console.warn(JSON.stringify({
      event: 'lote_rescatado',
      tenant_id: lote.tenant_id,
      conversation_id: lote.conversation_id,
      intentos: lote.attempt_count,
      error_original: lote.last_error_code || null
    }));
    return true;
  } catch (error: any) {
    // Un rescate que falla NO puede tumbar el barrido: detrás pueden venir otros
    // pacientes esperando. Se registra y el lote se queda sin marcar, así que el
    // siguiente tick lo vuelve a intentar.
    rescueMetrics.fallidos += 1;
    rescueMetrics.ultimo_error = error?.code || error?.message || 'RESCATE_FALLIDO';
    console.error(JSON.stringify({
      event: 'rescate_fallido',
      tenant_id: lote?.tenant_id,
      conversation_id: lote?.conversation_id,
      error_code: rescueMetrics.ultimo_error
    }));
    return false;
  }
}

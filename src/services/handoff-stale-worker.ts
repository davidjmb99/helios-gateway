/**
 * Devuelve a la IA los handoff que llevan horas sin actividad.
 *
 * POR QUÉ EXISTE. Depender de que alguien se acuerde de escribir /fin o de aplicar
 * la macro es depender de la memoria de una persona con turnos y prisa. Si se
 * olvida, la conversación queda en modo humano para siempre: el paciente escribe
 * al día siguiente, Helios está callado por diseño, y nadie contesta. Eso ya pasó
 * de verdad la noche del 10 al 11 de agosto.
 *
 * Por eso hay una red de seguridad basada en el tiempo, no en la disciplina.
 * Se aplica a TODAS las etapas en manos humanas, incluida handoff_failed: un fallo
 * técnico tampoco puede dejar al paciente incomunicado indefinidamente.
 */

import { config } from '../config.js';
import { supabase } from '../supabase/client.js';
import { assertSupabaseSuccess } from '../supabase/assert-success.js';
import { logsRepository } from '../repositories/database.js';
import { resolveTenantContextByTenantId } from '../tenants/context.js';
import { returnConversationToBot, teamMention } from '../handoff/service.js';
import { resolveHandoffRouting } from '../handoff/routing.js';
import { chatwootClient } from '../chatwoot/client.js';
import { HANDOFF_STAGES, isHumanOwnedStage } from '../handoff/stage.js';
import { decidirVuelta } from '../handoff/stale-policy.js';
import type { HorarioClinica } from '../leads/policy.js';
import { obtenerHorasVuelta, umbralMinimoDeVuelta, obtenerHorarioYVentana, obtenerEquipos } from '../tenants/settings.js';

let running = false;
let interval: NodeJS.Timeout | null = null;

export const staleHandoffMetrics = {
  returned: 0,
  failed: 0,
  avisos_sin_atender: 0,
  avisos_fallidos: 0,
  last_sweep_at: null as string | null,
  last_error_code: null as string | null
};

const HUMAN_OWNED = HANDOFF_STAGES.filter(isHumanOwnedStage);

/**
 * Última señal de vida de la conversación: el mensaje más reciente en cualquier
 * dirección. Si no hay ninguno, sirve el momento en que se pidió el handoff.
 */
async function lastActivityAt(tenantId: string, conversationId: string): Promise<string | null> {
  const result = await supabase
    .from('helios_inbound_buffer')
    .select('created_at')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  assertSupabaseSuccess(result, 'inbound_buffer.last_activity', {
    tenant_id: tenantId,
    row_id: conversationId
  });
  return result.data?.created_at ?? null;
}

/**
 * Cuando escribio una persona del equipo POR PRIMERA VEZ desde la derivacion.
 *
 * ES LA PIEZA QUE DISTINGUE «parada» de «nunca empezada». El reloj de inactividad
 * mide cuanto lleva PARADA una atencion; si nadie ha escrito, no hay atencion que
 * pueda haberse parado, y devolver la conversacion borra la peticion del paciente.
 *
 * La marca `author = 'clinic_team'` la pone saveHumanAgentMessage. Es lo unico que
 * distingue lo que escribio una persona de un eco de Helios: `direction = outgoing`
 * por si solo no vale, porque los mensajes que manda Helios tambien son salientes.
 */
async function primerMensajeHumanoDesde(
  tenantId: string,
  conversationId: string,
  desde: string | null
): Promise<string | null> {
  if (!desde) return null;
  const result = await supabase
    .from('helios_inbound_buffer')
    .select('created_at')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', conversationId)
    .eq('author', 'clinic_team')
    .gte('created_at', desde)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  assertSupabaseSuccess(result, 'inbound_buffer.primer_humano', {
    tenant_id: tenantId,
    row_id: conversationId
  });
  return result.data?.created_at ?? null;
}

/**
 * El aviso al equipo de que tiene una derivacion sin tocar.
 *
 * VA COMO NOTA PRIVADA CON MENCION, que es lo que genera correo en Chatwoot y lo que
 * el equipo ya esta acostumbrado a mirar. NO se le dice nada al paciente: el paciente
 * no tiene que enterarse de la gestion interna, y decirle «seguimos sin atenderte»
 * empeora su espera sin acortarla.
 */
function textoDelAviso(horas: number | null, umbral: number, mencion: string | null): string {
  const cuanto = horas === null ? `mas de ${umbral} horas` : `${horas} horas`;
  return [
    '**Hay un paciente esperando a una persona**',
    '',
    mencion ? `${mencion} — esta conversacion lleva ${cuanto} de horario de atencion sin que nadie la haya tocado.` : `Esta conversacion lleva ${cuanto} de horario de atencion sin que nadie la haya tocado.`,
    '',
    'El paciente pidio hablar con alguien del equipo y sigue esperando. NO se le ha',
    'devuelto a Helios a proposito: pidio una persona y eso es lo que espera.',
    '',
    'Las horas se cuentan solo en horario de atencion, asi que la noche y los dias',
    'cerrados no cuentan.'
  ].join('\n');
}

/**
 * Manda el aviso y lo marca, en ese orden.
 *
 * SE MARCA DESPUES DE MANDARLO, al contrario que en el seguimiento de leads. Aqui el
 * riesgo esta al reves: si se marcara antes y el envio fallara, el equipo se quedaria
 * sin aviso PARA SIEMPRE y un paciente esperando a nadie. Un aviso repetido molesta;
 * un aviso perdido deja a alguien sin atender.
 *
 * Y NINGUN FALLO DE AQUI puede parar el barrido: es un aviso, no una atencion.
 */
async function avisarDerivacionSinAtender(
  row: any,
  decision: { horas_sin_atender: number | null },
  umbral: number
): Promise<void> {
  try {
    const tenantContext = resolveTenantContextByTenantId(row.tenant_id);
    const routing = resolveHandoffRouting(row.tenant_id);
    const equipos = await obtenerEquipos(row.tenant_id, routing.teams).catch(() => routing.teams);
    const mencion = teamMention(equipos.reception ?? null, 'reception');

    await chatwootClient.createHandoffPrivateNote(
      tenantContext.account_id,
      row.conversation_id,
      textoDelAviso(decision.horas_sin_atender, umbral, mencion)
    );

    await supabase
      .from('helios_conversation_state')
      .update({ handoff_aviso_sin_atender_at: new Date().toISOString() })
      .eq('tenant_id', row.tenant_id)
      .eq('conversation_id', row.conversation_id);

    staleHandoffMetrics.avisos_sin_atender += 1;
    console.log(JSON.stringify({
      event: 'handoff_sin_atender_avisado',
      conversation_id: row.conversation_id,
      horas_sin_atender: decision.horas_sin_atender,
      umbral_horas: umbral
    }));
  } catch (error: any) {
    staleHandoffMetrics.avisos_fallidos += 1;
    console.error(JSON.stringify({
      event: 'handoff_sin_atender_aviso_fallido',
      conversation_id: row.conversation_id,
      error_code: error?.code || 'AVISO_SIN_ATENDER_FALLIDO'
    }));
  }
}

export async function runStaleHandoffSweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!config.HELIOS_HANDOFF_ENABLED) return;

    const ahora = Date.now();

    // EL UMBRAL ES POR CLÍNICA, así que la consulta se hace con el MÁS PERMISIVO
    // de todos -el más pequeño-. Si se hiciera con el umbral por defecto, una
    // clínica que haya elegido menos horas nunca entraría en la lista y no se le
    // devolvería nada. Cada fila se filtra después con el umbral de SU clínica.
    const umbralMasPermisivo = await umbralMinimoDeVuelta();
    const cutoffAmplio = new Date(ahora - umbralMasPermisivo * 60 * 60 * 1000);

    // Solo candidatas: en manos humanas y sin cambios de estado recientes. El
    // filtro definitivo es el último mensaje real, que se comprueba después.
    //
    // El orden por updated_at ascendente importa ahora que la ventana es más
    // amplia: con LIMIT 50 y sin orden, conversaciones que aún no han llegado a su
    // umbral podrían desplazar a las que sí, y esas no volverían nunca. Primero
    // las más antiguas, que son las más probables de estar pasadas de plazo.
    const candidates = await supabase
      .from('helios_conversation_state')
      .select('tenant_id, conversation_id, contact_id, inbox_id, phone, stage, handoff_id, handoff_requested_at, handoff_aviso_sin_atender_at')
      .in('stage', HUMAN_OWNED)
      .lt('updated_at', cutoffAmplio.toISOString())
      .order('updated_at', { ascending: true })
      .limit(50);
    assertSupabaseSuccess(candidates, 'conversation_state.list_stale_handoffs');

    staleHandoffMetrics.last_sweep_at = new Date().toISOString();

    for (const row of candidates.data || []) {
      try {
        const lastMessage = await lastActivityAt(row.tenant_id, row.conversation_id);
        const reference = lastMessage || row.handoff_requested_at;

        const umbralDeEstaClinica = await obtenerHorasVuelta(row.tenant_id);

        // EL UMBRAL SE MIDE EN HORAS DE ATENCION, no de reloj. Una derivacion a las
        // 20:03 con la clinica cerrada no puede consumir su plazo de madrugada: a
        // las 23:03 volveria a la IA y por la mañana no habria ninguna peticion
        // esperando. El reloj arranca cuando abre la clinica.
        //
        // Si el horario no se puede leer se sigue sin el, y decidirVuelta cuenta por
        // reloj de pared igual que antes. Una clinica mal configurada pierde la
        // mejora, no la red de seguridad.
        let zona: string | null = null;
        let horario: HorarioClinica | null = null;
        try {
          const ajustes = await obtenerHorarioYVentana(row.tenant_id);
          zona = ajustes.zona;
          horario = ajustes.horario;
        } catch {
          /* sin horario legible, reloj de pared */
        }

        // ¿LA HA ATENDIDO ALGUIEN YA? De esto depende todo lo demás.
        const primerHumanoAt = await primerMensajeHumanoDesde(
          row.tenant_id, row.conversation_id, row.handoff_requested_at
        ).catch(() => {
          // Si no se puede saber, es más seguro NO asumir que está sin atender: eso
          // dejaría la conversación en manos humanas para siempre por un fallo de
          // lectura. Se devuelve una fecha para que el reloj de siempre siga mandando.
          console.warn(JSON.stringify({
            event: 'handoff_primer_humano_ilegible',
            conversation_id: row.conversation_id
          }));
          return row.handoff_requested_at ?? null;
        });

        const decision = decidirVuelta({
          referencia: reference,
          umbralHoras: umbralDeEstaClinica,
          ahora,
          zona,
          horario,
          primerHumanoAt,
          handoffPedidoAt: row.handoff_requested_at ?? null,
          avisoSinAtenderAt: row.handoff_aviso_sin_atender_at ?? null
        });

        // NADIE LA HA TOCADO: no se devuelve, se avisa. Es lo contrario de lo que
        // hacía antes, y es lo que pidió David: «no la quita hasta que la atienda el
        // humano». El paciente pidió una persona y sigue en su cola.
        if (decision.avisar_sin_atender) {
          await avisarDerivacionSinAtender(row, decision, umbralDeEstaClinica);
        }

        if (!decision.volver) continue;

        const staleHours = decision.umbral_horas;
        const idleHours = decision.horas_inactiva;

        await returnConversationToBot({
          tenantContext: resolveTenantContextByTenantId(row.tenant_id),
          conversation_id: row.conversation_id,
          contact_id: row.contact_id || 'unknown',
          inbox_id: row.inbox_id || 'unknown',
          phone: row.phone || '',
          trace_id: `stale-handoff-${row.conversation_id}-${cutoffAmplio.getTime()}`,
          handoff_id: row.handoff_id || null,
          accepted_by: null
        });

        await logsRepository.save({
          trace_id: `stale-handoff-${row.conversation_id}`,
          tenant_id: row.tenant_id,
          conversation_id: row.conversation_id,
          contact_id: row.contact_id || 'unknown',
          event_type: 'HANDOFF_RETURNED_BY_INACTIVITY',
          metadata: {
            handoff_id: row.handoff_id,
            from_stage: row.stage,
            idle_hours: idleHours,
            open_hours: decision.horas_de_atencion,
            threshold_hours: staleHours,
            return_reason: decision.motivo,
            last_activity_at: reference
          }
        });

        staleHandoffMetrics.returned += 1;
        console.log(JSON.stringify({
          event: 'handoff_returned_by_inactivity',
          conversation_id: row.conversation_id,
          from_stage: row.stage,
          idle_hours: idleHours,
          open_hours: decision.horas_de_atencion,
          reason: decision.motivo
        }));
      } catch (error: any) {
        staleHandoffMetrics.failed += 1;
        staleHandoffMetrics.last_error_code = error?.code || 'STALE_HANDOFF_RETURN_FAILED';
        console.error(JSON.stringify({
          event: 'handoff_stale_return_failed',
          conversation_id: row.conversation_id,
          error_code: staleHandoffMetrics.last_error_code
        }));
      }
    }
  } finally {
    running = false;
  }
}

export function startStaleHandoffWorker() {
  if (process.env.NODE_ENV === 'test') return async () => {};
  const tick = () => {
    void runStaleHandoffSweep().catch(error => {
      staleHandoffMetrics.last_error_code = error?.code || 'STALE_HANDOFF_SWEEP_FAILED';
      console.error(JSON.stringify({
        event: 'handoff_stale_sweep_failed',
        error_code: staleHandoffMetrics.last_error_code
      }));
    });
  };
  tick();
  interval = setInterval(tick, Math.max(60_000, config.HELIOS_HANDOFF_SWEEP_MS));
  return async () => {
    if (interval) clearInterval(interval);
    interval = null;
  };
}

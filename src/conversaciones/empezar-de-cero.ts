/**
 * Pedir que una conversación empiece de cero con Hermes.
 *
 * POR QUÉ HACE FALTA UN BOTÓN. Casi todas las pruebas de esta semana acabaron
 * contaminadas por el historial: Helios tuteaba en una conversación vieja y trataba
 * de usted en una nueva, con el mismo prompt y en el mismo minuto; decía «hueco»
 * después de quitar la palabra de todos los prompts; repetía una dirección de Madrid
 * leyéndola de sus propios mensajes de hacía un mes; y se negaba a dar la dirección
 * porque en cuatro turnos anteriores se había negado. El modelo se imita a sí mismo,
 * y contra cuarenta mil tokens de ejemplos no gana ninguna regla nueva.
 *
 * Hasta ahora, empezar de cero eran tres comandos dentro de un contenedor y un
 * reinicio del Adapter. Y encima no funcionaba: el proceso tenía el mapa de sesiones
 * en memoria y sobrescribía cualquier edición del archivo.
 *
 * CÓMO FUNCIONA: se marca `reset_pedido_at` en la fila de la sesión. El Adapter lo
 * mira antes de cada turno y, si es posterior al último turno atendido, abre una
 * conversación nueva con Hermes y limpia la marca. No se borra nada: la conversación
 * de Hermes se identifica con una cadena que lleva un número de generación, y subirlo
 * equivale a empezar de cero.
 *
 * NO SE APLICA AL INSTANTE, Y ESO HAY QUE DECIRLO. Surte efecto en el siguiente
 * mensaje del paciente. Un botón que dijera «hecho» cuando en realidad ha dejado una
 * petición pendiente sería exactamente el tipo de mentira que ya tuvimos en el panel
 * con «IA reactivada correctamente».
 *
 * QUÉ NO SE PIERDE: la identidad del paciente -nombre, correo, teléfono, HubSpot- y
 * el estado de la conversación viven en Supabase y viajan en cada petición. Helios no
 * olvida quién es el paciente ni qué estaba haciendo. Pierde los ejemplos de cómo
 * hablaba antes, que es justo lo que se quiere tirar.
 */

import { supabase } from '../supabase/client.js';
import { assertSupabaseSuccess } from '../supabase/assert-success.js';

/** La tabla la escribe el Adapter; aquí solo se marca la petición. */
const TABLA = 'helios_hermes_sessions';

export interface ResultadoDeEmpezarDeCero {
  ok: true;
  /** true si había una sesión que reiniciar. */
  habia_sesion: boolean;
  /** Lo que hay que enseñarle al operador, escrito aquí y no en el navegador. */
  mensaje: string;
  generacion_actual: number | null;
  turnos_descartados: number | null;
  tokens_del_ultimo_turno: number | null;
}

/**
 * @param pedidoPor Quién lo pidió, para que quede en la fila. No se usa para nada más.
 */
export async function pedirEmpezarDeCero(entrada: {
  tenantId: string;
  conversationId: string;
  pedidoPor?: string | null;
}): Promise<ResultadoDeEmpezarDeCero> {
  const { tenantId, conversationId } = entrada;

  // SE BUSCA POR (tenant_id, conversation_id) Y NO POR LA CLAVE COMPLETA. La clave
  // del Adapter lleva además el perfil y el contact_id, y reconstruirla aquí
  // significaría duplicar ese formato en dos repositorios: en cuanto uno cambiara, el
  // botón dejaría de encontrar nada y no habría forma de notarlo. El índice de la
  // tabla es justo por esos dos campos.
  //
  // EL FILTRO POR tenant_id NO ES OPCIONAL: sin él, un conversation_id repetido entre
  // dos clínicas reiniciaría la conversación de un paciente de otra clínica.
  const actual = await supabase
    .from(TABLA)
    .select('session_key, generacion, turnos, ultimo_input_tokens')
    .eq('tenant_id', tenantId)
    .eq('conversation_id', String(conversationId))
    .maybeSingle();
  assertSupabaseSuccess(actual, 'hermes_sessions.leer_para_reset', {
    tenant_id: tenantId,
    row_id: String(conversationId)
  });

  if (!actual.data) {
    // Sin sesión guardada, esta conversación YA va a empezar de cero en su próximo
    // mensaje: el Adapter no tiene nada que continuar. Se dice tal cual en vez de
    // fingir que se ha hecho algo.
    return {
      ok: true,
      habia_sesion: false,
      mensaje: 'Esta conversación todavía no tiene historial con Helios, así que ya empieza de cero.',
      generacion_actual: null,
      turnos_descartados: null,
      tokens_del_ultimo_turno: null
    };
  }

  const marcado = await supabase
    .from(TABLA)
    .update({
      reset_pedido_at: new Date().toISOString(),
      reset_pedido_por: entrada.pedidoPor ?? 'panel'
    })
    .eq('session_key', actual.data.session_key)
    .eq('tenant_id', tenantId);
  assertSupabaseSuccess(marcado, 'hermes_sessions.marcar_reset', {
    tenant_id: tenantId,
    row_id: String(conversationId)
  });

  const turnos = Number(actual.data.turnos) || 0;

  return {
    ok: true,
    habia_sesion: true,
    // SE DICE QUE ES EN EL SIGUIENTE MENSAJE. Prometer efecto inmediato sería
    // mentira, y el panel ya nos hizo esa una vez.
    mensaje: turnos > 0
      ? `Listo. En el próximo mensaje del paciente, Helios empieza de cero: descarta ${turnos} `
        + `${turnos === 1 ? 'turno' : 'turnos'} de historial. Sigue sabiendo su nombre, su correo y su cita.`
      : 'Listo. En el próximo mensaje del paciente, Helios empieza de cero.',
    generacion_actual: Number(actual.data.generacion) || 0,
    turnos_descartados: turnos,
    tokens_del_ultimo_turno: actual.data.ultimo_input_tokens ?? null
  };
}

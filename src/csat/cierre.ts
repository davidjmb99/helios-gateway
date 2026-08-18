/**
 * Cuándo cierra Helios una conversación por su cuenta.
 *
 * El paciente agenda, Helios pregunta si necesita algo más, el paciente dice que
 * no. Ese punto es el final natural de la conversación, y hasta ahora había que
 * darle a «Resolver» a mano en Chatwoot para que saliera la encuesta.
 *
 * DOS CAUTELAS QUE MANDAN SOBRE TODO LO DEMÁS:
 *
 *  1. Cerrar una conversación viva es peor que no cerrarla. Si Helios se equivoca
 *     y cierra antes de tiempo, el paciente recibe una encuesta con la duda sin
 *     resolver. Por eso el cierre NO se deduce del texto ni de que haya una cita:
 *     lo declara Hermes explícitamente, y en ausencia de declaración no se cierra.
 *
 *  2. Si hay una persona metida en la conversación, no se toca. La decisión de
 *     cerrar es suya, no de Helios.
 *
 * La encuesta es una consecuencia, no el objetivo: quien decide si esta
 * conversación merece encuesta es decideOnResolution() en policy.ts, y puede
 * decidir que no. Aquí solo se decide si la conversación ha terminado.
 */

/** Cómo puede declarar Hermes que la conversación terminó. */
export const OPERACION_DE_CIERRE = 'conversation_closed';

export interface EntradaDeCierre {
  /** operation del contrato de Hermes. */
  operation?: any;
  /** state_patch del contrato de Hermes. */
  statePatch?: any;
  /** requires_handoff del contrato. */
  requiresHandoff?: unknown;
  /** Etapa de la conversación: si la lleva una persona, no se cierra. */
  humanoAlMando?: boolean;
  /** ¿Se le va a enviar algo al paciente en este turno? */
  hayRespuesta?: boolean;
}

export type DecisionDeCierre =
  | { cerrar: true; motivo: 'declarado_por_hermes' }
  | { cerrar: false; motivo: 'sin_declaracion' | 'handoff_activo' | 'humano_al_mando' | 'sin_respuesta' };

/** ¿Hermes ha declarado el cierre, en cualquiera de las dos formas admitidas? */
function hayDeclaracionDeCierre(entrada: EntradaDeCierre): boolean {
  // Forma principal: operation.type. Solo cuenta si la operación fue bien; una
  // operación en 'failed' o 'pending' no ha cerrado nada.
  const tipo = String(entrada.operation?.type ?? '').trim().toLowerCase();
  const estado = String(entrada.operation?.status ?? '').trim().toLowerCase();
  if (tipo === OPERACION_DE_CIERRE && estado === 'success') return true;

  // Forma alternativa, por si el esquema del guard no admitiera un operation.type
  // nuevo: una bandera dentro de state_patch. Se exige el booleano exacto para que
  // una cadena "false" o un 0 no cierren una conversación por accidente.
  return entrada.statePatch?.conversation_complete === true;
}

export function decidirCierre(entrada: EntradaDeCierre): DecisionDeCierre {
  // Sin mensaje al paciente no hay despedida que entregar, y cerrar dejaría la
  // conversación resuelta sin que el paciente haya leído nada.
  if (!entrada.hayRespuesta) return { cerrar: false, motivo: 'sin_respuesta' };

  // Las dos cautelas van ANTES de mirar la declaración: da igual lo que diga
  // Hermes si hay una persona atendiendo o si él mismo pidió derivar.
  if (entrada.humanoAlMando === true) return { cerrar: false, motivo: 'humano_al_mando' };
  if (entrada.requiresHandoff === true) return { cerrar: false, motivo: 'handoff_activo' };

  if (!hayDeclaracionDeCierre(entrada)) return { cerrar: false, motivo: 'sin_declaracion' };

  return { cerrar: true, motivo: 'declarado_por_hermes' };
}

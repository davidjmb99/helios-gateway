/**
 * Cuántas veces se reintenta un mensaje, y qué pasa cuando se acaban los intentos.
 *
 * EL FALLO QUE ESTO ARREGLA, medido el 17 y 18 de agosto de 2026: el recovery
 * buscaba lotes con `attempt_count < 5`. Al llegar a 5, el lote desaparecía de la
 * consulta. No se reintentaba, no se derivaba, no se avisaba a nadie: el paciente
 * se quedaba mirando el chat para siempre. Siete conversaciones reales acabaron
 * así, entre ellas la de una paciente que solo quería una cita para el lunes.
 *
 * Agotar los intentos NO es el final del camino. Es el momento de llamar a una
 * persona. Por eso aquí hay dos decisiones y no una:
 *
 *   - reintentar ... todavía queda margen, se vuelve a intentar solo.
 *   - rescatar .... se acabó el margen: deriva a soporte y avisa al paciente.
 *
 * La única salida que NO existe es no hacer nada, que es lo que hacía antes.
 */

/** Lo que se ofrece en el panel. Números pequeños: cada intento es un turno de IA que se paga. */
export const INTENTOS_RECOVERY = [1, 3, 5, 8] as const;

/**
 * Un intento mínimo de 1 significa «si falla, deriva enseguida». Es una postura
 * válida —una clínica puede preferir que conteste una persona antes que insistir—,
 * así que se permite. Lo que no se permite es 0: eso sería no procesar nunca.
 */
export const MINIMO_INTENTOS = 1;

/**
 * El techo protege la factura y al paciente. Con más de doce reintentos, un fallo
 * permanente cuesta doce turnos de modelo y el paciente sigue sin respuesta: es
 * dinero gastado en no contestarle.
 */
export const MAXIMO_INTENTOS = 12;

export function normalizarIntentos(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  const entero = Math.round(numero);
  if (entero < MINIMO_INTENTOS || entero > MAXIMO_INTENTOS) return null;
  return entero;
}

export type AccionDeLote = 'reintentar' | 'rescatar' | 'ignorar';

export interface EntradaDeRescate {
  /** Intentos ya consumidos por este lote. */
  intentos: unknown;
  /** El límite de ESTA clínica. */
  limite: number;
  /** Marca de que ya se derivó: un lote no se rescata dos veces. */
  yaRescatado?: unknown;
}

/**
 * Qué hacer con un lote parado.
 *
 * El límite es INCLUSIVO por el lado del rescate: con límite 5, el quinto intento
 * es el último que se hace, y a partir de ahí se rescata. Si fuera exclusivo,
 * «5 intentos» significarían 6 y el número del panel mentiría.
 */
export function decidirAccion(entrada: EntradaDeRescate): AccionDeLote {
  if (entrada.yaRescatado) return 'ignorar';

  const intentos = Number(entrada.intentos);
  // Un contador ilegible se trata como si no hubiera empezado: reintentar es
  // recuperable, rescatar molesta a una persona. Ante la duda, la opción barata.
  const consumidos = Number.isFinite(intentos) && intentos > 0 ? Math.floor(intentos) : 0;

  const limite = Number.isFinite(entrada.limite)
    ? Math.min(Math.max(Math.floor(entrada.limite), MINIMO_INTENTOS), MAXIMO_INTENTOS)
    : MINIMO_INTENTOS;

  return consumidos >= limite ? 'rescatar' : 'reintentar';
}

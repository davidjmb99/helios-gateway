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

/**
 * Lo que se OFRECE en el panel. Números pequeños: cada intento es un turno de IA que se paga.
 *
 * ERAN [1, 3, 5, 8] Y SE QUEDAN EN [3, 5], por decisión de David el 1 de septiembre.
 *
 *   EL 1 SE QUITA PORQUE NO DEJA RECUPERARSE DE NADA. Con un solo intento, cualquier
 *   tropiezo -incluido uno que se habría arreglado solo al segundo- acaba con el paciente
 *   esperando a una persona. Y con la reapertura de ejecuciones encendida (HEL-104) es
 *   todavía peor: el segundo intento es el que vuelve a llamar a Hermes de verdad, así que
 *   con el límite en 1 esa segunda oportunidad no llega a usarse NUNCA.
 *
 *   EL 8 SE QUITA PORQUE CASI NO HACE NADA. Cuando el Adapter abandona un reintento
 *   devuelve `recoverable: false`, y el Gateway lo trata como fallo definitivo y deriva ahí
 *   mismo: los intentos 4 en adelante no llegan a existir. Ofrecer un 8 sugiere una
 *   insistencia que el sistema no va a hacer.
 *
 * OJO AL CAMBIAR ESTA LISTA: el panel solo pinta los botones que están aquí. Una clínica
 * con un valor guardado que no esté en la lista se quedaría sin ningún botón marcado y sin
 * saber en qué está. Por eso `recovery_opciones` añade el valor actual si falta.
 */
export const INTENTOS_RECOVERY = [3, 5] as const;

/**
 * El MÍNIMO QUE SE ACEPTA sigue siendo 1, aunque ya no se ofrezca.
 *
 * Son dos cosas distintas y conviene no juntarlas: la lista de arriba es lo que se
 * RECOMIENDA, y esto es lo que se ADMITE. Subirlo a 3 dejaría fuera de rango a cualquier
 * clínica que ya tuviera 1 guardado, y un ajuste que deja de validarse no avisa: se cae al
 * valor por defecto y esa clínica cambia de comportamiento sin que nadie lo pida.
 *
 * Lo que no se permite es 0: eso sería no procesar nunca.
 */
export const MINIMO_INTENTOS = 1;

/**
 * Los botones que se le pintan a ESTA clínica.
 *
 * Es la lista recomendada MÁS el valor que ya tenga guardado, si no estuviera.
 *
 * SIN ESTO, UNA CLÍNICA CON UN VALOR RETIRADO VERÍA LOS BOTONES SIN NINGUNO MARCADO. No
 * sabría en qué está, y el primer clic se lo cambiaría creyendo que solo estaba mirando. Un
 * ajuste que no muestra su propio valor es peor que no mostrar el ajuste.
 */
export function opcionesDeIntentos(actual: unknown): number[] {
  const valor = normalizarIntentos(actual);
  const lista = [...INTENTOS_RECOVERY] as number[];
  if (valor !== null && !lista.includes(valor)) lista.push(valor);
  return lista.sort((a, b) => a - b);
}

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

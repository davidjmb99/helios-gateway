/**
 * Cuándo una conversación en manos humanas vuelve a la IA. La DECISIÓN, sin
 * efectos: aquí no se toca la base ni Chatwoot.
 *
 * Va aparte del worker por un motivo concreto: el barrido no tenía ni una prueba,
 * porque devolver una conversación toca Supabase y Chatwoot y montar eso en un
 * test es caro. La decisión, en cambio, es aritmética pura y es justo la parte que
 * puede estar mal. Ahora se prueba sola, con dos clínicas y umbrales distintos.
 */

/** Lo que ofrece el panel, en horas. */
export const HORAS_VUELTA = [1, 2, 3, 5, 8] as const;

/**
 * Límites de lo aceptable, independientes del desplegable.
 *
 * El mínimo es 1 hora porque por debajo de eso se le quitaría la conversación a
 * una persona que está en mitad de una llamada o buscando un hueco en la agenda.
 * El máximo es 48 horas porque esta red de seguridad existe precisamente para que
 * un olvido no deje al paciente incomunicado; un umbral de una semana no protege
 * de nada.
 *
 * NO EXISTE «NUNCA» a propósito. Poder desactivar la vuelta convertiría un olvido
 * en un paciente sin respuesta indefinidamente, que es exactamente lo que pasó la
 * noche del 10 al 11 de agosto y el motivo por el que se construyó esto.
 */
export const MINIMO_HORAS_VUELTA = 1;
export const MAXIMO_HORAS_VUELTA = 48;

const MS_POR_HORA = 60 * 60 * 1000;

/**
 * Convierte lo que llegue en un umbral usable, o en null si no lo es.
 *
 * Igual que con el buffer: se devuelve null en vez de recortar al límite. Caer al
 * valor de siempre es un comportamiento explicable; recortar en silencio un 200
 * a 48 no lo es.
 */
export function normalizarHorasVuelta(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  const entero = Math.round(numero);
  if (entero < MINIMO_HORAS_VUELTA || entero > MAXIMO_HORAS_VUELTA) return null;
  return entero;
}

export interface DecisionVuelta {
  volver: boolean;
  motivo: 'inactividad' | 'sin_referencia' | 'todavia_activa';
  horas_inactiva: number | null;
  umbral_horas: number;
}

/**
 * ¿Vuelve esta conversación a la IA?
 *
 * `referencia` es la última señal de vida: el mensaje más reciente en cualquier
 * dirección, o si no hay ninguno, el momento en que se pidió la derivación.
 *
 * Sin referencia NO se devuelve. Es deliberado: sin saber cuándo fue la última
 * actividad, devolverla sería adivinar, y equivocarse significa quitarle la
 * conversación a alguien que la está atendiendo ahora mismo.
 */
export function decidirVuelta(entrada: {
  referencia: string | null | undefined;
  umbralHoras: number;
  ahora: Date | number;
}): DecisionVuelta {
  const umbral = entrada.umbralHoras;
  const ahoraMs = entrada.ahora instanceof Date ? entrada.ahora.getTime() : entrada.ahora;

  if (!entrada.referencia) {
    return { volver: false, motivo: 'sin_referencia', horas_inactiva: null, umbral_horas: umbral };
  }

  const referenciaMs = new Date(entrada.referencia).getTime();
  if (!Number.isFinite(referenciaMs)) {
    return { volver: false, motivo: 'sin_referencia', horas_inactiva: null, umbral_horas: umbral };
  }

  const horasInactiva = Math.round((ahoraMs - referenciaMs) / 36_000) / 100;

  // El límite es inclusivo: a las 2 horas exactas con umbral de 2, vuelve. Si
  // fuera exclusivo habría que esperar al siguiente barrido, y con barridos de
  // minutos eso convierte «2 horas» en «2 horas y pico» sin explicación.
  if (ahoraMs - referenciaMs < umbral * MS_POR_HORA) {
    return { volver: false, motivo: 'todavia_activa', horas_inactiva: horasInactiva, umbral_horas: umbral };
  }

  return { volver: true, motivo: 'inactividad', horas_inactiva: horasInactiva, umbral_horas: umbral };
}

/**
 * Cuándo una conversación en manos humanas vuelve a la IA. La DECISIÓN, sin
 * efectos: aquí no se toca la base ni Chatwoot.
 *
 * Va aparte del worker por un motivo concreto: el barrido no tenía ni una prueba,
 * porque devolver una conversación toca Supabase y Chatwoot y montar eso en un
 * test es caro. La decisión, en cambio, es aritmética pura y es justo la parte que
 * puede estar mal. Ahora se prueba sola, con dos clínicas y umbrales distintos.
 */

import { minutosDeAtencion, horarioAbreAlgunaVez } from './reloj-abierto.js';
import type { HorarioClinica } from '../leads/policy.js';

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
 * Tope de reloj de pared, pase lo que pase con el horario.
 *
 * El reloj de inactividad cuenta HORAS DE ATENCIÓN -ver reloj-abierto.ts-, y eso
 * abre una puerta que hay que cerrar: unas vacaciones largas, un festivo mal
 * puesto o un horario que se queda a medias podrían dejar una conversación en
 * manos humanas indefinidamente. Que es, literalmente, el fallo que hizo construir
 * este barrido.
 *
 * Siete días son de sobra para cualquier cierre razonable -un puente, una semana
 * de vacaciones- y siguen garantizando que ninguna conversación se quede en el
 * limbo. En funcionamiento normal este tope NO SALTA NUNCA: con horario de 10 a 20
 * y umbral de 3 horas, hasta una derivación de un viernes por la noche vuelve el
 * lunes por la tarde, muy por debajo de los siete días.
 */
export const TECHO_RELOJ_HORAS = 168;

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
  motivo:
    | 'inactividad'
    | 'sin_referencia'
    | 'todavia_activa'
    /** La clínica está cerrada desde la derivación: el reloj aún no ha arrancado. */
    | 'esperando_horario'
    /** Volvió por el tope de siete días, no por haber agotado el umbral. */
    | 'techo_de_reloj';
  horas_inactiva: number | null;
  /**
   * Horas de ATENCIÓN acumuladas, que es lo que de verdad decide. Null cuando la
   * clínica no tiene un horario usable y se cuenta por reloj de pared.
   */
  horas_de_atencion: number | null;
  umbral_horas: number;
}

/** Dos decimales, como horas_inactiva, para que las dos cifras se lean igual. */
function enHoras(minutos: number): number {
  return Math.round((minutos * 100) / 60) / 100;
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
  /**
   * Horario y zona de la clínica. Si vienen y el horario abre alguna vez, el
   * umbral se mide en HORAS DE ATENCIÓN. Son opcionales a propósito: sin ellos el
   * comportamiento es el de siempre, así que una clínica sin horario legible sigue
   * protegida por el reloj de pared en vez de quedarse sin red.
   */
  zona?: string | null;
  horario?: HorarioClinica | null;
}): DecisionVuelta {
  const umbral = entrada.umbralHoras;
  const ahoraMs = entrada.ahora instanceof Date ? entrada.ahora.getTime() : entrada.ahora;

  const sinReferencia: DecisionVuelta = {
    volver: false,
    motivo: 'sin_referencia',
    horas_inactiva: null,
    horas_de_atencion: null,
    umbral_horas: umbral
  };
  if (!entrada.referencia) return sinReferencia;

  const referenciaMs = new Date(entrada.referencia).getTime();
  if (!Number.isFinite(referenciaMs)) return sinReferencia;

  const transcurridoMs = ahoraMs - referenciaMs;
  const horasInactiva = Math.round(transcurridoMs / 36_000) / 100;

  // EL RELOJ DE ATENCIÓN. Solo si la clínica tiene un horario que abre alguna vez:
  // con uno vacío o roto el reloj no avanzaría nunca y la conversación se quedaría
  // en manos humanas para siempre.
  if (entrada.zona && horarioAbreAlgunaVez(entrada.horario)) {
    const horasDeAtencion = enHoras(
      minutosDeAtencion(new Date(referenciaMs), new Date(ahoraMs), entrada.zona, entrada.horario!)
    );

    if (horasDeAtencion >= umbral) {
      return {
        volver: true, motivo: 'inactividad',
        horas_inactiva: horasInactiva, horas_de_atencion: horasDeAtencion, umbral_horas: umbral
      };
    }

    if (transcurridoMs >= TECHO_RELOJ_HORAS * MS_POR_HORA) {
      return {
        volver: true, motivo: 'techo_de_reloj',
        horas_inactiva: horasInactiva, horas_de_atencion: horasDeAtencion, umbral_horas: umbral
      };
    }

    return {
      volver: false,
      // Que el reloj no haya arrancado -cero horas de atención- es una situación
      // distinta de que vaya corriendo y aún no llegue, y en el log se distinguen.
      motivo: horasDeAtencion === 0 ? 'esperando_horario' : 'todavia_activa',
      horas_inactiva: horasInactiva, horas_de_atencion: horasDeAtencion, umbral_horas: umbral
    };
  }

  // El límite es inclusivo: a las 2 horas exactas con umbral de 2, vuelve. Si
  // fuera exclusivo habría que esperar al siguiente barrido, y con barridos de
  // minutos eso convierte «2 horas» en «2 horas y pico» sin explicación.
  if (transcurridoMs < umbral * MS_POR_HORA) {
    return {
      volver: false, motivo: 'todavia_activa',
      horas_inactiva: horasInactiva, horas_de_atencion: null, umbral_horas: umbral
    };
  }

  return {
    volver: true, motivo: 'inactividad',
    horas_inactiva: horasInactiva, horas_de_atencion: null, umbral_horas: umbral
  };
}

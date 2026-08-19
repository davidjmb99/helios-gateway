/**
 * Los mensajes de seguimiento.
 *
 * TRES REGLAS DE REDACCIÓN, y las tres tienen motivo:
 *
 * 1. NADA QUE CAMBIE SEGÚN EL GÉNERO. Nunca «interesado/interesada». No hay forma
 *    fiable de deducir el género de un nombre —Alex, Cruz, Reyes, Trinidad y
 *    cualquier nombre extranjero son una lotería— y equivocarse significa tratar
 *    a un paciente en el género que no es, con su nombre puesto y desde su
 *    clínica. Se escribe de modo que la frase valga para cualquiera: no es una
 *    limitación, es mejor redacción.
 *
 * 2. UNA SOLA PREGUNTA, AL FINAL. Dos preguntas obligan a elegir y suenan a
 *    formulario.
 *
 * 3. QUE SE NOTE QUE SE SABE QUÉ PREGUNTÓ. Es lo que hace sentir que se piensa en
 *    la persona, mucho más que cualquier fórmula de cortesía. Por eso hay un
 *    mensaje por cada forma de quedarse a medias, y no uno genérico.
 */

import type { LeadInterest } from './policy.js';

export interface DatosSeguimiento {
  /** Nombre de pila verificado. Si no lo hay, el mensaje se escribe sin él. */
  nombre?: string | null;
  /** Lo que le interesaba, en palabras del paciente: «la ortodoncia», «un implante». */
  tema?: string | null;
  /** Referencia temporal de la cita que canceló, si se sabe: «del jueves». */
  cuando?: string | null;
}

function saludo(nombre?: string | null): string {
  const limpio = String(nombre ?? '').trim();
  return limpio ? `Hola ${limpio}, ` : 'Hola, ';
}

/**
 * El texto, según cómo quedó la conversación.
 *
 * El tono lo dan tres detalles pequeños: «sin apuro» y «sin compromiso» quitan
 * presión, y la pregunta final deja la puerta abierta sin empujar.
 *
 * VAN DE USTED, Y NO ES UNA ELECCION DE ESTILO. Estos mensajes los manda un worker
 * que NO ve la conversación, así que no puede saber si el paciente tutea. El usted
 * es el registro por defecto del sistema y el que nunca queda mal: a nadie le
 * molesta que le traten de usted, y al revés sí.
 *
 * Y no dicen «hueco». Es la palabra más peninsular del vocabulario de una agenda,
 * y en Venezuela se dice fecha, cita o cupo.
 */
export function construirMensaje(interest: LeadInterest, datos: DatosSeguimiento = {}): string {
  const hola = saludo(datos.nombre);
  const tema = String(datos.tema ?? '').trim();
  const cuando = String(datos.cuando ?? '').trim();

  switch (interest) {
    case 'appointment':
      return `${hola}ayer preguntó por una cita y no llegamos a concretarla. `
        + 'Todavía tenemos agenda disponible. ¿Le sigue interesando?';

    case 'cancelled':
      return `${hola}vi que al final canceló su cita${cuando ? ` ${cuando}` : ''}. `
        + 'Si quiere, le busco otra fecha cuando le quede mejor, sin apuro. '
        + '¿Revisamos la agenda?';

    case 'reschedule_pending':
      return `${hola}quedamos en cambiarle la cita y no llegamos a fijar la nueva. `
        + '¿Quiere que le busque una fecha?';

    case 'treatment':
      return `${hola}el otro día preguntó por ${tema || 'uno de nuestros tratamientos'}. `
        + 'Si le quedó alguna duda, me dice sin compromiso. '
        + '¿Quiere que le agende una valoración?';
  }
}

/**
 * Palabras con las que se entiende que NO hay que volver a escribir.
 *
 * Deliberadamente corta y sin ambigüedad. Aquí es mejor pasarse de prudente: un
 * falso positivo cuesta un seguimiento que no se manda, y un falso negativo
 * cuesta escribirle a alguien que pidió que le dejaran en paz.
 */
const NO_INSISTIR = /\b(no me interesa|ya no me interesa|no gracias|no quiero|dejad?me en paz|no me escrib|no volv[aá]is a escribir|baja|dar de baja|stop)\b/i;

export function pideQueNoLeEscriban(texto: unknown): boolean {
  return NO_INSISTIR.test(String(texto ?? ''));
}

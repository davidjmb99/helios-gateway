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
 * El tono lo dan tres detalles pequeños: «sin prisa» y «por si te viene bien»
 * quitan presión, y la pregunta final deja la puerta abierta sin empujar.
 */
export function construirMensaje(interest: LeadInterest, datos: DatosSeguimiento = {}): string {
  const hola = saludo(datos.nombre);
  const tema = String(datos.tema ?? '').trim();
  const cuando = String(datos.cuando ?? '').trim();

  switch (interest) {
    case 'appointment':
      return `${hola}ayer preguntaste por una cita y no llegamos a concretarla. `
        + 'Sigo teniendo huecos por si te viene bien. ¿Te sigue interesando?';

    case 'cancelled':
      return `${hola}vi que al final cancelaste tu cita${cuando ? ` ${cuando}` : ''}. `
        + 'Si quieres te busco otro hueco cuando te venga mejor, sin prisa. ¿Miramos la agenda?';

    case 'reschedule_pending':
      return `${hola}quedamos en cambiarte la cita y no llegamos a fijar la nueva. `
        + '¿Quieres que te busque un hueco?';

    case 'treatment':
      return `${hola}el otro día preguntaste por ${tema || 'uno de nuestros tratamientos'}. `
        + 'Si te quedó alguna duda, dímelo sin problema. '
        + '¿Quieres que te busque hueco para una valoración?';
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

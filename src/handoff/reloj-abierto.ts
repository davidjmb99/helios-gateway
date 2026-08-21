/**
 * Cuánto tiempo DE ATENCIÓN ha pasado entre dos instantes.
 *
 * EL PROBLEMA, planteado por David el 20 de agosto de 2026:
 *
 *   «Imagínate que yo pida hablar con un humano ahorita [20:03, la clínica cierra
 *   a las 20:00]. Obviamente me va a tomar la conversación a las 10am. Y con lo de
 *   inactividad, en 3 horas lo devuelve a modo IA. Entonces ese caso no lo va a
 *   tomar nadie.»
 *
 * Tiene razón y es peor de lo que parece. El reloj de inactividad corre a las
 * 23:03 con la clínica cerrada, la conversación vuelve a modo IA en mitad de la
 * noche, y por la mañana no hay ninguna derivación esperando: el paciente pidió
 * hablar con una persona y nadie llegó a enterarse. La red de seguridad que existe
 * para que nadie se quede sin respuesta acaba borrando la petición.
 *
 * LA SOLUCIÓN NO ES ALARGAR EL UMBRAL. Poner 12 horas en vez de 3 tapa este caso y
 * rompe el de al lado: una derivación de las 10 de la mañana se quedaría muerta
 * hasta la noche. El umbral significa «cuánto tiempo le doy al equipo para
 * responder», y ese tiempo solo existe cuando hay alguien. Así que el reloj se
 * PARA cuando la clínica cierra y sigue cuando abre.
 *
 * Con horario de 10:00 a 20:00 y umbral de 3 horas:
 *
 *   derivación a las 20:03 del jueves  -> el reloj arranca el viernes a las 10:00
 *                                         y vuelve a la IA el viernes a las 13:00
 *   derivación a las 11:00 del jueves  -> vuelve a las 14:00 del jueves, igual que antes
 *   derivación el sábado por la noche  -> el reloj espera al lunes
 *
 * En los tres casos el equipo tiene tres horas REALES de trabajo para verla.
 */

import { momentoLocal, type HorarioClinica } from '../leads/policy.js';

const MINUTOS_POR_DIA = 1440;

/**
 * Tope de días que se recorren. 400 son más de trece meses: no es un límite
 * funcional, es un seguro para que un `hasta` corrupto -una fecha del año 3000 por
 * un dato mal escrito- no deje el barrido dando vueltas.
 */
const MAXIMO_DIAS = 400;

/**
 * ¿Este horario abre alguna vez?
 *
 * IMPORTA MÁS DE LO QUE PARECE. Si la clínica tiene el horario vacío o mal
 * configurado, el reloj de atención NO AVANZA NUNCA y la conversación se quedaría
 * en manos humanas para siempre — que es exactamente el fallo del 10 al 11 de
 * agosto que hizo construir todo esto. Un horario sin una sola franja no es «una
 * clínica que nunca abre»: es un horario roto, y con un horario roto se vuelve al
 * reloj de pared, que al menos garantiza que alguien acabe atendiendo.
 */
export function horarioAbreAlgunaVez(horario: HorarioClinica | null | undefined): boolean {
  if (!horario) return false;
  return Object.values(horario).some(franjas => (franjas ?? []).some(f => f.hasta > f.desde));
}

/**
 * Minutos de atención entre dos instantes.
 *
 * Se recorre DÍA LOCAL A DÍA LOCAL y se intersecan las franjas de cada día con el
 * trozo del intervalo que cae en él. Un minuto de Intl por día, no uno por minuto:
 * la versión a saltos de cuarto de hora hacía setecientas conversiones de zona por
 * conversación y por barrido, y el barrido mira hasta cincuenta a la vez.
 *
 * SOBRE EL CAMBIO DE HORA: el salto al siguiente día se calcula sumando los
 * minutos que faltan para medianoche local. En los dos días del año en que la hora
 * cambia, eso cae una hora antes o después de la medianoche real; la siguiente
 * vuelta del bucle vuelve a leer la zona y se recoloca sola, así que el error está
 * acotado a una hora, dos veces al año, y solo en zonas con horario de verano.
 * Venezuela no lo tiene, así que aquí el cálculo es exacto.
 */
export function minutosDeAtencion(
  desde: Date,
  hasta: Date,
  zona: string,
  horario: HorarioClinica
): number {
  if (hasta.getTime() <= desde.getTime()) return 0;

  let total = 0;
  let cursorMs = desde.getTime();
  const finMs = hasta.getTime();

  for (let vuelta = 0; cursorMs < finMs && vuelta < MAXIMO_DIAS; vuelta += 1) {
    const { dia, minuto } = momentoLocal(new Date(cursorMs), zona);
    // Una zona ilegible no puede dar por bueno un cómputo a medias: se corta y el
    // que llama decide. Devolver lo acumulado hasta aquí sería un número que
    // parece válido y no lo es.
    if (dia < 0) break;

    const finDelDiaMs = cursorMs + (MINUTOS_POR_DIA - minuto) * 60_000;
    const corteMs = Math.min(finDelDiaMs, finMs);
    const ventanaHasta = minuto + Math.round((corteMs - cursorMs) / 60_000);

    for (const franja of horario[dia] ?? []) {
      const abre = Math.max(franja.desde, minuto);
      const cierra = Math.min(franja.hasta, ventanaHasta);
      if (cierra > abre) total += cierra - abre;
    }

    cursorMs = corteMs;
  }

  return total;
}

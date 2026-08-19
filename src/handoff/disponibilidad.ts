/**
 * Qué se le promete al paciente cuando su conversación pasa a una persona.
 *
 * EL PROBLEMA: los mensajes de derivación decían «una persona continuará con
 * usted» y punto. A las once de la noche eso es una promesa que nadie va a
 * cumplir, y el paciente se queda mirando el chat esperando a alguien que no está.
 * Peor aún: el mensaje suena a que la atención es inmediata, así que si tarda
 * doce horas la clínica queda mal por algo que nunca prometió de verdad.
 *
 * Se resuelve diciendo la verdad: si la clínica está abierta, que le responden lo
 * antes posible; si está cerrada, CUÁNDO abre. Nada de dar una hora concreta de
 * respuesta, que eso no lo sabe nadie.
 *
 * No se dice el horario completo de la semana: es información que el paciente no
 * ha pedido y alarga el mensaje. Se dice el próximo momento en que hay alguien.
 */

import { momentoLocal, clinicaAbierta, type HorarioClinica } from '../leads/policy.js';

/** Nombres de los días, en el orden que devuelve momentoLocal (0 = domingo). */
const NOMBRES_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const PASO_MINUTOS = 15;
/** Se busca la apertura hasta ocho días por delante: cubre una semana entera más el margen del propio día. */
const HORIZONTE_MINUTOS = 8 * 24 * 60;

function horaTexto(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * El primer instante, a partir de ahora, en que la clínica está abierta.
 *
 * Se busca a saltos de cuarto de hora en vez de calcularlo con aritmética de
 * franjas porque el horario puede tener varios tramos por día -mañana y tarde- y
 * la aritmética se equivocaba en el hueco de la comida. Ocho días de horizonte a
 * saltos de 15 minutos son 768 comprobaciones: irrelevante y sin casos raros.
 */
export function proximaApertura(
  ahora: Date,
  zona: string,
  horario: HorarioClinica
): { fecha: Date; dia: number; minuto: number } | null {
  for (let salto = PASO_MINUTOS; salto <= HORIZONTE_MINUTOS; salto += PASO_MINUTOS) {
    const muestra = new Date(ahora.getTime() + salto * 60_000);
    if (!clinicaAbierta(muestra, zona, horario)) continue;

    // LA MUESTRA NO ES LA APERTURA. Buscando a saltos de cuarto de hora, la
    // primera muestra abierta cae en cualquier minuto dentro de la franja: para
    // una clínica que abre a las 10:00 podía decir «a partir de las 10:06», que
    // es una hora que no existe en ningún horario y se lee como un error.
    // Se retrocede minuto a minuto hasta el primer minuto abierto de verdad.
    // Como `ahora` está cerrado -si no, se habría devuelto antes-, el retroceso
    // se detiene solo y nunca cruza el presente. El tope es el propio salto.
    let apertura = muestra;
    for (let atras = 1; atras < PASO_MINUTOS; atras += 1) {
      const anterior = new Date(muestra.getTime() - atras * 60_000);
      if (anterior.getTime() <= ahora.getTime()) break;
      if (!clinicaAbierta(anterior, zona, horario)) break;
      apertura = anterior;
    }

    const { dia, minuto } = momentoLocal(apertura, zona);
    return { fecha: apertura, dia, minuto };
  }
  // Una clínica con la semana entera cerrada existe -un horario mal configurado, o
  // vacaciones-. En ese caso no se inventa una fecha: se devuelve null y el mensaje
  // se queda en la versión sin promesa de cuándo.
  return null;
}

/**
 * La frase que se añade al mensaje de derivación.
 *
 * Devuelve cadena vacía cuando no hay nada honesto que añadir, para que quien la
 * use no tenga que comprobar nada: concatena y ya.
 */
export function fraseDeDisponibilidad(entrada: {
  ahora: Date;
  zona: string;
  horario: HorarioClinica;
}): string {
  const { ahora, zona, horario } = entrada;

  if (clinicaAbierta(ahora, zona, horario)) {
    // Abierta: no se promete un plazo. «Lo antes posible» es lo máximo que se
    // puede sostener sin saber cuánta cola tiene el equipo.
    return 'El equipo está atendiendo ahora y le responderá por aquí lo antes posible.';
  }

  const apertura = proximaApertura(ahora, zona, horario);
  if (!apertura) {
    return 'Le responderán por aquí dentro del horario de atención de la clínica.';
  }

  const hoy = momentoLocal(ahora, zona).dia;
  const cuando = apertura.dia === hoy
    ? 'hoy'
    // «mañana» solo si es el día siguiente de verdad. Con dos días o más se dice
    // el nombre del día, que es lo que entiende cualquiera. Y el día sale de la
    // próxima apertura REAL: un sábado por la noche con el domingo cerrado dice
    // «el lunes», nunca «mañana».
    : (apertura.dia === (hoy + 1) % 7 ? 'mañana' : `el ${NOMBRES_DIA[apertura.dia]}`);

  // SE DICE EL HORARIO, NO SE PROMETE UNA RESPUESTA A ESA HORA.
  //
  // La diferencia importa. «El equipo le responderá el lunes a las 10:00» es un
  // compromiso que el sistema no puede sostener: el horario configurado en el
  // panel no sabe de festivos ni de vacaciones, así que en un puente nombraría un
  // día en el que no hay nadie. «Dentro del horario de atención, que se reanuda el
  // lunes a las 10:00» dice lo mismo de útil y no promete nada que no sea el
  // horario, que es un hecho de la clínica y no una expectativa del paciente.
  return 'Le responderán dentro del horario de atención, que se reanuda '
    + `${cuando} a las ${horaTexto(apertura.minuto)}.`;
}

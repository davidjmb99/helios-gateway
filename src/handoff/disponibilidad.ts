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

/**
 * La hora en formato de doce, que es como se lee un horario en Venezuela.
 *
 * «14:00» se lee como un campo de base de datos y obliga al paciente a traducir;
 * traducir es donde uno se equivoca y se presenta a la hora que no era.
 *
 * Se escribe pegado -«8:00am»- y no «8:00 de la mañana», por decisión de David y
 * porque en un mensaje de WhatsApp la forma corta se lee de un vistazo. Lo que NO
 * puede pasar es que Helios diga «8:00am» y esta coletilla diga «8:00 de la mañana»
 * en el mismo mensaje, asi que las dos partes usan la misma forma.
 *
 * Las 12 del día son «12:00pm» y las 12 de la noche «12:00am», que es lo correcto y
 * lo que se entiende sin pensar. Aquí llegué a poner «12:00m» por mi cuenta y David
 * lo corrigió: era una forma inventada que nadie usa.
 */
export function horaTexto(minutos: number): string {
  const h24 = Math.floor(minutos / 60);
  const m = minutos % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const reloj = m === 0 ? `${h12}:00` : `${h12}:${String(m).padStart(2, '0')}`;

  return h24 < 12 ? `${reloj}am` : `${reloj}pm`;
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
    return 'El equipo está atendiendo ahora y responderá por aquí lo antes posible.';
  }

  const apertura = proximaApertura(ahora, zona, horario);
  if (!apertura) {
    return 'El equipo responderá por aquí dentro del horario de atención de la clínica.';
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
  return 'El equipo responde dentro del horario de atención, que se reanuda '
    + `${cuando} a las ${horaTexto(apertura.minuto)}.`;
}

/**
 * QUÉ HORA ES Y SI LA CLÍNICA ESTÁ ABIERTA, como hechos para el payload.
 *
 * EL FALLO, Y ES EL CUARTO DEL MISMO TIPO. El sábado 5-sep-2026 a las 15:07, un paciente
 * escribió «hola, buenos días» a COI y Helios contestó: «¡Hola, David, buenos días! ¿Listo
 * para agendar su limpieza? Hoy sábado atendemos de 10:00am a 3:00pm. ¿A qué hora le
 * gustaría venir?».
 *
 * A las 15:07 esa franja ENTERA ya había pasado. Y encima «buenos días» a las tres de la
 * tarde.
 *
 * NO ERA QUE IGNORARA UNA REGLA: es que no podía saberlo. En `clinic_context` viajaba
 * `today` -qué día es- y `clinic_hours` -a qué hora abre la clínica los sábados-, y NUNCA
 * LA HORA. Con esos dos datos, «hoy sábado atendemos de 10:00 a 15:00» es exactamente lo
 * que hay que responder; el error no estaba en el razonamiento sino en lo que tenía
 * delante.
 *
 * Mismo patrón que `today`, que el espejo del trato y que `ultima_actividad`: pedirle
 * deducir algo que no tiene. Y se arregla igual: dándole el hecho.
 *
 * LO QUE NO ERA EL FALLO, Y CONVIENE TENERLO CLARO: la agenda nunca habría reservado a las
 * dos de la tarde. `huecos.ts` recorta a `ahora + antelación`, así que si Helios llega a
 * consultar el calendario, los huecos pasados no existen. El daño es anterior a eso —
 * invitar al paciente a pedir una hora que la agenda le va a negar después—, y es el tipo
 * de fallo que hace quedar mal a la clínica sin llegar a producir una cita mala.
 *
 * POR QUÉ `closes_at` ES EL FIN DEL TRAMO ACTUAL Y NO EL DEL DÍA. Una clínica con parada
 * para comer -de 9 a 13 y de 15 a 19- estando a las 12:50 devuelve «1:00pm», no «7:00pm».
 * Es cierto, y se queda corto en vez de pasarse: si el paciente pide las 16:00, la agenda
 * se la dará igual. Quedarse corto solo hace perder una oferta; pasarse hace prometer una
 * hora que no existe, y eso es lo que estamos arreglando.
 */
export function momentoDeLaClinica(entrada: {
  ahora: Date;
  zona: string;
  horario: HorarioClinica | null;
}): { now: string; open_now?: boolean; closes_at?: string; next_open_label?: string } {
  const { ahora, zona, horario } = entrada;
  const { dia, minuto } = momentoLocal(ahora, zona);

  // LA HORA VIAJA SIEMPRE, tenga o no horario configurado la clínica. «Buenos días» a las
  // tres de la tarde está mal aunque no se sepa a qué hora abren, y saber la hora también
  // es lo que permite entender «¿puede ser en una hora?».
  const salida: { now: string; open_now?: boolean; closes_at?: string; next_open_label?: string } = {
    now: horaTexto(minuto)
  };

  // SIN HORARIO CONFIRMADO NO SE DICE NADA MÁS, y es la misma regla que sigue
  // `clinic_hours`: mandar el horario por defecto haría creer que es el de esta clínica.
  // Aquí sería peor todavía, porque `open_now` es un binario que suena a hecho
  // comprobado: un «false» inventado cierra una clínica que está abierta.
  if (!horario || dia < 0) return salida;

  const abierta = clinicaAbierta(ahora, zona, horario);
  salida.open_now = abierta;

  if (abierta) {
    // Se camina a saltos de cuarto de hora hasta que deja de estar abierta, igual que
    // `proximaApertura`, y por el mismo motivo: con varios tramos al día la aritmética de
    // franjas se equivoca justo en el hueco de la comida.
    for (let paso = PASO_MINUTOS; paso <= 24 * 60; paso += PASO_MINUTOS) {
      const despues = new Date(ahora.getTime() + paso * 60000);
      if (clinicaAbierta(despues, zona, horario)) continue;

      // LA MUESTRA NO ES EL CIERRE, exactamente igual que en `proximaApertura`. Buscando a
      // saltos de cuarto de hora, la primera muestra cerrada cae en cualquier minuto
      // posterior al cierre: una clínica que cierra a las 13:00 decía «1:05pm», una hora
      // que no existe en ningún horario y que se lee como un error del sistema.
      //
      // Lo cazó la prueba de la parada para comer. Se retrocede minuto a minuto hasta el
      // primer minuto cerrado de verdad, que es la hora de cierre.
      let cierre = despues;
      for (let atras = 1; atras < PASO_MINUTOS; atras += 1) {
        const anterior = new Date(despues.getTime() - atras * 60000);
        if (anterior.getTime() <= ahora.getTime()) break;
        if (clinicaAbierta(anterior, zona, horario)) break;
        cierre = anterior;
      }

      salida.closes_at = horaTexto(momentoLocal(cierre, zona).minuto);
      break;
    }
    return salida;
  }

  // CERRADA: cuándo se vuelve a abrir. Sin esto, el modelo sabe que no puede ofrecer hoy y
  // no tiene nada que ofrecer en su lugar, que deja la conversación en un callejón.
  const apertura = proximaApertura(ahora, zona, horario);
  if (apertura) {
    // «el lunes 7 a las 10:00am»: el día CON SU NÚMERO, que no envejece si la conversación
    // cruza la medianoche, al revés que «mañana». Es la forma que ya se fijó para las
    // fechas del payload.
    const diaDelMes = Number(new Intl.DateTimeFormat('en-US', { timeZone: zona, day: 'numeric' })
      .format(apertura.fecha));
    salida.next_open_label =
      `el ${NOMBRES_DIA[apertura.dia]} ${diaDelMes} a las ${horaTexto(apertura.minuto)}`;
  }

  return salida;
}

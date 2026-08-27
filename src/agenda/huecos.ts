/**
 * Qué huecos se le pueden ofrecer a un paciente, y con qué doctor.
 *
 * ESTA ES LA PARTE DIFÍCIL DE UNA AGENDA CON VARIOS DOCTORES, y no es hablar con Google.
 * Llamar a `freebusy.query` es una petición HTTP; decidir qué huecos existen es cruzar el
 * horario de cada doctor, lo que ya tiene ocupado, la duración del servicio, el margen
 * entre citas y la antelación mínima. Por eso vive aquí, en código que se puede probar sin
 * red y sin credenciales, y no dentro del cliente de Google.
 *
 * POR QUÉ EXISTE ESTO. Cal.com resuelve lo mismo por 12 dólares por doctor y mes, y para
 * una clínica está bien. Para varias no: cinco clínicas de tres doctores son 180 dólares
 * al mes de un coste que no controlamos. La API de Google Calendar es gratuita y
 * `freebusy.query` acepta hasta cincuenta calendarios en una sola llamada, diciendo cuál
 * está libre. Lo que Google NO da es esto: las reglas de disponibilidad.
 *
 * TRES DECISIONES QUE CONVIENE ENTENDER ANTES DE TOCAR NADA:
 *
 *  1. UN HUECO SOLO SE OFRECE SI SE PUEDE RESERVAR DE VERDAD. Se comprueba que el doctor
 *     asignado esté libre durante toda la cita MÁS el margen a los dos lados. Ofrecer algo
 *     que luego falla al reservar es peor que no ofrecerlo: el paciente ya se hizo a la
 *     idea de esa hora.
 *
 *  2. HELIOS NO ELIGE DOCTOR, LO ASIGNA EL REPARTO. Es la regla 73 del check list: quién
 *     atiende cada caso es una decisión clínica y organizativa de la clínica, no del bot.
 *     Aquí solo se reparte entre los que YA pueden hacer ese servicio, y por carga de
 *     trabajo, que es lo mismo que hace el round-robin de Cal.com.
 *
 *  3. LA ASIGNACIÓN DE LA OFERTA ES PROVISIONAL. Entre que se ofrecen los huecos y el
 *     paciente elige uno pueden pasar minutos, y en esos minutos alguien puede reservar
 *     por teléfono. QUIEN RESERVA TIENE QUE VOLVER A COMPROBARLO. Esto devuelve una
 *     propuesta, no una reserva.
 */

import { type HorarioClinica } from '../leads/policy.js';

/**
 * La hora local de un instante, con el formateador guardado.
 *
 * Es lo mismo que `momentoLocal` de leads/policy.ts, pero SIN crear un
 * `Intl.DateTimeFormat` en cada llamada. Aquí se recorre la ventana en pasos de cinco
 * minutos -para poder alinear los huecos a la hora de apertura y no a medianoche-, así que
 * son miles de conversiones por consulta y crear el formateador cada vez costaba más que
 * todo lo demás junto.
 */
const FORMATEADORES = new Map<string, Intl.DateTimeFormat>();
const DIAS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function horaLocal(fecha: Date, zona: string): { dia: number; minuto: number } {
  let f = FORMATEADORES.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zona, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    });
    FORMATEADORES.set(zona, f);
  }
  const partes = f.formatToParts(fecha);
  const valor = (tipo: string) => partes.find(p => p.type === tipo)?.value ?? '';
  // Intl devuelve "24" para medianoche en algunos entornos.
  const hora = Number(valor('hour')) % 24;
  return { dia: DIAS.indexOf(valor('weekday').toLowerCase()), minuto: hora * 60 + Number(valor('minute')) };
}

/** Un bloque ocupado, tal como lo devuelve `freebusy.query`. */
export interface FranjaOcupada {
  desde: Date;
  hasta: Date;
}

export interface DoctorConAgenda {
  /** El calendario: normalmente su correo. Es lo que se le pasa a Google. */
  id: string;
  nombre: string;
  /** Sus horas de trabajo, por día de la semana, en minutos desde medianoche. */
  horario: HorarioClinica;
  /** Lo que ya tiene ocupado en la ventana consultada. */
  ocupado: FranjaOcupada[];
  /**
   * A quién se le da antes. Número más bajo, antes.
   *
   * NO ES UNA RESTRICCIÓN, ES UNA PREFERENCIA, y esa diferencia la pidió David con la
   * urgencia dental: «principalmente la ve Vélez, pero si está ocupado la puede tomar
   * cualquier doctor». Con una lista plana habría que elegir entre dejarle la urgencia solo
   * a él -y perder la cita cuando esté ocupado- o repartirla entre los cuatro por igual
   * -y que una urgencia acabe con quien no es cirujano teniendo al cirujano libre-.
   *
   * Quien no lo diga va con 0, así que sin prioridades esto se comporta como antes.
   */
  prioridad?: number;
}

export interface HuecoOfrecido {
  inicio: Date;
  fin: Date;
  doctor_id: string;
  doctor_nombre: string;
}

/**
 * Cada cuántos minutos se prueba un hueco. POR DEFECTO, LA DURACIÓN MÁS EL MARGEN.
 *
 * ES LO QUE PIDIÓ DAVID, y su razonamiento es el correcto: «bajemos la duración a 45
 * minutos, para que así con los 15 minutos más sean 1 hora». Lo que ocupa a un doctor no
 * son los 45 minutos de la cita: son 45 más los 15 de limpiar la sala y escribir la nota.
 * Si el paso fuera solo la duración, los huecos saldrían pegados -10:00, 10:45, 11:30- y
 * el margen no separaría una cita de la siguiente.
 *
 * Y CON PASO DE UNA HORA LOS HUECOS CAEN EN PUNTO, que es como los ofrece una clínica. El
 * alineado es a múltiplos del paso desde medianoche en hora local, así que 60 da las en
 * punto, 30 las y media, y 45 daría las «10:30, 11:15» -por eso el paso no es la duración-.
 *
 * Con un paso más fino los huecos se solapan: para una cita de una hora, ofrecer 10:00,
 * 10:15 y 10:30 son tres formas de decir lo mismo, y encima estropea el reparto. Quien
 * quiera solapes puede pedirlos pasando `pasoMin`, pero no es lo natural.
 */
const PASO_MINIMO = 5;

/** Tope de huecos devueltos. Ofrecerle cuarenta horas a un paciente no le ayuda a elegir. */
const MAXIMO_POR_DEFECTO = 20;

/**
 * Tope de candidatos que se recorren. No es una regla de negocio: es el seguro para que
 * una ventana corrupta -un `hasta` del año 3000 por un dato mal escrito- no deje esto
 * dando vueltas. 20.000 pasos de cinco minutos son unos setenta dias, mas de lo que
 * cualquier clinica ofrece.
 */
const MAXIMO_CANDIDATOS = 20000;

const MINUTOS_POR_DIA = 1440;

/** ¿Cabe una cita de `duracion` minutos empezando en `minuto`, dentro de este horario? */
function cabeEnElHorario(horario: HorarioClinica, dia: number, minuto: number, duracion: number): boolean {
  const tramos = horario?.[dia];
  if (!Array.isArray(tramos)) return false;
  // La cita entera tiene que caber en UN tramo. Si el doctor libra de 14 a 16, una cita de
  // 13:30 a 14:30 no vale aunque las dos puntas caigan en horario.
  return tramos.some(t => minuto >= t.desde && minuto + duracion <= t.hasta);
}

/** ¿Choca [desde, hasta) con algo de lo que ya tiene ocupado? */
function estaOcupado(doctor: DoctorConAgenda, desde: number, hasta: number): boolean {
  return (doctor.ocupado ?? []).some(f => {
    const d = f.desde instanceof Date ? f.desde.getTime() : new Date(f.desde).getTime();
    const h = f.hasta instanceof Date ? f.hasta.getTime() : new Date(f.hasta).getTime();
    if (!Number.isFinite(d) || !Number.isFinite(h)) {
      // UNA FRANJA ILEGIBLE SE TRATA COMO OCUPADO. Si no se entiende lo que Google
      // devolvió, lo prudente es no ofrecer esa hora: el precio de perder un hueco es una
      // oportunidad; el de doblar una cita, dos pacientes en la misma silla.
      return true;
    }
    return desde < h && hasta > d;
  });
}

/**
 * Minutos que ese doctor ya tiene ocupados. Es su carga, y con ella se reparte.
 *
 * SE CUENTA TODO LO QUE VENGA EN `ocupado`, sin recortarlo a la ventana que se está
 * consultando. Si se recortara, un doctor que lleva trabajando desde las diez aparecería
 * igual de descansado que uno que entra a las dos, solo porque la consulta era «de 14:00 a
 * 17:00»: dentro de esa franja los dos tienen cero.
 *
 * Así que quien llama decide qué le pasa aquí, y esa decisión ES el criterio de reparto: lo
 * natural es pedirle a Google el día entero aunque solo se ofrezcan las tardes.
 */
function cargaDe(doctor: DoctorConAgenda): number {
  return (doctor.ocupado ?? []).reduce((total, f) => {
    const d = new Date(f.desde).getTime();
    const h = new Date(f.hasta).getTime();
    if (!Number.isFinite(d) || !Number.isFinite(h)) return total;
    return total + Math.max(0, h - d);
  }, 0) / 60000;
}

/**
 * Los huecos que se le pueden ofrecer al paciente, en orden.
 *
 * Devuelve una lista vacía cuando no hay ninguno, que NO es un error: significa que no hay
 * sitio en esa ventana. Quien llama tiene que decirlo así y ofrecer otra fecha, nunca
 * inventar una hora.
 */
export function huecosDisponibles(entrada: {
  doctores: DoctorConAgenda[];
  /** La zona de la clínica. El horario de los doctores está en hora local. */
  zona: string;
  desde: Date;
  hasta: Date;
  duracionMin: number;
  /** Margen antes y después de cada cita. Limpieza de la sala, notas, retrasos. */
  margenMin?: number;
  /** Cuánto hay que avisar como mínimo. Nadie reserva para dentro de diez minutos. */
  antelacionMin?: number;
  /** Cada cuántos minutos se prueba un hueco. Por defecto, duración + margen. */
  pasoMin?: number;
  maximo?: number;
  ahora?: Date;
}): HuecoOfrecido[] {
  const doctores = (entrada.doctores ?? []).filter(d => d && d.id);
  const duracion = Math.round(Number(entrada.duracionMin));
  if (doctores.length === 0 || !Number.isFinite(duracion) || duracion <= 0) return [];

  const margen = Math.max(0, Math.round(Number(entrada.margenMin ?? 0)) || 0);
  const antelacion = Math.max(0, Math.round(Number(entrada.antelacionMin ?? 0)) || 0);
  const paso = Math.max(PASO_MINIMO, Math.round(Number(entrada.pasoMin ?? (duracion + margen))) || duracion);
  const maximo = Math.max(1, Math.round(Number(entrada.maximo ?? MAXIMO_POR_DEFECTO)) || MAXIMO_POR_DEFECTO);

  const ahora = entrada.ahora instanceof Date ? entrada.ahora.getTime() : Date.now();
  const finVentana = new Date(entrada.hasta).getTime();
  if (!Number.isFinite(finVentana)) return [];

  // LA ANTELACIÓN MÍNIMA MANDA SOBRE LO QUE PIDA EL PACIENTE. Si pide «hoy» y son las
  // 13:55 con dos horas de antelación, el primer hueco no puede ser antes de las 15:55.
  const sinAlinear = Math.max(new Date(entrada.desde).getTime(), ahora + antelacion * 60000);
  if (!Number.isFinite(sinAlinear) || sinAlinear >= finVentana) return [];

  // LA REJILLA ES ABSOLUTA, NO EMPIEZA DONDE EMPIECE LA VENTANA. Se sube al siguiente
  // múltiplo de cinco minutos del reloj, y esto no es cosmética: es el fallo que dejó a una
  // clínica entera sin un solo hueco durante siete días.
  //
  // El bucle avanza de cinco en cinco DESDE `inicioVentana`. Si esa marca cae en un minuto
  // que no es múltiplo de cinco -y `Date.now()` casi nunca lo es-, TODOS los candidatos
  // heredan ese desfase: preguntando a las 13:54 salen las 13:54, 13:59, 14:04, 14:09... y
  // ninguna cae nunca en punto. El filtro de alineado las rechaza una por una, durante toda
  // la ventana, y la respuesta es «no hay ningún hueco» con las agendas vacías.
  //
  // ASÍ QUE FUNCIONABA SOLO SI PREGUNTABAS EN UN MINUTO MÚLTIPLO DE CINCO. Cuatro de cada
  // cinco veces, cero. No lo encontró ninguna prueba porque todas usaban horas redondas
  // -«T14:00:00Z»-, que es justo el caso que no falla. Lo encontró la primera consulta
  // contra los calendarios de verdad, a las 13:54.
  const PASO_MS = PASO_MINIMO * 60000;
  const inicioVentana = Math.ceil(sinAlinear / PASO_MS) * PASO_MS;
  if (inicioVentana >= finVentana) return [];

  // A QUE HORA ABRE CADA DIA. Es el ancla del alineado, y tiene que ser la apertura y no
  // medianoche: con citas de 45 minutos mas 15 de margen -paso de 60- da igual, pero con
  // un paso de 90 los huecos caian a las 10:30 aunque la clinica abriera a las 10:00, y se
  // perdia el primer hueco del dia entero. Lo encontro la prueba del margen.
  //
  // Se toma la apertura MAS TEMPRANA de todos los doctores, para no dejar fuera al que
  // entra antes.
  const apertura: number[] = [];
  for (let d = 0; d < 7; d++) {
    let min = Infinity;
    for (const doc of doctores) {
      for (const tramo of (doc.horario?.[d] ?? [])) {
        if (tramo && Number.isFinite(tramo.desde)) min = Math.min(min, tramo.desde);
      }
    }
    apertura[d] = min;
  }
  if (apertura.every(a => a === Infinity)) return [];

  // Carga de partida de cada doctor: todo lo que ya tiene ocupado.
  const carga = new Map<string, number>();
  for (const d of doctores) carga.set(d.id, cargaDe(d));

  const huecos: HuecoOfrecido[] = [];
  let candidatos = 0;

  // SE RECORRE CADA CINCO MINUTOS Y SE FILTRA, en vez de saltar de paso en paso. Saltando
  // habria que saber de antemano el instante exacto de la apertura de cada dia, y eso
  // obliga a convertir de hora local a instante -la direccion dificil, la que se rompe con
  // los cambios de hora-. Recorriendo fino solo se convierte instante -> hora local, que es
  // la direccion fiable, y el formateador guardado hace que salga barato.
  for (let t = inicioVentana; t + duracion * 60000 <= finVentana; t += PASO_MINIMO * 60000) {
    if (huecos.length >= maximo || ++candidatos > MAXIMO_CANDIDATOS) break;

    const inicio = new Date(t);
    const fin = new Date(t + duracion * 60000);
    const local = horaLocal(inicio, entrada.zona);
    if (local.dia < 0) continue;

    // EL ALINEADO: solo valen las horas que caen en un multiplo del paso contando DESDE LA
    // APERTURA. Con apertura a las 10:00 y paso de 60 salen las 10:00, 11:00, 12:00; con
    // paso de 90, las 10:00, 11:30, 13:00. Nunca se pierde el primer hueco del dia.
    const abre = apertura[local.dia];
    if (!Number.isFinite(abre) || local.minuto < abre) continue;
    if ((local.minuto - abre) % paso !== 0) continue;

    const localFin = horaLocal(fin, entrada.zona);

    // UNA CITA QUE CRUZA UN CAMBIO DE HORA NO SE OFRECE. Si al pasar de invierno a verano
    // el reloj salta, la hora local del final no cuadra con la del principio más la
    // duración, y la cita quedaría desplazada una hora sin que nadie se entere. Se pierden
    // unos huecos dos veces al año; reservar a la hora equivocada sale mucho más caro.
    if ((local.minuto + duracion) % MINUTOS_POR_DIA !== localFin.minuto) continue;

    const libres = doctores.filter(d =>
      cabeEnElHorario(d.horario, local.dia, local.minuto, duracion)
      && !estaOcupado(d, t - margen * 60000, t + (duracion + margen) * 60000)
    );
    if (libres.length === 0) continue;

    // EL REPARTO, EN TRES ESCALONES Y EN ESTE ORDEN:
    //
    //   1. LA PRIORIDAD MANDA SOBRE LA CARGA. Si el cirujano puede coger la urgencia, la
    //      coge él aunque venga más cargado: para eso es el preferente. Solo cuando NINGÚN
    //      preferente está libre entran los demás, y entonces la cita se hace igual en vez
    //      de perderse.
    //
    //   2. Entre los de la misma prioridad, el menos cargado. Se cuenta también lo que se
    //      le ha ido asignando EN ESTA MISMA consulta, para que los huecos seguidos no
    //      caigan todos en el mismo doctor solo porque empezó la mañana más libre.
    //
    //   3. Y el desempate final por `id`, no al azar: dos consultas seguidas tienen que dar
    //      la misma respuesta, o el paciente ve un doctor distinto cada vez que refresca.
    const elegido = libres.reduce((mejor, d) => {
      const pa = d.prioridad ?? 0;
      const pb = mejor.prioridad ?? 0;
      if (pa !== pb) return pa < pb ? d : mejor;
      const a = carga.get(d.id) ?? 0;
      const b = carga.get(mejor.id) ?? 0;
      if (a !== b) return a < b ? d : mejor;
      return d.id < mejor.id ? d : mejor;
    });

    carga.set(elegido.id, (carga.get(elegido.id) ?? 0) + duracion + margen);
    huecos.push({ inicio, fin, doctor_id: elegido.id, doctor_nombre: elegido.nombre });
  }

  return huecos;
}

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

import { momentoLocal, type HorarioClinica } from '../leads/policy.js';

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
}

export interface HuecoOfrecido {
  inicio: Date;
  fin: Date;
  doctor_id: string;
  doctor_nombre: string;
}

/**
 * Cada cuántos minutos se prueba un hueco. POR DEFECTO, LA DURACIÓN DE LA CITA.
 *
 * Con un paso más fino los huecos se solapan: para una cita de una hora, ofrecer 10:00,
 * 10:15 y 10:30 son tres formas de decir lo mismo, y encima estropea el reparto -cada
 * oferta suma carga a un doctor que en realidad solo va a atender una-.
 *
 * Una clínica ofrece «10:00, 11:00 o 12:00», no una lista cada cuarto de hora. Quien
 * quiera huecos solapados puede pedirlos pasando `pasoMin`, pero no es lo natural.
 */
const PASO_MINIMO = 5;

/** Tope de huecos devueltos. Ofrecerle cuarenta horas a un paciente no le ayuda a elegir. */
const MAXIMO_POR_DEFECTO = 20;

/**
 * Tope de candidatos que se recorren. No es una regla de negocio: es el seguro para que
 * una ventana corrupta -un `hasta` del año 3000 por un dato mal escrito- no deje esto
 * dando vueltas. 4000 pasos de 15 minutos son mas de cuarenta dias.
 */
const MAXIMO_CANDIDATOS = 4000;

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
  /** Cada cuántos minutos se prueba un hueco. Por defecto, la duración: sin solapes. */
  pasoMin?: number;
  maximo?: number;
  ahora?: Date;
}): HuecoOfrecido[] {
  const doctores = (entrada.doctores ?? []).filter(d => d && d.id);
  const duracion = Math.round(Number(entrada.duracionMin));
  if (doctores.length === 0 || !Number.isFinite(duracion) || duracion <= 0) return [];

  const margen = Math.max(0, Math.round(Number(entrada.margenMin ?? 0)) || 0);
  const antelacion = Math.max(0, Math.round(Number(entrada.antelacionMin ?? 0)) || 0);
  const paso = Math.max(PASO_MINIMO, Math.round(Number(entrada.pasoMin ?? duracion)) || duracion);
  const maximo = Math.max(1, Math.round(Number(entrada.maximo ?? MAXIMO_POR_DEFECTO)) || MAXIMO_POR_DEFECTO);

  const ahora = entrada.ahora instanceof Date ? entrada.ahora.getTime() : Date.now();
  const finVentana = new Date(entrada.hasta).getTime();
  if (!Number.isFinite(finVentana)) return [];

  // LA ANTELACIÓN MÍNIMA MANDA SOBRE LO QUE PIDA EL PACIENTE. Si pide «hoy» y son las
  // 13:55 con dos horas de antelación, el primer hueco no puede ser antes de las 15:55.
  const sinAlinear = Math.max(new Date(entrada.desde).getTime(), ahora + antelacion * 60000);
  if (!Number.isFinite(sinAlinear) || sinAlinear >= finVentana) return [];

  // Y LOS HUECOS CAEN EN HORA REDONDA. Sin esto, una consulta a las 10:05 con dos horas de
  // antelación ofrecía «las 12:05», y ninguna clínica cita a y cinco: se lee como un error
  // del sistema aunque la hora sea correcta.
  //
  // Se alinea al múltiplo del paso EN HORA LOCAL, que es la que ve el paciente. Con citas
  // de una hora salen las en punto; con paso de 30, las y media también.
  const localInicio = momentoLocal(new Date(sinAlinear), entrada.zona);
  const inicioVentana = localInicio.dia < 0
    ? sinAlinear
    : sinAlinear + ((paso - (localInicio.minuto % paso)) % paso) * 60000;
  if (inicioVentana >= finVentana) return [];

  // Carga de partida de cada doctor: todo lo que ya tiene ocupado.
  const carga = new Map<string, number>();
  for (const d of doctores) carga.set(d.id, cargaDe(d));

  const huecos: HuecoOfrecido[] = [];
  let candidatos = 0;

  for (let t = inicioVentana; t + duracion * 60000 <= finVentana; t += paso * 60000) {
    if (huecos.length >= maximo || ++candidatos > MAXIMO_CANDIDATOS) break;

    const inicio = new Date(t);
    const fin = new Date(t + duracion * 60000);
    const local = momentoLocal(inicio, entrada.zona);
    const localFin = momentoLocal(fin, entrada.zona);
    if (local.dia < 0) continue;

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

    // EL REPARTO: el menos cargado. Y se cuenta también lo que se le ha ido asignando EN
    // ESTA MISMA consulta, para que los huecos seguidos no caigan todos en el mismo doctor
    // solo porque empezó la mañana más libre. Es el «load balancing» del round-robin.
    //
    // El desempate es por `id` y no al azar a propósito: dos consultas seguidas tienen que
    // dar la misma respuesta, o el paciente ve un doctor distinto cada vez que refresca.
    const elegido = libres.reduce((mejor, d) => {
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

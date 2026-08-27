/**
 * La respuesta a «¿tienes mañana a las 2 con la Dra. Ana?».
 *
 * ESTE MÓDULO DEVUELVE LA FORMA DE UNA FRASE, no una lista de huecos, y esa es toda la
 * idea. La pidió David así:
 *
 *     «La Dra. Ana no está disponible mañana a las 2:00 PM, pero la Dra. María sí tiene
 *      disponibilidad en ese horario. ¿Quieres que te reserve con ella o prefieres que
 *      busquemos otro horario disponible con la Dra. Ana?»
 *
 * Son tres datos: si el que pidió puede, quién más puede a esa misma hora, y qué otras
 * horas tiene el que pidió. Se devuelven los tres juntos, en una sola llamada, para que
 * Helios lea y hable. Sin eso haría falta una ronda por pregunta -y una ronda es una
 * llamada entera al modelo, con un paciente esperando en WhatsApp-.
 *
 * HELIOS NO ELIGE DOCTOR. Es la regla 73 y David la repitió al pedir esto: «nunca reserves
 * con otro profesional sin consentimiento del paciente». Aquí no hay reparto por carga ni
 * asignación automática: se devuelve QUIÉN PUEDE, y quien decide es el paciente.
 *
 * Y NADA DE ESTO RESERVA NADA. Entre ofrecer y elegir pasan minutos, y en esos minutos
 * alguien puede llamar por teléfono. Quien reserve vuelve a comprobarlo.
 */

import { doctoresPara, type DoctorDeClinica } from './doctores.js';
import { doctorPorNombre, preguntaDeApellido } from './nombres.js';
import { leerCierres, estaCerrado } from './cierres.js';
import { agendaDeDoctores, esError, type Dependencias, type ErrorDeAgenda } from './google.js';
import { huecosDisponibles, type DoctorConAgenda } from './huecos.js';
import type { HorarioClinica } from '../leads/policy.js';

/** Cuántos días hacia delante se mira cuando hay que buscar otras horas. */
const DIAS_DE_BUSQUEDA = 14;
/** Cuántos huecos alternativos se ofrecen. Más de tres es una lista, no una respuesta. */
const MAX_ALTERNATIVAS = 3;

export interface HuecoLegible {
  /** «jue 10/09, 15:30», en la zona de la clínica. Es lo que se lee en voz alta. */
  cuando: string;
  /** El instante exacto, para reservar sin volver a interpretar el texto. */
  inicio: string;
  doctor: string;
}

export interface Consulta {
  /**
   * A quién nombró el paciente, si nombró a alguien.
   *
   * `varios` es una respuesta de pleno derecho y no un fallo: con dos doctoras Ana, elegir
   * una manda al paciente con la que no era y eso no se descubre hasta que llega.
   */
  doctor?: {
    nombre: string;
    /** `varios`: hay que preguntar el apellido. `desconocido`: no trabaja aquí. */
    duda?: 'varios' | 'desconocido';
    /** «Martínez o López», ya montado para preguntarlo. */
    apellidos?: string;
  };
  /** Si el paciente pidió una hora concreta: si ese doctor la tiene libre. */
  pedido?: { cuando: string; libre: boolean };
  /** Quién MÁS puede a esa misma hora. Solo cuando el que pidió no puede. */
  mismaHora?: string[];
  /** Otras horas del doctor que pidió. */
  otras?: HuecoLegible[];
  /** Cuando no pidió doctor: los primeros huecos, con quién es cada uno. */
  huecos?: HuecoLegible[];
  /** La clínica cierra ese día. Con el motivo, si la clínica lo escribió. */
  cerrado?: string;
  /** No se pudo consultar. Helios deriva; NO dice que no hay huecos. */
  error?: string;
}

function formatear(fecha: Date, zona: string): string {
  return new Intl.DateTimeFormat('es', {
    timeZone: zona, weekday: 'short', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(fecha);
}

const diaLocal = (fecha: Date, zona: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(fecha);

const legible = (h: { inicio: Date; doctor_nombre: string }, zona: string): HuecoLegible => ({
  cuando: formatear(h.inicio, zona),
  inicio: h.inicio.toISOString(),
  doctor: h.doctor_nombre
});

export interface EntradaDeConsulta {
  doctores: DoctorDeClinica[];
  cierres: unknown;
  zona: string;
  /** Como lo nombró el paciente: «Ana», «el dr Vélez», o nada. */
  doctorPedido?: string;
  /** La hora que pidió, si pidió una. */
  cuando?: Date;
  servicio?: string;
  duracionMin?: number;
  margenMin?: number;
  antelacionMin?: number;
  ahora?: Date;
}

export async function consultarAgenda(
  entrada: EntradaDeConsulta,
  deps: Dependencias = {}
): Promise<Consulta> {
  const ahora = entrada.ahora ?? new Date();
  const zona = entrada.zona;
  const duracion = entrada.duracionMin ?? 45;
  const margen = entrada.margenMin ?? 15;
  const cierres = leerCierres(entrada.cierres) ?? [];

  if (!entrada.doctores || entrada.doctores.length === 0) {
    return { error: 'sin_doctores' };
  }

  // A QUIÉN NOMBRÓ, ANTES DE SALIR A LA RED. Si hay dos que se llaman igual, la respuesta
  // es preguntar el apellido, y para eso no hace falta molestar a Google.
  let pedido: DoctorDeClinica | null = null;
  let doctorEnRespuesta: Consulta['doctor'];

  if (entrada.doctorPedido && entrada.doctorPedido.trim()) {
    const r = doctorPorNombre(entrada.doctores, entrada.doctorPedido);
    if (r.tipo === 'varios') {
      return {
        doctor: {
          nombre: entrada.doctorPedido.trim(),
          duda: 'varios',
          apellidos: preguntaDeApellido(r.doctores)
        }
      };
    }
    if (r.tipo === 'ninguno') {
      // NO SE SIGUE COMO SI NO HUBIERA PEDIDO NADIE. Ofrecerle huecos de otro sin decir que
      // al que nombró no lo tenemos es contestar a una pregunta distinta de la que hizo.
      doctorEnRespuesta = { nombre: entrada.doctorPedido.trim(), duda: 'desconocido' };
    } else {
      pedido = r.doctor;
      doctorEnRespuesta = { nombre: r.doctor.nombre };
    }
  }

  // EL DÍA CERRADO SE CONTESTA SIN CONSULTAR NADA. Google no sabe que la clínica cierra el
  // 25 de diciembre: los calendarios de los doctores estarían vacíos, que es lo mismo que
  // libres.
  if (entrada.cuando && estaCerrado(cierres, diaLocal(entrada.cuando, zona))) {
    const c = cierres.find(x => diaLocal(entrada.cuando!, zona) >= x.desde && diaLocal(entrada.cuando!, zona) <= x.hasta);
    return { ...(doctorEnRespuesta ? { doctor: doctorEnRespuesta } : {}), cerrado: c?.motivo || 'cerrado' };
  }

  // Los que pueden hacer ese servicio. Sin servicio, todos: el paciente que aún no ha dicho
  // qué necesita tiene derecho a saber si queda hueco.
  const candidatos = entrada.servicio
    ? doctoresPara(entrada.doctores, entrada.servicio)
    : entrada.doctores.map(d => ({ ...d, prioridad: 0 }));

  if (candidatos.length === 0) return { error: 'nadie_hace_ese_servicio' };

  const desde = entrada.cuando && entrada.cuando > ahora ? ahora : ahora;
  const hasta = new Date(desde.getTime() + DIAS_DE_BUSQUEDA * 24 * 60 * 60 * 1000);

  const agenda = await agendaDeDoctores({ doctores: candidatos, desde, hasta }, deps);
  if (esError(agenda)) {
    // UN FALLO NO ES «NO HAY HUECOS». Helios deriva a una persona; si dijera que no hay
    // disponibilidad, el paciente se lo cree y se va a otra clínica.
    return { ...(doctorEnRespuesta ? { doctor: doctorEnRespuesta } : {}), error: (agenda as ErrorDeAgenda).error };
  }

  const buscar = (doctores: DoctorConAgenda[], desdeCuando: Date, hastaCuando: Date, maximo: number) =>
    huecosDisponibles({
      doctores, zona, desde: desdeCuando, hasta: hastaCuando,
      duracionMin: duracion, margenMin: margen,
      antelacionMin: entrada.antelacionMin, maximo, ahora
    }).filter(h => !estaCerrado(cierres, diaLocal(h.inicio, zona)));

  const suyo = pedido ? agenda.filter(a => a.id === pedido!.calendario) : [];
  const otros = pedido ? agenda.filter(a => a.id !== pedido!.calendario) : agenda;

  // --- SIN HORA CONCRETA: los primeros huecos que haya --------------------
  if (!entrada.cuando) {
    const lista = buscar(pedido ? suyo : agenda, desde, hasta, MAX_ALTERNATIVAS + 2);
    return {
      ...(doctorEnRespuesta ? { doctor: doctorEnRespuesta } : {}),
      ...(pedido ? { otras: lista.map(h => legible(h, zona)) } : { huecos: lista.map(h => legible(h, zona)) })
    };
  }

  // --- CON HORA CONCRETA --------------------------------------------------
  //
  // LA FRANJA EXACTA QUE PIDIÓ, NI UN MINUTO MÁS. La ventana es de la hora pedida a esa
  // hora más la duración, y el buscador exige que la cita quepa entera dentro: la única
  // hora que puede devolver es la que se pidió. Un hueco que empiece cinco minutos después
  // no es «las dos», y aquí no hay forma de que salga.
  //
  // Hubo un `.filter(h => h.inicio === cuando)` detrás de esto «por si acaso». Era código
  // muerto -se demuestra: el bucle arranca en `desde` y exige `t + duración <= desde +
  // duración`- y una prueba que lo quitaba seguía en verde. Se quitó: una comprobación que
  // no puede fallar no protege nada y hace creer que sí.
  //
  // EFECTO SECUNDARIO QUE CONVIENE SABER: si el paciente pide una hora que no cae en la
  // rejilla -las 14:30 cuando se cita en punto- esto devuelve «no puede», no «no citamos a
  // esa hora». Las dos llevan a ofrecerle las horas que sí hay, así que la conversación
  // acaba igual; pero el motivo que se le da no es el de verdad.
  const fin = new Date(entrada.cuando.getTime() + duracion * 60_000);
  const enEsaHora = (quienes: DoctorConAgenda[]) =>
    buscar(quienes, entrada.cuando!, fin, quienes.length);

  const cuandoTexto = formatear(entrada.cuando, zona);

  // SI NOMBRÓ A ALGUIEN QUE NO ESTÁ, se le dice y se le ofrece lo que hay a esa hora. La
  // pregunta que hizo tiene respuesta -«ese doctor no trabaja aquí»- y merece contestarse.
  if (!pedido) {
    const libres = enEsaHora(agenda);
    return {
      ...(doctorEnRespuesta ? { doctor: doctorEnRespuesta } : {}),
      pedido: { cuando: cuandoTexto, libre: libres.length > 0 },
      ...(libres.length > 0 ? { mismaHora: libres.map(h => h.doctor_nombre) } : {}),
      ...(libres.length === 0
        ? { huecos: buscar(agenda, desde, hasta, MAX_ALTERNATIVAS).map(h => legible(h, zona)) }
        : {})
    };
  }

  const puede = enEsaHora(suyo).length > 0;
  if (puede) {
    // Puede. No hace falta nada más: ni alternativas ni otros doctores. Ofrecer opciones a
    // quien ya tiene lo que pidió es hacerle dudar de una respuesta buena.
    return { doctor: doctorEnRespuesta, pedido: { cuando: cuandoTexto, libre: true } };
  }

  // NO PUEDE. Las dos piezas de la frase de David, juntas y en una sola llamada.
  return {
    doctor: doctorEnRespuesta,
    pedido: { cuando: cuandoTexto, libre: false },
    mismaHora: enEsaHora(otros).map(h => h.doctor_nombre),
    otras: buscar(suyo, desde, hasta, MAX_ALTERNATIVAS).map(h => legible(h, zona))
  };
}

export const LIMITES_DE_CONSULTA = { dias: DIAS_DE_BUSQUEDA, alternativas: MAX_ALTERNATIVAS };

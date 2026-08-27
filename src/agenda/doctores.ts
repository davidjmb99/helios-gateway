/**
 * Los doctores de la clínica, tal como los escribe quien da de alta la cuenta.
 *
 * LA RESTRICCIÓN QUE MANDA AQUÍ LA PUSO DAVID: «que sea lo más sencillo y no meterme con
 * tanto código ni prompt». Dar de alta una clínica tiene que ser rellenar campos, no editar
 * un JSON ni pedirle nada a nadie. Así que esto se escribe como se habla:
 *
 *     Dra. Ana Martínez
 *       calendario: d1747cd3...@group.calendar.google.com
 *       hace: valoración, higiene, blanqueamiento, empaste
 *
 *     Dra. Sofía Lemur
 *       calendario: 149e6370...@group.calendar.google.com
 *       horario: L, J, V, S
 *       hace: odontopediatría
 *
 * TRES ATAJOS QUE QUITAN LA MAYOR PARTE DEL TRABAJO, porque en una clínica de verdad casi
 * todo se repite:
 *
 *  1. SIN LÍNEA DE `horario`, trabaja el de la clínica. Lo normal es que todos lo hagan, y
 *     escribirlo cuatro veces es cuatro sitios donde equivocarse cuando cambie.
 *
 *  2. `horario: L, J, V, S` son los días de la clínica pero solo esos. Es el caso de la
 *     odontopediatra, que no viene todos los días pero cuando viene hace el horario normal.
 *     Para algo distinto de verdad: `horario: L-V 10:00-18:00, S 10:00-14:00`.
 *
 *  3. UN `*` DETRÁS DE UN SERVICIO significa «este es el preferente». Lo pidió David con la
 *     urgencia: «principalmente la ve Vélez, pero si está ocupado la puede tomar
 *     cualquiera». Sin eso habría que elegir entre perder la urgencia cuando el cirujano
 *     esté ocupado, o que acabe con quien no lo es teniéndolo libre.
 */

import type { HorarioClinica } from '../leads/policy.js';

/** Las estrellas del final de un servicio. Marcan el preferente y no son parte del nombre. */
const SIN_ESTRELLA = /\*+$/;

export interface DoctorDeClinica {
  nombre: string;
  /** El apellido, separado, para poder reconocerlo cuando el paciente diga solo eso. */
  apellido: string;
  /** El ID del calendario de Google. */
  calendario: string;
  /** Su horario ya resuelto: el de la clínica, el suyo, o el de la clínica en sus días. */
  horario: HorarioClinica;
  /** Los servicios que hace, en minúsculas y sin tildes: sirven para EMPAREJAR. */
  hace: string[];
  /**
   * Los mismos, TAL COMO LOS ESCRIBIÓ LA CLÍNICA. Sirven para MOSTRAR.
   *
   * Es la misma distinción que los sinónimos de los precios: `hace` existe para reconocer
   * lo que pide el paciente -«odontopediatria» tiene que emparejar con «odontopediatría»- y
   * esto existe para que cuando Helios nombre un servicio lo diga con sus tildes y como lo
   * llama la clínica, no en la forma aplanada que usamos por dentro.
   */
  haceTexto: string[];
  /** Los que hace de forma preferente -los marcados con `*`-. */
  preferente: string[];
}

const MAX_DOCTORES = 20;
const MAX_LARGO = 6000;

/**
 * Las letras de los días. `X` es miércoles, que es como se escribe aquí; `M` es martes.
 *
 * Se admiten también los nombres completos porque quien rellena esto no tiene por qué
 * saber que miércoles es X, y descubrirlo tras guardar mal el horario de un doctor es una
 * semana de citas en el día equivocado.
 */
const DIAS: Record<string, number> = {
  d: 0, do: 0, dom: 0, domingo: 0,
  l: 1, lu: 1, lun: 1, lunes: 1,
  m: 2, ma: 2, mar: 2, martes: 2,
  x: 3, mi: 3, mie: 3, miercoles: 3, 'miércoles': 3,
  j: 4, ju: 4, jue: 4, jueves: 4,
  v: 5, vi: 5, vie: 5, viernes: 5,
  s: 6, sa: 6, sab: 6, sabado: 6, 'sábado': 6
};

const sinTildes = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** «10:00» -> 600. Devuelve null si no es una hora. */
function minutosDe(hora: string): number | null {
  const m = String(hora).trim().match(/^(\d{1,2})[:.]?(\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 24 || min > 59) return null;
  const total = h * 60 + min;
  return total > 1440 ? null : total;
}

/** «L», «L-V», «lunes» -> los días que abarca. Null si no se entiende. */
function diasDe(texto: string): number[] | null {
  const limpio = sinTildes(texto).replace(/\s+/g, '');
  if (!limpio) return null;

  const rango = limpio.split('-');
  if (rango.length === 2) {
    const a = DIAS[rango[0]];
    const b = DIAS[rango[1]];
    if (a === undefined || b === undefined) return null;
    // Un rango que da la vuelta -«V-L»- se recorre igual: la semana es circular.
    const dias: number[] = [];
    for (let d = a; ; d = (d + 1) % 7) {
      dias.push(d);
      if (d === b) break;
      if (dias.length > 7) return null;
    }
    return dias;
  }

  const uno = DIAS[limpio];
  return uno === undefined ? null : [uno];
}

const horarioVacio = (): HorarioClinica => ({ 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] });

/**
 * Lee la línea de horario de un doctor.
 *
 * @param texto        lo que escribió: «L, J, V, S» o «L-V 10:00-18:00, S 10:00-14:00»
 * @param deLaClinica  el horario de la clínica, para los atajos
 */
export function horarioDeDoctor(texto: string, deLaClinica: HorarioClinica): HorarioClinica | null {
  const partes = String(texto ?? '').split(',').map(p => p.trim()).filter(Boolean);
  if (partes.length === 0) return null;

  const horario = horarioVacio();
  let algo = false;

  for (const parte of partes) {
    // «L-V 10:00-18:00» o solo «L».
    const m = parte.match(/^([^\s]+)(?:\s+(\d{1,2}[:.]?\d{0,2})\s*-\s*(\d{1,2}[:.]?\d{0,2}))?$/);
    if (!m) return null;

    const dias = diasDe(m[1]);
    if (!dias) return null;

    if (m[2] && m[3]) {
      const desde = minutosDe(m[2]);
      const hasta = minutosDe(m[3]);
      if (desde === null || hasta === null || desde >= hasta) return null;
      for (const d of dias) horario[d].push({ desde, hasta });
      algo = true;
      continue;
    }

    // SIN HORAS: se copia el de la clínica para ese día. Es el caso de la odontopediatra,
    // que no viene todos los días pero cuando viene hace el horario normal.
    for (const d of dias) {
      const tramos = deLaClinica?.[d] ?? [];
      // UN DÍA QUE LA CLÍNICA NO ABRE NO SE INVENTA. Si alguien escribe «D» y la clínica
      // cierra los domingos, ese día se queda vacío en vez de sacarse un horario de la
      // manga: el doctor no puede atender con la clínica cerrada.
      for (const t of tramos) horario[d].push({ desde: t.desde, hasta: t.hasta });
      if (tramos.length > 0) algo = true;
    }
  }

  return algo ? horario : null;
}

/**
 * Lee la lista entera de doctores.
 *
 * Devuelve null si algo no se entiende, y entonces NO SE GUARDA NADA. Es la misma regla que
 * con los precios: guardar la mitad sería que la clínica crea que puso cuatro doctores y
 * Helios sepa de dos, sin que nadie se entere hasta que un paciente pida cita con el que
 * falta.
 */
export function leerDoctores(texto: unknown, deLaClinica: HorarioClinica): DoctorDeClinica[] | null {
  const bruto = String(texto ?? '');
  if (!bruto.trim()) return null;
  if (bruto.length > MAX_LARGO) return null;

  const doctores: DoctorDeClinica[] = [];
  let actual: Partial<DoctorDeClinica> | null = null;

  const cerrar = (): boolean => {
    if (!actual) return true;
    // UN DOCTOR SIN CALENDARIO NO SIRVE: no se le puede consultar la agenda ni crear una
    // cita. Se rechaza en vez de guardarlo a medias y descubrirlo al primer paciente.
    if (!actual.nombre || !actual.calendario) return false;
    doctores.push({
      nombre: actual.nombre,
      apellido: actual.apellido ?? '',
      calendario: actual.calendario,
      horario: actual.horario ?? deLaClinica,
      hace: actual.hace ?? [],
      haceTexto: actual.haceTexto ?? [],
      preferente: actual.preferente ?? []
    });
    actual = null;
    return true;
  };

  for (const cruda of bruto.split('\n')) {
    const linea = cruda.trim();
    if (!linea) continue;

    const campo = linea.match(/^(calendario|horario|hace)\s*:\s*(.+)$/i);

    if (!campo) {
      // Una línea que no es un campo empieza un doctor nuevo.
      if (!cerrar()) return null;
      const nombre = linea.replace(/\s+/g, ' ');
      if (nombre.length > 80) return null;
      // El apellido es la última palabra, quitando el tratamiento. Sirve para reconocer al
      // paciente que dice solo «Vélez», que es lo normal.
      const palabras = nombre.replace(/^(dr|dra|doctor|doctora)\.?\s+/i, '').split(' ');
      actual = { nombre, apellido: palabras[palabras.length - 1] ?? '' };
      continue;
    }

    if (!actual) return null;   // un campo suelto, sin doctor delante
    const clave = sinTildes(campo[1]);
    const valor = campo[2].trim();

    if (clave === 'calendario') {
      if (!valor || valor.length > 200) return null;
      actual.calendario = valor;
      continue;
    }

    if (clave === 'horario') {
      const h = horarioDeDoctor(valor, deLaClinica);
      if (!h) return null;
      actual.horario = h;
      continue;
    }

    // `hace`. El `*` marca el preferente.
    const servicios = valor.split(',').map(s => s.trim()).filter(Boolean);
    if (servicios.length === 0) return null;
    actual.hace = [];
    actual.haceTexto = [];
    actual.preferente = [];
    for (const s of servicios) {
      const esPreferente = s.endsWith('*');
      const nombre = sinTildes(s.replace(/\*+$/, ''));
      if (!nombre) return null;
      actual.hace.push(nombre);
      actual.haceTexto.push(s.replace(SIN_ESTRELLA, '').trim());
      if (esPreferente) actual.preferente.push(nombre);
    }
  }

  if (!cerrar()) return null;
  if (doctores.length === 0 || doctores.length > MAX_DOCTORES) return null;

  // DOS DOCTORES NO PUEDEN COMPARTIR CALENDARIO. Si pasara, las citas de uno bloquearían al
  // otro y el reparto diría que hay dos sillas donde hay una. Es un error de copiar y pegar
  // un ID, y sin esta comprobación no se vería hasta que la agenda empezara a mentir.
  const calendarios = new Set(doctores.map(d => d.calendario));
  if (calendarios.size !== doctores.length) return null;

  return doctores;
}

/**
 * Qué doctores pueden hacer un servicio, con su preferencia.
 *
 * SI NADIE LO DECLARA, LO HACEN TODOS. Es deliberado: una clínica que aún no ha rellenado
 * los servicios de cada doctor sigue pudiendo dar citas, en vez de quedarse sin agenda
 * porque falte un dato. Y el caso normal -la valoración, que la hace cualquiera- no hay
 * que escribirlo en las cuatro fichas.
 */
export function doctoresPara(doctores: DoctorDeClinica[], servicio: string): Array<DoctorDeClinica & { prioridad: number }> {
  const buscado = sinTildes(servicio);
  const coincide = (lista: string[]) =>
    lista.some(s => s === buscado || buscado.includes(s) || s.includes(buscado));

  const prefieren = doctores.filter(d => coincide(d.preferente));
  const declaran = doctores.filter(d => coincide(d.hace) && !coincide(d.preferente));

  // SI NADIE LO DECLARA, LO HACEN TODOS. Una clínica que aún no ha rellenado los servicios
  // de cada doctor sigue pudiendo dar citas, en vez de quedarse sin agenda por un dato que
  // falta.
  if (prefieren.length === 0 && declaran.length === 0) {
    return doctores.map(d => ({ ...d, prioridad: 0 }));
  }

  // EL `*` ABRE EL SERVICIO A LOS DEMÁS, y esa es la diferencia entre las dos formas de
  // escribirlo. Lo pidió David así:
  //
  //     urgencia*   «principalmente la ve Vélez, pero si está ocupado la puede tomar
  //                  cualquier doctor»  ->  él primero, los demás detrás
  //
  //     brackets    solo los hace el ortodoncista  ->  nadie más, aunque esté libre
  //
  // Tiene sentido leído: «preferente» solo significa algo si hay alternativa. Y así lo
  // normal -que un servicio lo haga quien lo hace- se escribe sin ninguna marca, que es lo
  // que hay que optimizar cuando alguien está dando de alta una clínica.
  const resto = prefieren.length > 0
    ? doctores.filter(d => !prefieren.includes(d) && !declaran.includes(d))
    : [];

  return [
    ...prefieren.map(d => ({ ...d, prioridad: 0 })),
    ...declaran.map(d => ({ ...d, prioridad: 1 })),
    ...resto.map(d => ({ ...d, prioridad: 2 }))
  ];
}

export const LIMITES_DE_DOCTORES = { doctores: MAX_DOCTORES, caracteres: MAX_LARGO };

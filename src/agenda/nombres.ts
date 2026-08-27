/**
 * Qué doctor está nombrando el paciente.
 *
 * LO PIDIÓ DAVID ASÍ: «el agente debe entender cuando le nombren solo Ana por ejemplo, o
 * digan solo el apellido, debe asociarlo con el dr que tenga ese nombre o apellido, y si
 * hay mas doctores con el mismo nombre, debe preguntar por el apellido para verificar cual
 * se esté pidiendo».
 *
 * Y ESO ÚLTIMO ES LA MITAD DEL MÓDULO. Reconocer «Vélez» es fácil; lo que hay que hacer
 * bien es NO elegir cuando hay dos que valen. Con dos doctoras que se llamen Ana, adivinar
 * es mandar al paciente con la que no era, y eso no se descubre hasta que llega a la
 * clínica. Aquí se devuelve «hay varias» y quien hable pregunta el apellido.
 *
 * SE BUSCA POR PALABRAS ENTERAS, NUNCA POR TROZOS, y no es una preferencia de estilo:
 *
 *     «quiero cita para mañana»   ->  «mañana» CONTIENE «ana»
 *
 * Con búsqueda por subcadena, esa frase pide cita con la Dra. Ana. Y no es un caso
 * rebuscado: es la forma más normal de pedir hora en español.
 *
 * Y EL TRATAMIENTO NO IDENTIFICA A NADIE. «Dra.» está delante de casi todos, así que se
 * quita de los dos lados: si contara, «con la doctora, por favor» empataría a los cuatro y
 * se preguntaría el apellido de una persona que el paciente nunca nombró.
 */

import type { DoctorDeClinica } from './doctores.js';

const sinTildes = (t: string) =>
  String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Palabras que no identifican a nadie.
 *
 * Los tratamientos, y las dos palabras con las que se les nombra -«doctor», «doctora»-.
 * Van fuera tanto del texto del paciente como del nombre del doctor.
 */
const NO_IDENTIFICA = new Set([
  'dr', 'dra', 'doctor', 'doctora', 'doctores', 'doctoras',
  'don', 'dona', 'sr', 'sra', 'srta', 'de', 'del', 'la', 'el', 'los', 'las'
]);

/**
 * Dos letras no bastan para nombrar a nadie.
 *
 * Un apellido de dos letras existe, pero emparejar por dos letras hace que cualquier
 * partícula suelta del mensaje señale a un doctor. Ante la duda, no reconocer: el coste de
 * no reconocer es una pregunta más; el de reconocer mal es una cita con quien no era.
 */
const MINIMO = 3;

function palabras(texto: string): string[] {
  return sinTildes(texto)
    // Todo lo que no sea letra o número separa palabras. Así «Dra. Ana» son dos, y
    // «Martínez,» pierde la coma sin perder el apellido.
    .split(/[^a-z0-9ñ]+/)
    .filter(p => p.length >= MINIMO && !NO_IDENTIFICA.has(p));
}

export type Reconocimiento =
  /** Uno solo, sin duda. */
  | { tipo: 'uno'; doctor: DoctorDeClinica }
  /** Varios encajan igual de bien. Hay que preguntar el apellido. */
  | { tipo: 'varios'; doctores: DoctorDeClinica[] }
  /** El paciente no nombró a nadie, o nombró a quien no está. */
  | { tipo: 'ninguno' };

/**
 * A quién nombra el texto.
 *
 * GANA QUIEN COINCIDE EN MÁS PALABRAS, y eso es lo que resuelve solo el caso difícil: con
 * una Ana Martínez y una Ana López, «Ana» empata a una palabra -y se pregunta-, pero «Ana
 * Martínez» le da dos a una y una a la otra, así que no hay nada que preguntar.
 */
export function doctorPorNombre(doctores: DoctorDeClinica[], texto: unknown): Reconocimiento {
  const dichas = new Set(palabras(String(texto ?? '')));
  if (dichas.size === 0) return { tipo: 'ninguno' };

  let mejor = 0;
  const puntuados = (doctores ?? []).map(d => {
    // El apellido se cuenta aparte del nombre completo porque puede llevar tilde en uno y
    // no en otro según cómo lo escribiera la clínica; el Set quita el duplicado.
    const suyas = new Set([...palabras(d.nombre), ...palabras(d.apellido)]);
    let aciertos = 0;
    for (const p of suyas) if (dichas.has(p)) aciertos += 1;
    if (aciertos > mejor) mejor = aciertos;
    return { doctor: d, aciertos };
  });

  if (mejor === 0) return { tipo: 'ninguno' };

  const empatados = puntuados.filter(p => p.aciertos === mejor).map(p => p.doctor);
  return empatados.length === 1
    ? { tipo: 'uno', doctor: empatados[0] }
    : { tipo: 'varios', doctores: empatados };
}

/**
 * Cómo preguntar cuál de ellos, cuando hay empate.
 *
 * Se devuelve la frase hecha y no solo la lista porque el apellido es LO ÚNICO que hay que
 * preguntar: repetir el nombre de pila que el paciente ya ha dicho es hacerle sentir que no
 * se le ha entendido nada.
 */
export function preguntaDeApellido(doctores: DoctorDeClinica[]): string {
  const apellidos = doctores.map(d => d.apellido).filter(Boolean);
  if (apellidos.length < 2) return '';
  const ultimos = apellidos.slice(0, -1).join(', ');
  return `${ultimos} o ${apellidos[apellidos.length - 1]}`;
}

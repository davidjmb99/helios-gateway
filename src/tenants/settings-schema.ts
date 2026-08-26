import { leerDoctores } from '../agenda/doctores.js';
import { leerCierres } from '../agenda/cierres.js';
/**
 * Forma y validación de los ajustes de una clínica. PURO: sin base y sin red.
 *
 * Está aparte de settings.ts porque aquí vive lo que puede estar mal escrito, y eso
 * hay que poder probarlo sin levantar nada. Todo lo que llega de fuera —del panel o
 * del editor de Supabase a mano— pasa por aquí.
 *
 * REGLA COMÚN A TODO EL FICHERO: si un valor no es usable se devuelve null, y quien
 * llama cae al valor por defecto. NO se recorta ni se arregla en silencio. Caer al
 * valor de siempre es un comportamiento que se puede explicar; un 25:00 convertido
 * calladamente en 23:59 no lo es.
 *
 * LAS HORAS SE GUARDAN COMO "HH:MM" y no como minutos. Es a propósito: estas
 * columnas se miran y se editan a mano en Supabase, y `[[600,1200]]` no le dice
 * nada a nadie mientras `[["10:00","20:00"]]` se lee de un golpe.
 */

// --- Modo de una función que afecta a pacientes ------------------------------

/**
 * Tres estados, y el de en medio es el que importa.
 *
 *   off ....... no se evalúa nada. La función no existe para esta clínica.
 *   observe ... se decide y se anota, pero NO le llega nada a ningún paciente.
 *               Es como se valida una función con datos reales antes de encenderla.
 *   on ........ se decide, se anota y se actúa.
 *
 * Un booleano no puede expresar esto, y por eso la encuesta y el seguimiento
 * llevaban semanas «apagados» cuando en realidad estaban observando.
 */
export const MODOS_FUNCION = ['off', 'observe', 'on'] as const;
export type ModoFuncion = typeof MODOS_FUNCION[number];

export function normalizarModo(valor: unknown): ModoFuncion | null {
  const limpio = String(valor ?? '').trim().toLowerCase();
  return (MODOS_FUNCION as readonly string[]).includes(limpio) ? (limpio as ModoFuncion) : null;
}

// --- Horas del día -----------------------------------------------------------

const HORA_MINUTO = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "10:00" -> 600. null si no es una hora del día válida. */
export function minutosDeHora(valor: unknown): number | null {
  const m = HORA_MINUTO.exec(String(valor ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 600 -> "10:00". Para devolverle al panel lo mismo que se guardó. */
export function horaDeMinutos(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// --- Horario semanal ---------------------------------------------------------

/** Claves de los días. El índice coincide con Date.getDay(): 0 es domingo. */
export const DIAS_SEMANA = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DiaSemana = typeof DIAS_SEMANA[number];

/** Un tramo de atención, en minutos desde medianoche. */
export interface Tramo {
  desde: number;
  hasta: number;
}

/** Horario por día, indexado como Date.getDay(). Un día sin tramos está cerrado. */
export type HorarioSemanal = Record<number, Tramo[]>;

/** Lo que se guarda en la columna: horas legibles por día. */
export type HorarioGuardado = Partial<Record<DiaSemana, Array<[string, string]>>>;

export const HORARIO_POR_DEFECTO: HorarioSemanal = Object.freeze({
  0: [],
  1: [{ desde: 10 * 60, hasta: 20 * 60 }],
  2: [{ desde: 10 * 60, hasta: 20 * 60 }],
  3: [{ desde: 10 * 60, hasta: 20 * 60 }],
  4: [{ desde: 10 * 60, hasta: 20 * 60 }],
  5: [{ desde: 10 * 60, hasta: 20 * 60 }],
  6: [{ desde: 10 * 60, hasta: 15 * 60 }]
}) as HorarioSemanal;

/**
 * Valida un horario semanal completo.
 *
 * Se rechaza el horario ENTERO si un solo día está mal, en vez de ignorar ese día.
 * Un martes descartado en silencio significa «cerrado el martes», y eso cambia a
 * qué hora se le escribe a los pacientes sin que nadie lo haya decidido.
 *
 * Un tramo que acaba antes de empezar se rechaza. Los tramos que se solapan NO se
 * rechazan: son redundantes pero inofensivos, porque lo único que se pregunta es si
 * un minuto cae dentro de alguno.
 */
export function normalizarHorario(valor: unknown): HorarioSemanal | null {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return null;
  const entrada = valor as Record<string, unknown>;

  const salida: HorarioSemanal = {};
  let algunTramo = false;

  for (let dia = 0; dia < 7; dia++) {
    const clave = DIAS_SEMANA[dia];
    const bruto = entrada[clave] ?? entrada[String(dia)];
    if (bruto === undefined || bruto === null) {
      salida[dia] = [];
      continue;
    }
    if (!Array.isArray(bruto)) return null;

    const tramos: Tramo[] = [];
    for (const par of bruto) {
      if (!Array.isArray(par) || par.length !== 2) return null;
      const desde = minutosDeHora(par[0]);
      const hasta = minutosDeHora(par[1]);
      if (desde === null || hasta === null) return null;
      if (hasta <= desde) return null;
      tramos.push({ desde, hasta });
      algunTramo = true;
    }
    salida[dia] = tramos;
  }

  // Un horario con los siete días cerrados no es un horario: es un error de
  // llenado que dejaría a la clínica sin ninguna hora válida para nada.
  if (!algunTramo) return null;
  return salida;
}

/** Lo contrario, para devolverle al panel lo que hay guardado. */
export function horarioParaGuardar(horario: HorarioSemanal): HorarioGuardado {
  const salida: HorarioGuardado = {};
  for (let dia = 0; dia < 7; dia++) {
    salida[DIAS_SEMANA[dia]] = (horario[dia] ?? []).map(
      t => [horaDeMinutos(t.desde), horaDeMinutos(t.hasta)] as [string, string]
    );
  }
  return salida;
}

// --- Ventana de envío de seguimientos ---------------------------------------

/**
 * A qué horas es DECENTE escribirle a alguien. NO es el horario de la clínica.
 *
 * Son dos cosas distintas y confundirlas fue un error real que había en el código:
 * la ventana de envío tomaba la hora de cierre de la clínica, así que un
 * seguimiento no podía salir después de las 20:00 aunque el operador hubiera
 * aprobado hasta las 22:00.
 *
 *   El HORARIO DE LA CLÍNICA dice cuándo se puede DAR UNA CITA.
 *   La VENTANA DE ENVÍO dice cuándo se puede MANDAR UN MENSAJE.
 *
 * Se puede escribir a las 8:00 aunque la puerta abra a las 10:00 —es hora decente
 * y abre dos horas que resuelven justo los casos que se quedaban sin seguimiento— y
 * se puede escribir hasta las 22:00 aunque la clínica cerrara a las 20:00. Lo que
 * no se puede es escribir a las 3 de la madrugada.
 *
 * SOLO EN DÍAS QUE LA CLÍNICA TRABAJA. El domingo no se manda seguimiento, aunque
 * las 11:00 de un domingo caigan dentro de la ventana.
 */
export interface VentanaEnvio {
  desde: number;
  hasta: number;
}

export const VENTANA_ENVIO_POR_DEFECTO: VentanaEnvio = Object.freeze({
  desde: 8 * 60,
  hasta: 22 * 60
});

/**
 * Límites de lo aceptable. Existen porque el desplegable no es la única forma de
 * llegar aquí, y una ventana de 02:00 a 06:00 significa despertar a un paciente
 * para venderle una limpieza dental.
 */
const ENVIO_MAS_TEMPRANO = 7 * 60;
const ENVIO_MAS_TARDE = 23 * 60;

export function normalizarVentanaEnvio(valor: unknown): VentanaEnvio | null {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return null;
  const entrada = valor as Record<string, unknown>;
  const desde = minutosDeHora(entrada.desde);
  const hasta = minutosDeHora(entrada.hasta);
  if (desde === null || hasta === null) return null;
  if (hasta - desde < 60) return null;               // menos de una hora no es ventana
  if (desde < ENVIO_MAS_TEMPRANO || hasta > ENVIO_MAS_TARDE) return null;
  return { desde, hasta };
}

export const LIMITES_VENTANA_ENVIO = Object.freeze({
  mas_temprano: horaDeMinutos(ENVIO_MAS_TEMPRANO),
  mas_tarde: horaDeMinutos(ENVIO_MAS_TARDE)
});

// --- Equipos de Chatwoot -----------------------------------------------------

export const DESTINOS_EQUIPO = ['reception', 'clinical_lead', 'helios_support'] as const;
export type DestinoEquipo = typeof DESTINOS_EQUIPO[number];

export type EquiposClinica = Partial<Record<DestinoEquipo, string>>;

/**
 * Los IDs de equipo de Chatwoot.
 *
 * Solo dígitos: Chatwoot los usa como enteros, y un valor con letras no da un error
 * claro, da una asignación que no ocurre. Un destino sin ID no es un error: el
 * enrutado tiene respaldo a recepción y lo deja anotado.
 *
 * Se valida cada destino por separado, al contrario que el horario, porque aquí sí
 * es normal tener solo algunos configurados.
 */
export function normalizarEquipos(valor: unknown): EquiposClinica | null {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return null;
  const entrada = valor as Record<string, unknown>;
  const salida: EquiposClinica = {};
  for (const destino of DESTINOS_EQUIPO) {
    const bruto = entrada[destino];
    if (bruto === undefined || bruto === null || bruto === '') continue;
    const id = String(bruto).trim();
    if (!/^\d+$/.test(id)) return null;
    salida[destino] = id;
  }
  return Object.keys(salida).length > 0 ? salida : null;
}

// --- Zona horaria ------------------------------------------------------------

/**
 * Se valida preguntándole a Intl, no con una lista.
 *
 * Una lista propia se queda vieja, y el efecto de una zona inválida es que TODOS
 * los cálculos de hora se van al servidor: se le escribiría a la gente a horas que
 * nadie eligió. Intl es la misma pieza que hace el cálculo, así que si Intl la
 * acepta, el cálculo funcionará.
 */
export function normalizarZona(valor: unknown): string | null {
  const limpio = String(valor ?? '').trim();
  if (!limpio) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: limpio }).format(new Date());
    return limpio;
  } catch {
    return null;
  }
}

// --- Tono --------------------------------------------------------------------

const MAX_TONO = 400;

/**
 * Cómo habla Helios, en palabras del operador.
 *
 * ES TEXTO LIBRE, y hay que ser honesto sobre su alcance: el Gateway lo guarda y lo
 * manda a Hermes en el contexto, pero lo que Helios DICE lo decide su SOUL. Este
 * campo solo sirve si el SOUL está escrito para leerlo. Guardarlo aquí es lo que
 * hace posible que cada clínica tenga el suyo sin editar el perfil a mano.
 *
 * Se limita el largo porque viaja en CADA turno: un texto de dos mil caracteres
 * son tokens pagados en todos los mensajes de todos los pacientes.
 */
export function normalizarTono(valor: unknown): string | null {
  const limpio = String(valor ?? '').trim().replace(/\s+/g, ' ');
  if (!limpio) return null;
  if (limpio.length > MAX_TONO) return null;
  return limpio;
}

export const MAX_LARGO_TONO = MAX_TONO;

// --- Direccion de la clinica -------------------------------------------------

const MAX_DIRECCION = 200;

/**
 * Donde esta la clinica, para responder «¿donde quedan?».
 *
 * POR QUE ES UN AJUSTE Y NO UNA LINEA DEL PROMPT. Se escribio primero en el perfil
 * de Hermes -«La clinica esta en Acarigua, CC Mamanico, local 27»- y el modelo se
 * NEGO a decirla. Textualmente: «no quiero darte una direccion de memoria por si no
 * es exacta». Y tenia su lógica: el SOUL entero le repite que no afirme nada sin
 * confirmar, asi que un dato suelto en las instrucciones lo trata como recuerdo
 * dudoso. En el mismo minuto contesto el HORARIO sin dudar, porque el horario llega
 * en `clinic_context` dentro de la peticion: eso lo trata como dato.
 *
 * Asi que la direccion viaja por donde viaja el horario. No es un truco: es la
 * distincion correcta. Lo que la clinica ha configurado es un hecho de esa clinica;
 * lo que esta escrito en un prompt compartido, no necesariamente.
 *
 * Y RESUELVE ALGO QUE EL PROMPT ROMPIA. Escribir «Acarigua» en el SOUL habria
 * mentido a la segunda clinica en cuanto exista, porque el perfil es uno para
 * todas hasta que se clone. Aqui cada cuenta manda la suya y no se mezclan.
 *
 * Es texto libre a proposito: «Acarigua, CC Mamanico local 27, tiene
 * estacionamiento» es una direccion util, y partirla en calle/numero/ciudad
 * obligaria a la clinica a rellenar campos que no siempre aplican.
 *
 * Se limita el largo porque viaja en CADA turno, igual que el tono.
 */
/**
 * Si la primera visita es gratis: si, no, o «no lo ha dicho nadie».
 *
 * DEVUELVE `false` ANTE CUALQUIER COSA RARA, y no es indiferente. Los dos fallos posibles
 * no cuestan lo mismo:
 *
 *   prometer gratis y luego cobrar   -> una discusion con el paciente en el mostrador,
 *                                       con Helios de testigo por escrito
 *   no prometer algo que si es gratis -> una oportunidad perdida que el equipo corrige
 *                                       hablando, en la misma llamada
 *
 * Asi que el defecto no puede estar en medio: cae del lado del que se arregla hablando.
 */
export function normalizarPrimeraVisita(valor: unknown): boolean {
  if (valor === true || valor === 'true' || valor === 1 || valor === '1') return true;
  return false;
}

export function normalizarDireccion(valor: unknown): string | null {
  const limpio = String(valor ?? '').trim().replace(/\s+/g, ' ');
  if (!limpio) return null;
  if (limpio.length > MAX_DIRECCION) return null;
  return limpio;
}

export const MAX_LARGO_DIRECCION = MAX_DIRECCION;

// --- SERVICIOS Y PRECIOS ---------------------------------------------------
//
// LOS PRECIOS VIAJAN COMO DATO, NO COMO DOCUMENTO. Es la lección de la dirección
// (HEL-085): Hermes se NEGÓ a decir una dirección que estaba en su prompt -«no quiero
// darte una dirección de memoria por si no es exacta»- y contestó el horario sin dudar,
// porque el horario llegaba en la petición. Con un precio ese recelo es todavía más sano:
// un número mal recordado es una discusión con un paciente en el mostrador.
//
// Y POR ESO NO VAN POR RAG aunque la clínica tenga el PDF. Lo que llega en la petición es
// un hecho; lo que hay que ir a buscar a un documento es un recuerdo, y el SOUL le enseña
// a desconfiar de sus recuerdos -y bien, que es lo que evita que invente citas-.
//
// CADA SERVICIO LLEVA SUS OTROS NOMBRES, y esa es la mitad que de verdad importa. Lo
// señaló David: «el agente debe saber los otros términos a cada uno de esos servicios».
// Un paciente en Venezuela no pide una «exodoncia simple»: dice que le van a SACAR LA
// MUELA. Sin los sinónimos el precio está en el sistema y el paciente no lo alcanza, que
// es igual de inútil que no tenerlo.

const MAX_SERVICIOS = 40;
const MAX_LARGO_SERVICIOS = 4000;
const MAX_SINONIMOS = 12;

export interface ServicioDeClinica {
  nombre: string;
  precio: string;
  /** Cómo lo llama la gente. Para RECONOCER lo que pide el paciente, no para hablar así. */
  tambien: string[];
}

/**
 * Lee la lista de servicios tal como la escribe la clínica en Ajustes.
 *
 * UNA LÍNEA POR SERVICIO, en el formato:
 *
 *     Nombre del servicio: precio (otro nombre, otro nombre)
 *
 * TEXTO LIBRE Y NO UN FORMULARIO POR CAMPOS, por lo mismo que la dirección: «Acarigua, CC
 * Mamánico local 27, tiene estacionamiento» es una dirección útil, y partirla en
 * calle/número/ciudad la habría empeorado. Aquí igual: «150$ hasta 250$ por unidad» y
 * «entrada 100$ + 40$ al mes» son precios reales que ningún campo numérico admite.
 *
 * EL PRECIO NO SE VALIDA COMO NÚMERO A PROPÓSITO. Un rango, un «desde», un «por diente» o
 * un «consultar» son respuestas legítimas de una clínica, y forzar un número obligaría a
 * mentir o a dejarlo vacío.
 *
 * Devuelve null si no hay nada aprovechable, y entonces no se guarda: sin servicios
 * configurados Helios no inventa precios, deriva.
 */
export function normalizarServicios(valor: unknown): string | null {
  const bruto = String(valor ?? '');
  if (!bruto.trim()) return null;
  if (bruto.length > MAX_LARGO_SERVICIOS) return null;

  const lineas = bruto.split('\n').map(l => l.trim()).filter(Boolean);
  if (lineas.length === 0 || lineas.length > MAX_SERVICIOS) return null;

  // Se exige que TODAS las líneas se puedan leer. Guardar una lista con la mitad
  // entendida sería peor que rechazarla: la clínica creería que puso doce precios y
  // Helios solo sabría seis, sin que nadie se entere hasta que un paciente pregunte.
  for (const linea of lineas) {
    if (!leerLineaDeServicio(linea)) return null;
  }

  return lineas.join('\n');
}

/** Una línea suelta. Devuelve null si no se entiende. */
export function leerLineaDeServicio(linea: string): ServicioDeClinica | null {
  // El paréntesis del final es el de los otros nombres, y se toma el ÚLTIMO: el precio
  // puede llevar paréntesis dentro -«40$ a 80$ (por sesión)»- y partir por el primero
  // convertiría parte del precio en un sinónimo.
  const m = String(linea ?? '').trim().match(/^([^:]+):\s*(.+?)(?:\s*\(([^()]*)\))?\s*$/);
  if (!m) return null;

  const nombre = m[1].trim().replace(/\s+/g, ' ');
  const precio = m[2].trim().replace(/\s+/g, ' ');
  if (!nombre || !precio || nombre.length > 80 || precio.length > 80) return null;

  const tambien = (m[3] ?? '')
    .split(',')
    .map(s => s.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_SINONIMOS);

  return { nombre, precio, tambien };
}

/** La lista ya leída, para mandarla en clinic_context. */
export function serviciosDeTexto(texto: string | null): ServicioDeClinica[] {
  if (!texto) return [];
  return texto
    .split('\n')
    .map(l => leerLineaDeServicio(l))
    .filter((s): s is ServicioDeClinica => s !== null);
}

export const LIMITES_DE_SERVICIOS = {
  servicios: MAX_SERVICIOS,
  caracteres: MAX_LARGO_SERVICIOS,
  sinonimos: MAX_SINONIMOS
};

// --- DOCTORES Y CIERRES ----------------------------------------------------
//
// Los dos guardan TEXTO tal como lo escribe quien da de alta la clinica, y se validan
// enteros: si una linea no se entiende, no se guarda ninguna. Ver src/agenda/doctores.ts y
// src/agenda/cierres.ts para el porque de cada formato.
//
// EL HORARIO DE LA CLINICA HACE FALTA PARA VALIDAR LOS DOCTORES, porque «horario: L, J, V»
// significa «esos dias, con el horario de la clinica». Aqui no se tiene a mano, asi que se
// valida contra una semana completa: lo que se comprueba al guardar es que el TEXTO se
// entienda, y el horario de verdad se resuelve al leerlo, ya con el de la clinica delante.

const SEMANA_COMPLETA = {
  0: [{ desde: 0, hasta: 1440 }], 1: [{ desde: 0, hasta: 1440 }], 2: [{ desde: 0, hasta: 1440 }],
  3: [{ desde: 0, hasta: 1440 }], 4: [{ desde: 0, hasta: 1440 }], 5: [{ desde: 0, hasta: 1440 }],
  6: [{ desde: 0, hasta: 1440 }]
} as any;

export function normalizarDoctores(valor: unknown): string | null {
  const texto = String(valor ?? '');
  if (!texto.trim()) return null;
  return leerDoctores(texto, SEMANA_COMPLETA) ? texto.trim() : null;
}

export function normalizarCierres(valor: unknown): string | null {
  const texto = String(valor ?? '');
  if (!texto.trim()) return null;
  return leerCierres(texto) ? texto.trim() : null;
}

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
export function normalizarDireccion(valor: unknown): string | null {
  const limpio = String(valor ?? '').trim().replace(/\s+/g, ' ');
  if (!limpio) return null;
  if (limpio.length > MAX_DIRECCION) return null;
  return limpio;
}

export const MAX_LARGO_DIRECCION = MAX_DIRECCION;

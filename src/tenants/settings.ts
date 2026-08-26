/**
 * Ajustes que cada clínica cambia desde su panel, sin redeploy.
 *
 * Hoy hay dos, y los dos estaban en variables de entorno, o sea iguales para todas
 * las clínicas y solo cambiables desplegando:
 *
 *   buffer_ms ............ cuánto espera Helios antes de contestar
 *   handoff_stale_hours .. tras cuántas horas sin actividad vuelve a la IA una
 *                          conversación que está en manos de una persona
 *
 * SE LEEN TODAS LAS CLÍNICAS DE UNA VEZ, no una consulta por clínica. Son pocas
 * filas y diminutas, y así el barrido de handoff -que necesita el umbral de cada
 * clínica y además el más permisivo de todos para su consulta- lo tiene gratis, y
 * la caché es coherente: o están todas frescas o ninguna.
 *
 * TRES CUIDADOS, porque esto se lee en el camino de CADA MENSAJE:
 *
 *  1. NUNCA LANZA. Si la base no contesta, se usan los valores de las variables de
 *     entorno. Un ajuste caído no puede dejar a un paciente sin respuesta.
 *
 *  2. SE CACHEA UN MINUTO. También se cachea el fallo, a propósito: si la base está
 *     caída, no se la castiga con una consulta por mensaje.
 *
 *  3. AL GUARDAR SE INVALIDA LA CACHÉ. Si no, se cambiaría el ajuste y no se
 *     notaría durante un minuto, que parece exactamente lo mismo que estar roto.
 *
 * La clínica llega ya autenticada, igual que en el borrado de datos: quien llama la
 * saca del token de sesión, nunca del cuerpo de la petición.
 */

import { config } from '../config.js';
import { supabase } from '../supabase/client.js';
import { normalizarIntentos, MINIMO_INTENTOS, MAXIMO_INTENTOS, INTENTOS_RECOVERY } from '../services/recovery-policy.js';
import {
  HORAS_VUELTA,
  MINIMO_HORAS_VUELTA,
  MAXIMO_HORAS_VUELTA,
  normalizarHorasVuelta
} from '../handoff/stale-policy.js';
import {
  HORARIO_POR_DEFECTO,
  VENTANA_ENVIO_POR_DEFECTO,
  LIMITES_VENTANA_ENVIO,
  MODOS_FUNCION,
  MAX_LARGO_TONO,
  MAX_LARGO_DIRECCION,
  horaDeMinutos,
  horarioParaGuardar,
  normalizarEquipos,
  normalizarHorario,
  normalizarModo,
  normalizarTono,
  normalizarDireccion,
  normalizarPrimeraVisita,
  normalizarServicios,
  normalizarDoctores,
  normalizarCierres,
  serviciosDeTexto,
  LIMITES_DE_SERVICIOS,
  type ServicioDeClinica,
  normalizarVentanaEnvio,
  normalizarZona,
  type EquiposClinica,
  type HorarioSemanal,
  type ModoFuncion,
  type VentanaEnvio
} from './settings-schema.js';

/** Lo que ofrece el desplegable del panel, en milisegundos. */
export const VALORES_BUFFER = [5000, 8000, 10000, 15000] as const;

/**
 * Límites del buffer, independientes del desplegable. Por debajo de tres segundos
 * deja de agrupar ráfagas -y una ráfaga partida son dos turnos, o sea coste doble
 * y a veces dos respuestas-; por encima de treinta la espera se nota tanto que
 * parece que Helios no contesta.
 */
const MINIMO_BUFFER_MS = 3000;
const MAXIMO_BUFFER_MS = 30000;

const VIDA_CACHE_MS = 60_000;

type Origen = 'clinica' | 'defecto';

export interface AjustesClinica {
  buffer_ms: number;
  handoff_stale_hours: number;
  /** Cuándo se puede DAR CITA. */
  clinic_hours: HorarioSemanal;
  /** Cuándo se puede MANDAR un seguimiento. Distinto de lo anterior. */
  followup_window: VentanaEnvio;
  csat_mode: ModoFuncion;
  leads_mode: ModoFuncion;
  chatwoot_teams: EquiposClinica;
  recovery_intentos: number;
  clinic_timezone: string;
  clinic_tone: string | null;
  /** Donde esta la clinica. Viaja en clinic_context, no en el prompt. */
  clinic_address: string | null;
  first_visit_free: boolean;
  clinic_services: string | null;
  clinic_doctors: string | null;
  clinic_closures: string | null;
  /** Qué campos los eligió la clínica y cuáles vienen de lo de siempre. */
  origen: Record<string, Origen>;
}

/** Los campos que se pueden guardar, con su validador. Uno por columna. */
const CAMPOS = {
  buffer_ms: { normalizar: (v: unknown) => normalizarBufferMs(v), error: 'BUFFER_FUERA_DE_RANGO' },
  handoff_stale_hours: { normalizar: normalizarHorasVuelta, error: 'HORAS_VUELTA_FUERA_DE_RANGO' },
  recovery_intentos: { normalizar: normalizarIntentos, error: 'INTENTOS_FUERA_DE_RANGO' },
  clinic_hours: { normalizar: normalizarHorario, error: 'HORARIO_INVALIDO', guardar: horarioParaGuardar },
  followup_window: {
    normalizar: normalizarVentanaEnvio,
    error: 'VENTANA_ENVIO_INVALIDA',
    guardar: (v: VentanaEnvio) => ({ desde: horaDeMinutos(v.desde), hasta: horaDeMinutos(v.hasta) })
  },
  csat_mode: { normalizar: normalizarModo, error: 'MODO_INVALIDO' },
  leads_mode: { normalizar: normalizarModo, error: 'MODO_INVALIDO' },
  chatwoot_teams: { normalizar: normalizarEquipos, error: 'EQUIPOS_INVALIDOS' },
  clinic_timezone: { normalizar: normalizarZona, error: 'ZONA_INVALIDA' },
  clinic_tone: { normalizar: normalizarTono, error: 'TONO_INVALIDO' },
  clinic_address: { normalizar: normalizarDireccion, error: 'DIRECCION_INVALIDA' },
  first_visit_free: { normalizar: normalizarPrimeraVisita, error: 'PRIMERA_VISITA_INVALIDA' },
  clinic_services: { normalizar: normalizarServicios, error: 'SERVICIOS_INVALIDOS' },
  clinic_doctors: { normalizar: normalizarDoctores, error: 'DOCTORES_INVALIDOS' },
  clinic_closures: { normalizar: normalizarCierres, error: 'CIERRES_INVALIDOS' }
} as const;

type CampoAjuste = keyof typeof CAMPOS;

let cache: { expira: number; porClinica: Map<string, AjustesClinica> } | null = null;

export const settingsMetrics = {
  lecturas_a_base: 0,
  lecturas_desde_cache: 0,
  escrituras: 0,
  fallos_de_lectura: 0,
  ultimo_error: null as string | null
};

export function normalizarBufferMs(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  const entero = Math.round(numero);
  if (entero < MINIMO_BUFFER_MS || entero > MAXIMO_BUFFER_MS) return null;
  return entero;
}

/**
 * Los valores de siempre: lo que se usaba antes de que esto fuera configurable.
 *
 * Los modos se DERIVAN de las variables de entorno viejas para que aplicar la
 * migración no cambie el comportamiento de nadie. Un flag en false nunca significó
 * «apagado del todo»: significaba «decide y anota sin tocar a ningún paciente», o
 * sea observación. Traducirlo a 'off' habría apagado en silencio la recogida de
 * datos que lleva días acumulándose.
 */
function porDefecto(): AjustesClinica {
  return {
    buffer_ms: config.BUFFER_MS,
    handoff_stale_hours: Math.max(MINIMO_HORAS_VUELTA, config.HELIOS_HANDOFF_STALE_HOURS),
    // Los 5 de siempre, los que estaban escritos a mano en el worker.
    recovery_intentos: 5,
    clinic_hours: HORARIO_POR_DEFECTO,
    followup_window: VENTANA_ENVIO_POR_DEFECTO,
    csat_mode: config.HELIOS_CSAT_ENABLED ? 'on' : 'observe',
    leads_mode: config.HELIOS_LEADS_ENABLED ? 'on' : 'observe',
    chatwoot_teams: {},
    clinic_timezone: config.CLINIC_TIMEZONE,
    clinic_tone: null,
    // SIN DIRECCION POR DEFECTO. Inventar una es peor que no tenerla: el paciente se
    // presentaria en un sitio equivocado. Si no esta configurada, Helios deriva.
    clinic_address: null,
    // POR DEFECTO NO ES GRATIS. Estuvo cableado a `true` para todas las cuentas y Helios
    // lo prometia sin que nadie lo hubiera confirmado. Prometer algo gratis que luego se
    // cobra es una discusion en el mostrador; lo contrario se arregla hablando.
    first_visit_free: false,
    // SIN PRECIOS POR DEFECTO. Un precio inventado acaba en una discusion en el mostrador
    // con Helios de testigo por escrito. Sin servicios, Helios no dice ninguno y deriva.
    clinic_services: null,
    // SIN DOCTORES NI CIERRES POR DEFECTO. Sin doctores no hay agenda propia y se sigue
    // usando Cal.com; inventarse uno seria ofrecer citas con alguien que no existe.
    clinic_doctors: null,
    clinic_closures: null,
    origen: {}
  };
}

async function cargarTodas(): Promise<Map<string, AjustesClinica>> {
  const ahora = Date.now();
  if (cache && cache.expira > ahora) {
    settingsMetrics.lecturas_desde_cache += 1;
    return cache.porClinica;
  }

  const porClinica = new Map<string, AjustesClinica>();

  try {
    settingsMetrics.lecturas_a_base += 1;
    const resultado = await supabase
      .from('helios_tenants')
      .select('tenant_id, ' + Object.keys(CAMPOS).join(', '));
    if (resultado.error) {
      throw Object.assign(new Error('SETTINGS_READ_FAILED'), { cause: resultado.error });
    }

    for (const fila of resultado.data || []) {
      const tenantId = String((fila as any).tenant_id ?? '').trim();
      if (!tenantId) continue;
      const ajustes = porDefecto();
      ajustes.origen = {};

      // Un bucle y no un if por campo: con nueve columnas, el if por campo es donde
      // se olvida uno y nadie se entera hasta que un ajuste no hace nada.
      for (const campo of Object.keys(CAMPOS) as CampoAjuste[]) {
        const bruto = (fila as any)[campo];
        const valido = CAMPOS[campo].normalizar(bruto);
        if (valido !== null) {
          (ajustes as any)[campo] = valido;
          ajustes.origen[campo] = 'clinica';
        } else {
          ajustes.origen[campo] = 'defecto';
          if (bruto !== null && bruto !== undefined && bruto !== '') {
            // Hay algo escrito y no sirve. Se avisa, porque si no el panel mostraría
            // un valor y el sistema usaría otro sin que nadie se enterara.
            console.warn(JSON.stringify({
              event: 'ajuste_invalido_en_base',
              campo,
              tenant_id: tenantId,
              valor: bruto
            }));
          }
        }
      }

      porClinica.set(tenantId, ajustes);
    }
  } catch (error: any) {
    settingsMetrics.fallos_de_lectura += 1;
    settingsMetrics.ultimo_error = error?.message || 'SETTINGS_READ_FAILED';
    console.warn(JSON.stringify({
      event: 'settings_read_failed',
      error_code: settingsMetrics.ultimo_error,
      se_usan: 'los valores del entorno'
    }));
    // Se cachea el mapa vacío igualmente: con la base caída, todas las clínicas
    // funcionan con los valores del entorno y no se la consulta por mensaje.
  }

  cache = { expira: ahora + VIDA_CACHE_MS, porClinica };
  return porClinica;
}

async function ajustesDe(tenantId: string): Promise<AjustesClinica> {
  const porClinica = await cargarTodas();
  return porClinica.get(tenantId) ?? porDefecto();
}

/** La espera de esta clínica. Esto es lo que llama el buffer. */
export async function obtenerBufferMs(tenantId: string): Promise<number> {
  return (await ajustesDe(tenantId)).buffer_ms;
}

/** Las horas de inactividad de esta clínica. Esto es lo que llama el barrido. */
export async function obtenerHorasVuelta(tenantId: string): Promise<number> {
  return (await ajustesDe(tenantId)).handoff_stale_hours;
}

/**
 * El umbral MÁS PERMISIVO de todas las clínicas, o sea el más pequeño.
 *
 * Lo necesita el barrido para su consulta: si preguntara por conversaciones más
 * viejas que el umbral por defecto, se dejaría fuera a las clínicas que hayan
 * elegido menos horas y a esas nunca les volvería nada. Se pide con el mínimo y
 * después cada fila se filtra con el umbral de SU clínica.
 */
export async function umbralMinimoDeVuelta(): Promise<number> {
  const porClinica = await cargarTodas();
  let minimo = porDefecto().handoff_stale_hours;
  for (const ajustes of porClinica.values()) {
    if (ajustes.handoff_stale_hours < minimo) minimo = ajustes.handoff_stale_hours;
  }
  return Math.max(MINIMO_HORAS_VUELTA, minimo);
}

/** Cuántos reintentos hace el recovery antes de llamar a una persona, en esta clínica. */
export async function obtenerIntentosRecovery(tenantId: string): Promise<number> {
  return (await ajustesDe(tenantId)).recovery_intentos;
}

/**
 * El límite MÁS ALTO de todas las clínicas.
 *
 * Al revés que el umbral de vuelta: aquí el barrido tiene que ver TODO lo que
 * cualquier clínica podría seguir reintentando, así que pide con el máximo y luego
 * cada fila se compara con el límite de SU clínica. Pedir con el mínimo dejaría
 * fuera lotes que una clínica generosa todavía quiere reintentar.
 */
export async function maximoIntentosDeRecovery(): Promise<number> {
  const porClinica = await cargarTodas();
  let maximo = porDefecto().recovery_intentos;
  for (const ajustes of porClinica.values()) {
    if (ajustes.recovery_intentos > maximo) maximo = ajustes.recovery_intentos;
  }
  return Math.min(MAXIMO_INTENTOS, maximo);
}

/** El modo de la encuesta en esta clínica. */
export async function obtenerModoCsat(tenantId: string): Promise<ModoFuncion> {
  return (await ajustesDe(tenantId)).csat_mode;
}

/** El modo del seguimiento comercial en esta clínica. */
export async function obtenerModoLeads(tenantId: string): Promise<ModoFuncion> {
  return (await ajustesDe(tenantId)).leads_mode;
}

/** El horario y la ventana de envío, para el seguimiento. */
export async function obtenerHorarioYVentana(tenantId: string): Promise<{
  horario: HorarioSemanal;
  envio: VentanaEnvio;
  zona: string;
}> {
  const ajustes = await ajustesDe(tenantId);
  return {
    horario: ajustes.clinic_hours,
    envio: ajustes.followup_window,
    zona: ajustes.clinic_timezone
  };
}

/**
 * Los equipos de Chatwoot de esta clínica, con los del enrutado como respaldo.
 *
 * SE MEZCLA POR DESTINO, no todo o nada: si la clínica solo ha puesto recepción en
 * el panel, los otros dos siguen saliendo del JSON de entorno. Reemplazar el mapa
 * entero dejaría sin equipo a los destinos que no se hubieran tocado, y un destino
 * sin equipo significa una derivación que no se asigna a nadie.
 */
export async function obtenerEquipos(
  tenantId: string,
  respaldo: EquiposClinica
): Promise<EquiposClinica> {
  const ajustes = await ajustesDe(tenantId);
  return { ...respaldo, ...ajustes.chatwoot_teams };
}

/** El tono, para mandárselo a Hermes en el contexto. */
export async function obtenerTono(tenantId: string): Promise<string | null> {
  return (await ajustesDe(tenantId)).clinic_tone;
}

/**
 * El contexto de clínica que viaja a Hermes en cada turno.
 *
 * El horario va en horas legibles y NO en minutos: lo va a leer un modelo de
 * lenguaje, y «10:00» se entiende sin explicación mientras 600 no.
 */
export async function leerContextoDeClinica(tenantId: string): Promise<{
  horario: Record<string, Array<[string, string]>> | null;
  tono: string | null;
  zona: string;
  direccion: string | null;
  primeraVisitaGratis: boolean;
  servicios: ServicioDeClinica[];
}> {
  const ajustes = await ajustesDe(tenantId);
  return {
    // La direccion SI se manda tal cual esté: no hay valor por defecto que pudiera
    // colarse como si fuera real, porque el defecto es null.
    direccion: ajustes.clinic_address,
    primeraVisitaGratis: ajustes.first_visit_free,
    servicios: serviciosDeTexto(ajustes.clinic_services),
    // Solo se manda si la clínica lo configuró: mandar el horario por defecto haría
    // creer a Hermes que es el de verdad cuando nadie lo ha confirmado.
    horario: ajustes.origen.clinic_hours === 'clinica'
      ? horarioParaGuardar(ajustes.clinic_hours) as Record<string, Array<[string, string]>>
      : null,
    tono: ajustes.clinic_tone,
    zona: ajustes.clinic_timezone
  };
}

/** Lo que necesita el panel para pintarse. */
export async function leerAjustes(tenantId: string): Promise<Record<string, unknown>> {
  const ajustes = await ajustesDe(tenantId);
  const defectos = porDefecto();
  return {
    buffer_ms: ajustes.buffer_ms,
    buffer_opciones: [...VALORES_BUFFER],
    buffer_por_defecto: defectos.buffer_ms,

    handoff_stale_hours: ajustes.handoff_stale_hours,
    handoff_stale_opciones: [...HORAS_VUELTA],
    handoff_stale_por_defecto: defectos.handoff_stale_hours,

    recovery_intentos: ajustes.recovery_intentos,
    recovery_opciones: [...INTENTOS_RECOVERY],
    recovery_por_defecto: defectos.recovery_intentos,

    clinic_hours: horarioParaGuardar(ajustes.clinic_hours),
    clinic_hours_por_defecto: horarioParaGuardar(defectos.clinic_hours),

    followup_window: {
      desde: horaDeMinutos(ajustes.followup_window.desde),
      hasta: horaDeMinutos(ajustes.followup_window.hasta)
    },
    followup_window_limites: LIMITES_VENTANA_ENVIO,

    csat_mode: ajustes.csat_mode,
    leads_mode: ajustes.leads_mode,
    modos: [...MODOS_FUNCION],

    chatwoot_teams: ajustes.chatwoot_teams,
    clinic_timezone: ajustes.clinic_timezone,
    clinic_tone: ajustes.clinic_tone,
    clinic_tone_max: MAX_LARGO_TONO,
    clinic_address: ajustes.clinic_address,
    first_visit_free: ajustes.first_visit_free,
    clinic_services: ajustes.clinic_services,
    clinic_services_limites: LIMITES_DE_SERVICIOS,
    clinic_doctors: ajustes.clinic_doctors,
    clinic_closures: ajustes.clinic_closures,
    clinic_address_max: MAX_LARGO_DIRECCION,

    // De dónde sale cada valor. El panel lo necesita para no decir «elegido por la
    // clínica» cuando en realidad es el de siempre.
    origen: ajustes.origen,
    limites: {
      buffer_ms: [MINIMO_BUFFER_MS, MAXIMO_BUFFER_MS],
      handoff_stale_hours: [MINIMO_HORAS_VUELTA, MAXIMO_HORAS_VUELTA],
      recovery_intentos: [MINIMO_INTENTOS, MAXIMO_INTENTOS]
    }
  };
}

export interface ResultadoGuardado {
  ok: boolean;
  error?: string;
  /** Qué campo lo rechazó. Con nueve campos y códigos compartidos, hace falta. */
  campo?: string;
  cambios?: Record<string, unknown>;
}

/**
 * Guarda los ajustes que vengan, validando cada uno.
 *
 * Un solo endpoint para todos los campos, y NO se guarda nada si alguno es
 * inválido: media petición aplicada es peor que ninguna, porque la pantalla
 * mostraría un estado que no es el que hay.
 */
export async function guardarAjustes(
  tenantId: string,
  entrada: Record<string, unknown>
): Promise<ResultadoGuardado> {
  const cambios: Record<string, unknown> = {};

  for (const campo of Object.keys(CAMPOS) as CampoAjuste[]) {
    if (!(campo in entrada)) continue;
    const definicion = CAMPOS[campo] as any;
    const valido = definicion.normalizar(entrada[campo]);
    if (valido === null) return { ok: false, error: definicion.error, campo };
    // Algunos campos se guardan en otra forma de la que se usan: el horario vive en
    // minutos en memoria y como "HH:MM" en la columna, para poder leerlo a mano.
    cambios[campo] = definicion.guardar ? definicion.guardar(valido) : valido;
  }

  if (Object.keys(cambios).length === 0) return { ok: false, error: 'SIN_CAMBIOS' };

  const resultado = await supabase
    .from('helios_tenants')
    .update(cambios)
    .eq('tenant_id', tenantId);
  if (resultado.error) return { ok: false, error: 'AJUSTES_WRITE_FAILED' };

  cache = null;
  settingsMetrics.escrituras += 1;
  console.log(JSON.stringify({ event: 'ajustes_actualizados', tenant_id: tenantId, cambios }));
  return { ok: true, cambios };
}

/** Solo para las pruebas: vacía la caché entre escenarios. */
export function __limpiarCacheAjustes(): void {
  cache = null;
}

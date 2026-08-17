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
import {
  HORAS_VUELTA,
  MINIMO_HORAS_VUELTA,
  MAXIMO_HORAS_VUELTA,
  normalizarHorasVuelta
} from '../handoff/stale-policy.js';

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

export interface AjustesClinica {
  buffer_ms: number;
  buffer_origen: 'clinica' | 'defecto';
  handoff_stale_hours: number;
  handoff_stale_origen: 'clinica' | 'defecto';
}

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

function porDefecto(): AjustesClinica {
  return {
    buffer_ms: config.BUFFER_MS,
    buffer_origen: 'defecto',
    handoff_stale_hours: Math.max(MINIMO_HORAS_VUELTA, config.HELIOS_HANDOFF_STALE_HOURS),
    handoff_stale_origen: 'defecto'
  };
}

function avisarValorInvalido(campo: string, tenantId: string, valor: unknown, seUsa: number): void {
  console.warn(JSON.stringify({
    event: 'ajuste_invalido_en_base',
    campo,
    tenant_id: tenantId,
    valor,
    se_usa: seUsa
  }));
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
      .select('tenant_id, buffer_ms, handoff_stale_hours');
    if (resultado.error) {
      throw Object.assign(new Error('SETTINGS_READ_FAILED'), { cause: resultado.error });
    }

    for (const fila of resultado.data || []) {
      const tenantId = String(fila.tenant_id ?? '').trim();
      if (!tenantId) continue;
      const ajustes = porDefecto();

      const buffer = normalizarBufferMs(fila.buffer_ms);
      if (buffer !== null) {
        ajustes.buffer_ms = buffer;
        ajustes.buffer_origen = 'clinica';
      } else if (fila.buffer_ms !== null && fila.buffer_ms !== undefined) {
        avisarValorInvalido('buffer_ms', tenantId, fila.buffer_ms, ajustes.buffer_ms);
      }

      const horas = normalizarHorasVuelta(fila.handoff_stale_hours);
      if (horas !== null) {
        ajustes.handoff_stale_hours = horas;
        ajustes.handoff_stale_origen = 'clinica';
      } else if (fila.handoff_stale_hours !== null && fila.handoff_stale_hours !== undefined) {
        avisarValorInvalido('handoff_stale_hours', tenantId, fila.handoff_stale_hours, ajustes.handoff_stale_hours);
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

/** Lo que necesita el panel para pintarse. */
export async function leerAjustes(tenantId: string): Promise<{
  buffer_ms: number;
  buffer_origen: 'clinica' | 'defecto';
  buffer_opciones: number[];
  buffer_por_defecto: number;
  handoff_stale_hours: number;
  handoff_stale_origen: 'clinica' | 'defecto';
  handoff_stale_opciones: number[];
  handoff_stale_por_defecto: number;
  limites: { buffer_ms: number[]; handoff_stale_hours: number[] };
}> {
  const ajustes = await ajustesDe(tenantId);
  const defectos = porDefecto();
  return {
    buffer_ms: ajustes.buffer_ms,
    buffer_origen: ajustes.buffer_origen,
    buffer_opciones: [...VALORES_BUFFER],
    buffer_por_defecto: defectos.buffer_ms,
    handoff_stale_hours: ajustes.handoff_stale_hours,
    handoff_stale_origen: ajustes.handoff_stale_origen,
    handoff_stale_opciones: [...HORAS_VUELTA],
    handoff_stale_por_defecto: defectos.handoff_stale_hours,
    limites: {
      buffer_ms: [MINIMO_BUFFER_MS, MAXIMO_BUFFER_MS],
      handoff_stale_hours: [MINIMO_HORAS_VUELTA, MAXIMO_HORAS_VUELTA]
    }
  };
}

export interface ResultadoGuardado {
  ok: boolean;
  error?: string;
  cambios?: Record<string, number>;
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
  const cambios: Record<string, number> = {};

  if ('buffer_ms' in entrada) {
    const ms = normalizarBufferMs(entrada.buffer_ms);
    if (ms === null) return { ok: false, error: 'BUFFER_FUERA_DE_RANGO' };
    cambios.buffer_ms = ms;
  }

  if ('handoff_stale_hours' in entrada) {
    const horas = normalizarHorasVuelta(entrada.handoff_stale_hours);
    if (horas === null) return { ok: false, error: 'HORAS_VUELTA_FUERA_DE_RANGO' };
    cambios.handoff_stale_hours = horas;
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

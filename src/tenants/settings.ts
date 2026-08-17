/**
 * Ajustes que cada clínica puede cambiar desde su panel.
 *
 * Hoy solo hay uno: el TIEMPO DE ESPERA del buffer. Estaba en una variable de
 * entorno, o sea igual para todas las clínicas y solo cambiable con un redeploy.
 * Aquí pasa a vivir en `helios_tenants.buffer_ms`, una columna por clínica.
 *
 * TRES CUIDADOS, porque esto se lee en el camino de CADA MENSAJE:
 *
 *  1. NUNCA LANZA. Si la base de datos no contesta, se usa el valor de siempre
 *     (la variable de entorno). Un fallo leyendo un ajuste no puede dejar a un
 *     paciente sin respuesta: es un ajuste, no una función crítica.
 *
 *  2. SE CACHEA UN MINUTO, para no consultar la base en cada mensaje. También se
 *     cachea el valor por defecto cuando la lectura falla, y eso es a propósito:
 *     si la base está caída, no se la castiga con una consulta por mensaje.
 *
 *  3. AL GUARDAR SE INVALIDA LA CACHÉ. Si no, se cambiaría el ajuste y no se
 *     notaría durante un minuto, que parece exactamente lo mismo que estar roto.
 *
 * La clínica llega ya autenticada, igual que en el borrado de datos: quien llama
 * la saca del token de sesión, nunca del cuerpo de la petición.
 */

import { config } from '../config.js';
import { supabase } from '../supabase/client.js';

/** Lo que ofrece el desplegable del panel, en milisegundos. */
export const VALORES_BUFFER = [5000, 8000, 10000, 15000] as const;

/**
 * Límites de lo aceptable, independientes del desplegable.
 *
 * Existen porque el desplegable no es la única forma de llegar aquí. Por debajo
 * de tres segundos el buffer deja de agrupar ráfagas —y una ráfaga partida son
 * dos turnos, o sea coste doble y a veces dos respuestas—; por encima de treinta
 * la espera se nota tanto que parece que Helios no contesta.
 */
const MINIMO_MS = 3000;
const MAXIMO_MS = 30000;

const VIDA_CACHE_MS = 60_000;

interface Ajuste {
  buffer_ms: number;
  origen: 'clinica' | 'defecto';
  expira: number;
}

const cache = new Map<string, Ajuste>();

export const settingsMetrics = {
  lecturas_a_base: 0,
  lecturas_desde_cache: 0,
  escrituras: 0,
  fallos_de_lectura: 0,
  ultimo_error: null as string | null
};

/**
 * Convierte lo que llegue en un valor usable, o en null si no lo es.
 *
 * Devolver null y no recortar al límite es deliberado: un 999999 en la columna es
 * un error, y caer al valor de siempre es un comportamiento que se puede
 * explicar. Recortarlo en silencio a treinta segundos, no.
 */
export function normalizarBufferMs(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  const entero = Math.round(numero);
  if (entero < MINIMO_MS || entero > MAXIMO_MS) return null;
  return entero;
}

async function resolver(tenantId: string): Promise<Ajuste> {
  const ahora = Date.now();
  const enCache = cache.get(tenantId);
  if (enCache && enCache.expira > ahora) {
    settingsMetrics.lecturas_desde_cache += 1;
    return enCache;
  }

  let ajuste: Ajuste = {
    buffer_ms: config.BUFFER_MS,
    origen: 'defecto',
    expira: ahora + VIDA_CACHE_MS
  };

  try {
    settingsMetrics.lecturas_a_base += 1;
    const resultado = await supabase
      .from('helios_tenants')
      .select('buffer_ms')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (resultado.error) {
      throw Object.assign(new Error('SETTINGS_READ_FAILED'), { cause: resultado.error });
    }

    const guardado = normalizarBufferMs(resultado.data?.buffer_ms);
    if (guardado !== null) {
      ajuste = { buffer_ms: guardado, origen: 'clinica', expira: ahora + VIDA_CACHE_MS };
    } else if (resultado.data?.buffer_ms !== null && resultado.data?.buffer_ms !== undefined) {
      // Hay algo escrito y no sirve. Se avisa, porque si no el panel mostraría un
      // valor y el sistema usaría otro sin que nadie se enterara.
      console.warn(JSON.stringify({
        event: 'buffer_ms_invalido_en_base',
        tenant_id: tenantId,
        valor: resultado.data.buffer_ms,
        se_usa: config.BUFFER_MS
      }));
    }
  } catch (error: any) {
    settingsMetrics.fallos_de_lectura += 1;
    settingsMetrics.ultimo_error = error?.message || 'SETTINGS_READ_FAILED';
    console.warn(JSON.stringify({
      event: 'settings_read_failed',
      tenant_id: tenantId,
      error_code: settingsMetrics.ultimo_error,
      se_usa: config.BUFFER_MS
    }));
  }

  cache.set(tenantId, ajuste);
  return ajuste;
}

/** El tiempo de espera de esta clínica. Esto es lo que llama el buffer. */
export async function obtenerBufferMs(tenantId: string): Promise<number> {
  return (await resolver(tenantId)).buffer_ms;
}

/** Lo que necesita el panel para pintarse. */
export async function leerAjustes(tenantId: string): Promise<{
  buffer_ms: number;
  origen: 'clinica' | 'defecto';
  opciones: number[];
  por_defecto: number;
  minimo_ms: number;
  maximo_ms: number;
}> {
  const ajuste = await resolver(tenantId);
  return {
    buffer_ms: ajuste.buffer_ms,
    origen: ajuste.origen,
    opciones: [...VALORES_BUFFER],
    por_defecto: config.BUFFER_MS,
    minimo_ms: MINIMO_MS,
    maximo_ms: MAXIMO_MS
  };
}

export async function guardarBufferMs(
  tenantId: string,
  valor: unknown
): Promise<{ ok: boolean; error?: string; buffer_ms?: number }> {
  const ms = normalizarBufferMs(valor);
  if (ms === null) return { ok: false, error: 'BUFFER_FUERA_DE_RANGO' };

  const resultado = await supabase
    .from('helios_tenants')
    .update({ buffer_ms: ms })
    .eq('tenant_id', tenantId);
  if (resultado.error) return { ok: false, error: 'BUFFER_WRITE_FAILED' };

  cache.delete(tenantId);
  settingsMetrics.escrituras += 1;
  console.log(JSON.stringify({ event: 'buffer_ms_actualizado', tenant_id: tenantId, buffer_ms: ms }));
  return { ok: true, buffer_ms: ms };
}

/** Solo para las pruebas: vacía la caché entre escenarios. */
export function __limpiarCacheAjustes(): void {
  cache.clear();
}

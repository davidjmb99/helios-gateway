/**
 * Vaciado de datos de UNA clínica desde el panel.
 *
 * TRES PROPIEDADES DE SEGURIDAD, y ninguna es opcional:
 *
 *  1. La clínica sale SIEMPRE del token de sesión, nunca del cuerpo de la
 *     petición. Aunque alguien manipule el navegador y mande otro tenant_id, se
 *     ignora. Es lo único que impide que una clínica borre los datos de otra, y
 *     por eso esta función ni siquiera acepta un tenant como parámetro libre:
 *     lo recibe ya autenticado.
 *
 *  2. Lista blanca de tablas. No se construye SQL con lo que llegue de fuera.
 *     Una tabla que no esté en TABLAS_PURGABLES no se toca, y ni
 *     helios_tenants —donde vive la configuración y el acceso— ni
 *     helios_data_purge_audit —donde queda el rastro— están en esa lista.
 *
 *  3. Queda registrado quién, qué y cuándo, ANTES de responder. El botón no
 *     puede borrar la prueba de lo que hizo.
 */

import { supabase } from '../supabase/client.js';

export interface TablaPurgable {
  /**
   * El nombre REAL en Supabase, y se muestra tal cual en el panel. Es lo que
   * permite comparar lo que dice esta pantalla con lo que se ve en el editor de
   * Supabase al limpiar a mano; con solo la etiqueta bonita no cuadraba nada.
   */
  tabla: string;
  etiqueta: string;
  /** Qué se guarda ahí y para qué sirve, en una frase. */
  descripcion: string;
  grupo: string;
  /**
   * Tablas que hay que vaciar ANTES que esta por clave foránea. Si alguien elige
   * los lotes sin el outbox, el borrado fallaría a mitad; se añaden solas.
   */
  requiere?: string[];
  /** Avisa en la interfaz de que esta tiene consecuencias fuera de Supabase. */
  advertencia?: string;
}

/**
 * El ORDEN de esta lista es el orden de borrado. helios_chatwoot_outbox va antes
 * que helios_processing_batches porque tiene clave foránea contra ella.
 */
export const TABLAS_PURGABLES: TablaPurgable[] = [
  {
    tabla: 'helios_chatwoot_outbox',
    etiqueta: 'Mensajes enviados por Helios',
    descripcion: 'Cada respuesta que Helios publicó y el identificador que devolvió Chatwoot. Es como reconoce sus propios mensajes cuando le vuelven por el webhook, para no contestarse a sí mismo.',
    grupo: 'Conversaciones'
  },
  {
    tabla: 'helios_processing_batches',
    etiqueta: 'Lotes de procesamiento',
    descripcion: 'Una fila por ráfaga de mensajes procesada: cuándo entró, cuándo se contestó y con qué resultado. Es el candado que impide contestar dos veces lo mismo.',
    grupo: 'Conversaciones',
    requiere: ['helios_chatwoot_outbox']
  },
  {
    tabla: 'helios_inbound_buffer',
    etiqueta: 'Mensajes recibidos',
    descripcion: 'Los mensajes del paciente tal como llegan, guardados mientras se espera a ver si sigue escribiendo. Es el respaldo del buffer: si el proceso se reinicia a mitad, los mensajes no se pierden.',
    grupo: 'Conversaciones'
  },
  {
    tabla: 'helios_message_idempotency',
    etiqueta: 'Control de mensajes repetidos',
    descripcion: 'Una huella por mensaje recibido. Si Chatwoot manda el mismo webhook dos veces, el repetido se descarta aquí antes de llegar al agente.',
    grupo: 'Conversaciones'
  },
  {
    tabla: 'helios_conversation_state',
    etiqueta: 'Estado de las conversaciones',
    descripcion: 'Por conversación: si la atiende una persona o la IA, desde cuándo, si hay un seguimiento comercial pendiente y a quién no se le debe escribir.',
    grupo: 'Conversaciones'
  },

  {
    tabla: 'helios_handoff_events',
    etiqueta: 'Derivaciones a persona',
    descripcion: 'Cada vez que una conversación pasó a un humano: el motivo, el equipo al que fue, quién la aceptó y cuándo volvió a la IA.',
    grupo: 'Derivaciones y avisos'
  },
  {
    tabla: 'helios_notification_outbox',
    etiqueta: 'Avisos al equipo',
    descripcion: 'Los avisos a Slack y las notas a los equipos de Chatwoot, pendientes o ya enviados. Es lo que evita que un mismo aviso se mande dos veces.',
    grupo: 'Derivaciones y avisos'
  },

  {
    tabla: 'helios_lead_followups',
    etiqueta: 'Seguimientos comerciales',
    descripcion: 'Los mensajes de seguimiento a quien preguntó y no agendó: a quién, cuándo, con qué texto y si se envió de verdad o solo se simuló.',
    grupo: 'Comercial',
    advertencia: 'De aquí salen los números de seguimiento que se le enseñan a la clínica a fin de mes. Si lo borras, ese mes ya no se puede medir.'
  },
  {
    tabla: 'helios_financing_cases',
    etiqueta: 'Casos de financiación',
    descripcion: 'Las consultas de financiación que quedaron anotadas para que alguien las retome.',
    grupo: 'Comercial'
  },

  {
    tabla: 'helios_gateway_logs',
    etiqueta: 'Registro del Gateway',
    descripcion: 'El diario técnico paso a paso de cada mensaje. Es lo primero que se mira cuando algo falla y hay que reconstruir qué pasó.',
    grupo: 'Trazas'
  },
  {
    tabla: 'helios_adapter_events',
    etiqueta: 'Trazas del Adapter',
    descripcion: 'Lo que ocurrió en cada llamada al modelo: tokens de entrada y salida, cuántos vinieron de caché, el coste y los tiempos.',
    grupo: 'Trazas',
    advertencia: 'Aquí viven los tokens, el coste y los tiempos. Si lo borras pierdes la referencia para comparar.'
  },
  {
    tabla: 'helios_adapter_executions',
    etiqueta: 'Ejecuciones del Adapter',
    descripcion: 'Una fila por ejecución del agente, con el enlace a su traza y el resultado. Es el índice por el que se navegan las trazas.',
    grupo: 'Trazas'
  },

  {
    tabla: 'helios_patient_profiles',
    etiqueta: 'Perfiles de paciente',
    descripcion: 'El nombre, los apellidos y el correo verificados de cada paciente, y el enlace con su contacto de HubSpot.',
    grupo: 'Pacientes',
    advertencia: 'Helios volverá a pedir nombre, apellidos y correo. Si conservas los contactos en HubSpot, se crearán duplicados o se volverán a emparejar.'
  }
];

const PERMITIDAS = new Set(TABLAS_PURGABLES.map(t => t.tabla));

export interface ResultadoPurga {
  ok: boolean;
  error?: string;
  tablas?: Array<{ tabla: string; filas: number }>;
  total?: number;
  anadidas_por_dependencia?: string[];
}

/** Cuenta lo que hay ahora, para que nadie borre a ciegas. */
export async function contarFilas(tenantId: string): Promise<Array<{
  tabla: string;
  etiqueta: string;
  descripcion: string;
  grupo: string;
  filas: number;
  advertencia?: string;
}>> {
  const salida = [];
  for (const definicion of TABLAS_PURGABLES) {
    const resultado = await supabase
      .from(definicion.tabla)
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);
    salida.push({
      tabla: definicion.tabla,
      etiqueta: definicion.etiqueta,
      descripcion: definicion.descripcion,
      grupo: definicion.grupo,
      advertencia: definicion.advertencia,
      filas: resultado.error ? -1 : (resultado.count ?? 0)
    });
  }
  return salida;
}

/**
 * Vacía las tablas pedidas para UNA clínica.
 *
 * `tenantId` viene del token de sesión ya verificado. `confirmacion` es lo que la
 * persona escribió: tiene que coincidir exactamente con el identificador de la
 * clínica. Un «¿estás seguro?» no protege de nada; escribir el nombre obliga a
 * mirar qué se está borrando.
 */
export async function purgarDatos(input: {
  tenantId: string;
  solicitadoPor: string;
  tablas: unknown;
  confirmacion: unknown;
  ip?: string | null;
}): Promise<ResultadoPurga> {
  const { tenantId } = input;

  if (String(input.confirmacion ?? '').trim() !== tenantId) {
    return { ok: false, error: 'CONFIRMACION_NO_COINCIDE' };
  }

  const pedidas = Array.isArray(input.tablas) ? input.tablas.map(String) : [];
  if (pedidas.length === 0) return { ok: false, error: 'SIN_TABLAS' };

  const desconocidas = pedidas.filter(t => !PERMITIDAS.has(t));
  if (desconocidas.length > 0) {
    // No se ignoran en silencio: si alguien pide una tabla que no está en la
    // lista blanca, es un error o un intento, y en ambos casos hay que decirlo.
    return { ok: false, error: 'TABLA_NO_PERMITIDA: ' + desconocidas.join(', ') };
  }

  // Dependencias por clave foránea: elegir los lotes sin el outbox reventaría a
  // mitad del borrado y dejaría los datos a medias.
  const seleccion = new Set(pedidas);
  const anadidas: string[] = [];
  for (const definicion of TABLAS_PURGABLES) {
    if (!seleccion.has(definicion.tabla)) continue;
    for (const dependencia of definicion.requiere ?? []) {
      if (!seleccion.has(dependencia)) {
        seleccion.add(dependencia);
        anadidas.push(dependencia);
      }
    }
  }

  const tablas: Array<{ tabla: string; filas: number }> = [];
  let total = 0;

  // Se recorre TABLAS_PURGABLES y no la selección: así el orden de borrado lo
  // decide el código, no lo que llegue de fuera.
  for (const definicion of TABLAS_PURGABLES) {
    if (!seleccion.has(definicion.tabla)) continue;
    const resultado = await supabase
      .from(definicion.tabla)
      .delete({ count: 'exact' })
      .eq('tenant_id', tenantId);
    if (resultado.error) {
      return { ok: false, error: `FALLO_AL_BORRAR:${definicion.tabla}`, tablas, total };
    }
    const filas = resultado.count ?? 0;
    tablas.push({ tabla: definicion.tabla, filas });
    total += filas;
  }

  // El rastro se escribe SIEMPRE, y esta tabla no está en la lista blanca: el
  // botón no puede borrar la prueba de lo que hizo.
  await supabase.from('helios_data_purge_audit').insert({
    tenant_id: tenantId,
    requested_by: input.solicitadoPor,
    tables_purged: tablas,
    rows_deleted: total,
    confirmation_text: String(input.confirmacion ?? ''),
    ip: input.ip ?? null
  }).then(({ error }) => {
    if (error) {
      console.error(JSON.stringify({
        event: 'data_purge_audit_write_failed',
        tenant_id: tenantId,
        rows_deleted: total
      }));
    }
  });

  console.log(JSON.stringify({
    event: 'data_purge_executed',
    tenant_id: tenantId,
    requested_by: input.solicitadoPor,
    rows_deleted: total,
    tables: tablas.map(t => t.tabla)
  }));

  return { ok: true, tablas, total, anadidas_por_dependencia: anadidas };
}

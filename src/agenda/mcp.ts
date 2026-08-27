/**
 * La agenda, servida como un MCP que Hermes llama igual que llama a Cal.com.
 *
 * MISMOS NOMBRES DE HERRAMIENTA QUE CAL.COM, y es deliberado: así el cambio en el perfil de
 * Hermes es un buscar-y-reemplazar de `mcp_calcom_` por `mcp_agenda_` y nada más. El SOUL
 * está a diecinueve mil novecientos ochenta y tres caracteres de veinte mil; reescribir sus
 * instrucciones de agenda costaría sitio que no hay.
 *
 * CUATRO HERRAMIENTAS Y NO NUEVE. El MCP oficial de Google trae nueve y su `suggest_time`
 * devuelve los huecos en que están libres TODOS los asistentes a la vez -está hecho para
 * cuadrar una reunión-, que es justo lo contrario de lo que necesita una clínica: que
 * CUALQUIERA de los cuatro esté libre. Además no tiene dónde poner que Lemur solo viene
 * lunes, jueves, viernes y sábado, ni que el sábado se cierra a las tres, ni el 25 de
 * diciembre. Esas reglas viven aquí.
 *
 * TODO LO QUE DECIDE ESTÁ EN OTRO SITIO. Este archivo traduce JSON-RPC a llamadas y
 * viceversa; quién puede a qué hora lo decide `consulta.ts`, sin red y con sus pruebas.
 *
 * Y DE QUÉ CLÍNICA ES CADA LLAMADA LO DICE EL TOKEN. Aquí no hay ningún parámetro
 * `tenant_id`, ni lo va a haber: ver `credencial.ts`.
 */

import { consultarAgenda, type Consulta } from './consulta.js';
import { doctorPorNombre } from './nombres.js';
import { leerMomento } from './reloj.js';
import { leerCierres, estaCerrado } from './cierres.js';
import {
  crearCita, moverCita, cancelarCita, idDeEvento, esError, type Dependencias
} from './google.js';
import type { DoctorDeClinica } from './doctores.js';
import type { HorarioClinica } from '../leads/policy.js';

/** Las versiones del protocolo que se saben hablar. Se devuelve la que pida el cliente. */
const PROTOCOLOS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PROTOCOLO_POR_DEFECTO = '2025-06-18';

/**
 * Las descripciones van cortas A PROPÓSITO.
 *
 * El esquema de cada herramienta viaja en CADA llamada al modelo, no una vez por
 * conversación. Hermes avisa en su propio código de que con muchas herramientas los
 * esquemas pueden sumar veinte o treinta mil tokens. Una frase de más aquí se paga en cada
 * mensaje de cada paciente de cada clínica.
 */
const HERRAMIENTAS = [
  {
    name: 'get_available_slots',
    description:
      'Consulta disponibilidad. Devuelve si el doctor pedido puede a esa hora, quien mas '
      + 'puede a esa misma hora, y otras horas del doctor pedido. NO reserva.',
    inputSchema: {
      type: 'object',
      properties: {
        doctor: { type: 'string', description: 'Como lo nombro el paciente: "Ana", "el dr Velez". Opcional.' },
        cuando: { type: 'string', description: 'Hora pedida, "2026-09-07T14:00" en hora de la clinica. Opcional.' },
        servicio: { type: 'string', description: 'Lo que necesita: "limpieza", "endodoncia". Opcional.' }
      }
    }
  },
  {
    name: 'create_booking',
    description: 'Crea la cita. Solo despues de que el paciente confirme la hora Y el doctor.',
    inputSchema: {
      type: 'object',
      required: ['doctor', 'cuando', 'paciente'],
      properties: {
        doctor: { type: 'string', description: 'El doctor con el que el paciente acepto.' },
        cuando: { type: 'string', description: 'Inicio, "2026-09-07T14:00" en hora de la clinica.' },
        paciente: { type: 'string', description: 'Nombre del paciente.' },
        servicio: { type: 'string' },
        telefono: { type: 'string' },
        notas: { type: 'string' }
      }
    }
  },
  {
    name: 'reschedule_booking',
    description: 'Mueve una cita ya creada a otra hora, y si hace falta a otro doctor.',
    inputSchema: {
      type: 'object',
      required: ['cita_id', 'calendario', 'cuando'],
      properties: {
        cita_id: { type: 'string', description: 'El id que devolvio create_booking.' },
        calendario: { type: 'string', description: 'El calendario que devolvio create_booking.' },
        cuando: { type: 'string', description: 'La hora nueva, en hora de la clinica.' },
        doctor: { type: 'string', description: 'Solo si cambia de doctor.' }
      }
    }
  },
  {
    name: 'cancel_booking',
    description: 'Cancela una cita ya creada.',
    inputSchema: {
      type: 'object',
      required: ['cita_id', 'calendario'],
      properties: {
        cita_id: { type: 'string' },
        calendario: { type: 'string' }
      }
    }
  }
] as const;

export interface ContextoDeAgenda {
  tenantId: string;
  doctores: DoctorDeClinica[];
  cierresTexto: unknown;
  horario: HorarioClinica;
  zona: string;
  duracionMin?: number;
  margenMin?: number;
  ahora?: Date;
}

type Respuesta = { jsonrpc: '2.0'; id?: unknown; result?: unknown; error?: { code: number; message: string } };

const ok = (id: unknown, result: unknown): Respuesta => ({ jsonrpc: '2.0', id, result });
const fallo = (id: unknown, code: number, message: string): Respuesta => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Lo que ve el modelo. JSON compacto y no prosa: es más corto y no se puede malinterpretar. */
const texto = (datos: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(datos) }], isError: false });
const malo = (mensaje: string) => ({ content: [{ type: 'text', text: JSON.stringify({ error: mensaje }) }], isError: true });

async function ejecutar(
  nombre: string,
  args: Record<string, any>,
  ctx: ContextoDeAgenda,
  deps: Dependencias
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const ahora = ctx.ahora ?? new Date();

  if (nombre === 'get_available_slots') {
    const cuando = args.cuando ? leerMomento(args.cuando, ctx.zona) : null;
    // UNA FECHA QUE NO SE ENTIENDE NO SE IGNORA. Seguir sin ella contestaría «tengo el
    // jueves a las 10» a quien preguntó por el martes, y el modelo no tendría forma de
    // saber que su pregunta se perdió por el camino.
    if (args.cuando && !cuando) return malo(`no_entiendo_la_fecha_${String(args.cuando).slice(0, 40)}`);

    const r: Consulta = await consultarAgenda({
      doctores: ctx.doctores,
      cierres: ctx.cierresTexto,
      zona: ctx.zona,
      doctorPedido: args.doctor,
      cuando: cuando ?? undefined,
      servicio: args.servicio,
      duracionMin: ctx.duracionMin,
      margenMin: ctx.margenMin,
      ahora
    }, deps);
    return r.error ? malo(r.error) : texto(r);
  }

  if (nombre === 'create_booking') {
    const cuando = leerMomento(args.cuando, ctx.zona);
    if (!cuando) return malo('no_entiendo_la_fecha');

    const quien = doctorPorNombre(ctx.doctores, args.doctor);
    // SIN DOCTOR CLARO NO SE RESERVA. Con dos doctoras Ana, elegir una manda al paciente
    // con la que no era y no se descubre hasta que llega. Se devuelve la duda para que
    // Helios pregunte, que es lo que pidió David: nunca reservar sin consentimiento.
    if (quien.tipo === 'varios') {
      return malo(`varios_doctores_se_llaman_asi:${quien.doctores.map(d => d.apellido).join(',')}`);
    }
    if (quien.tipo === 'ninguno') return malo('no_se_quien_es_ese_doctor');

    const cierres = leerCierres(ctx.cierresTexto) ?? [];
    const dia = new Intl.DateTimeFormat('en-CA', {
      timeZone: ctx.zona, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(cuando);
    if (estaCerrado(cierres, dia)) return malo('la_clinica_cierra_ese_dia');

    const duracion = ctx.duracionMin ?? 45;
    const fin = new Date(cuando.getTime() + duracion * 60_000);

    // SE VUELVE A COMPROBAR QUE ESTÉ LIBRE. Entre ofrecer la hora y confirmarla pasan
    // minutos, y en esos minutos alguien puede reservar por teléfono. La oferta era una
    // propuesta; la reserva es lo que no se puede deshacer.
    const libre = await consultarAgenda({
      doctores: ctx.doctores, cierres: ctx.cierresTexto, zona: ctx.zona,
      doctorPedido: quien.doctor.nombre, cuando, servicio: args.servicio,
      duracionMin: ctx.duracionMin, margenMin: ctx.margenMin, ahora
    }, deps);
    if (libre.error) return malo(libre.error);
    if (!libre.pedido?.libre) {
      return malo(`esa_hora_ya_no_esta_libre:${(libre.mismaHora ?? []).join(',')}`);
    }

    const paciente = String(args.paciente || '').trim().slice(0, 80);
    const servicio = String(args.servicio || '').trim().slice(0, 60);
    const cita = await crearCita({
      calendario: quien.doctor.calendario,
      inicio: cuando,
      fin,
      titulo: [servicio, paciente].filter(Boolean).join(' · ') || 'Cita',
      descripcion: [
        paciente ? `Paciente: ${paciente}` : '',
        args.telefono ? `Telefono: ${String(args.telefono).slice(0, 40)}` : '',
        args.notas ? `Notas: ${String(args.notas).slice(0, 300)}` : '',
        `Agendado por Helios (${ctx.tenantId})`
      ].filter(Boolean).join('\n'),
      zona: ctx.zona,
      // EL ID SALE DE LA CITA. Si la respuesta se pierde y Helios reintenta, Google
      // devuelve 409 y aquí se lee como éxito, en vez de crear una segunda cita idéntica.
      id: idDeEvento(ctx.tenantId, quien.doctor.calendario, cuando.toISOString())
    }, deps);

    if (esError(cita)) return malo(cita.error);
    return texto({
      cita_id: cita.id,
      calendario: cita.calendario,
      doctor: quien.doctor.nombre,
      cuando: libre.pedido.cuando,
      ya_existia: cita.yaExistia
    });
  }

  if (nombre === 'reschedule_booking') {
    const cuando = leerMomento(args.cuando, ctx.zona);
    if (!cuando) return malo('no_entiendo_la_fecha');
    if (!args.cita_id || !args.calendario) return malo('falta_cita_id_o_calendario');

    let destino: string | undefined;
    let nombreDestino: string | undefined;
    if (args.doctor) {
      const quien = doctorPorNombre(ctx.doctores, args.doctor);
      if (quien.tipo === 'varios') {
        return malo(`varios_doctores_se_llaman_asi:${quien.doctores.map(d => d.apellido).join(',')}`);
      }
      if (quien.tipo === 'ninguno') return malo('no_se_quien_es_ese_doctor');
      destino = quien.doctor.calendario;
      nombreDestino = quien.doctor.nombre;
    }

    const duracion = ctx.duracionMin ?? 45;
    const r = await moverCita({
      calendario: String(args.calendario),
      id: String(args.cita_id),
      inicio: cuando,
      fin: new Date(cuando.getTime() + duracion * 60_000),
      zona: ctx.zona,
      calendarioDestino: destino
    }, deps);

    if (esError(r)) return malo(r.error);
    return texto({ cita_id: r.id, calendario: r.calendario, ...(nombreDestino ? { doctor: nombreDestino } : {}) });
  }

  if (nombre === 'cancel_booking') {
    if (!args.cita_id || !args.calendario) return malo('falta_cita_id_o_calendario');
    const r = await cancelarCita({ calendario: String(args.calendario), id: String(args.cita_id) }, deps);
    return esError(r) ? malo(r.error) : texto({ cancelada: true });
  }

  return malo(`herramienta_desconocida_${nombre}`);
}

/**
 * Atiende un mensaje JSON-RPC. Devuelve null cuando no hay nada que contestar.
 *
 * LAS NOTIFICACIONES NO SE CONTESTAN, y no es un detalle: en JSON-RPC un mensaje sin `id`
 * es una notificación, y responderle rompe a algunos clientes. `notifications/initialized`
 * llega justo después del apretón de manos, en cada arranque.
 */
export async function atenderMcp(
  peticion: any,
  ctx: ContextoDeAgenda,
  deps: Dependencias = {}
): Promise<Respuesta | null> {
  const id = peticion?.id;
  const metodo = String(peticion?.method || '');
  const esNotificacion = id === undefined || id === null;

  if (metodo.startsWith('notifications/')) return null;

  if (metodo === 'initialize') {
    const pedida = String(peticion?.params?.protocolVersion || '');
    return ok(id, {
      protocolVersion: PROTOCOLOS.includes(pedida) ? pedida : PROTOCOLO_POR_DEFECTO,
      capabilities: { tools: {} },
      serverInfo: { name: 'helios-agenda', version: '1.0.0' }
    });
  }

  if (metodo === 'ping') return ok(id, {});

  if (metodo === 'tools/list') {
    return ok(id, { tools: HERRAMIENTAS });
  }

  if (metodo === 'tools/call') {
    const nombre = String(peticion?.params?.name || '');
    const args = (peticion?.params?.arguments ?? {}) as Record<string, any>;
    try {
      return ok(id, await ejecutar(nombre, args, ctx, deps));
    } catch (e: any) {
      // UN FALLO SE DEVUELVE COMO RESULTADO DE HERRAMIENTA, NO COMO ERROR DE PROTOCOLO. Un
      // error JSON-RPC corta la conversación del cliente; un resultado con `isError` lo lee
      // el modelo y puede derivar a una persona, que es lo que debe pasar.
      return ok(id, malo(`fallo_inesperado:${String(e?.message || e).slice(0, 120)}`));
    }
  }

  if (esNotificacion) return null;
  return fallo(id, -32601, `Method not found: ${metodo}`);
}

export const NOMBRES_DE_HERRAMIENTA = HERRAMIENTAS.map(h => h.name);

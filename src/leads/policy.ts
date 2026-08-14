/**
 * Seguimiento de leads: a quién se le escribe, cuándo, y cuándo NO.
 *
 * Lógica pura, sin red y sin base de datos, porque aquí vive la parte sutil: el
 * choque entre dos relojes que no se hablan entre sí.
 *
 *   1. WhatsApp solo permite mensajes libres dentro de las 24 horas siguientes al
 *      ÚLTIMO MENSAJE DEL PACIENTE. Pasado ese plazo hace falta una plantilla
 *      aprobada por Meta. Equivocarse no da un error de programa: lo bloquea Meta
 *      y a base de intentos se arriesga la reputación del número de la clínica.
 *
 *   2. La clínica abre de 10:00 a 20:00 de lunes a viernes y de 10:00 a 15:00 los
 *      sábados. Nadie quiere recibir publicidad de su dentista a las 3 de la
 *      madrugada.
 *
 * Los dos a la vez recortan mucho. Una consulta de las nueve de la mañana tiene
 * su plazo a las nueve de la mañana siguiente, cuando la clínica todavía está
 * cerrada: para esa conversación NO existe ningún momento válido, y lo correcto es
 * no escribir en vez de forzarlo. Esos casos se cuentan aparte: si son muchos, es
 * cuando merece la pena tramitar una plantilla con Meta.
 */

/** Qué interés mostró el paciente. Determina qué se le dice. */
export const LEAD_INTERESTS = [
  'appointment',          // preguntó por una cita y no la cerró
  'cancelled',            // canceló una que ya tenía
  'reschedule_pending',   // se quedó a medias cambiando la fecha
  'treatment'             // preguntó por un tratamiento o un precio
] as const;

export type LeadInterest = typeof LEAD_INTERESTS[number];

/**
 * Por qué NO se le escribe. Se guarda el motivo y no un booleano, por lo mismo
 * que en la encuesta: descartar sin contar esconde justo lo que hay que ver.
 */
export const LEAD_BLOCK_REASONS = [
  'booked',            // ya tiene cita: escribirle sería no habernos enterado
  'complaint',         // acabó enfadado
  'not_interested',    // dijo que no
  'human_handoff',     // lo lleva una persona
  'technical_failure', // Helios falló: no es momento de vender
  'opted_out'          // pidió que no se le escriba
] as const;

export type LeadBlockReason = typeof LEAD_BLOCK_REASONS[number];

export function isLeadInterest(value: unknown): value is LeadInterest {
  return typeof value === 'string' && (LEAD_INTERESTS as readonly string[]).includes(value);
}

export function isLeadBlockReason(value: unknown): value is LeadBlockReason {
  return typeof value === 'string' && (LEAD_BLOCK_REASONS as readonly string[]).includes(value);
}

/** Operaciones de Hermes que revelan interés sin cierre. */
const INTEREST_BY_OPERATION: Record<string, LeadInterest> = {
  availability_checked: 'appointment',
  appointment_cancelled: 'cancelled',
  appointment_rescheduled: 'reschedule_pending'
};

/**
 * ¿Este turno deja un lead?
 *
 * Una cita creada con éxito NO es un lead: es un cliente. Y una reprogramación
 * con éxito tampoco: ya tiene su hueco nuevo. Solo cuentan los intentos que se
 * quedaron a medias.
 */
export function detectLeadInterest(operation: any): LeadInterest | null {
  const type = String(operation?.type ?? '').trim().toLowerCase();
  const status = String(operation?.status ?? '').trim().toLowerCase();
  if (type === 'appointment_created' && status === 'success') return null;
  if (type === 'appointment_rescheduled' && status === 'success') return null;
  if (type === 'appointment_cancelled') return 'cancelled';
  if (status === 'failed') return null;
  return INTEREST_BY_OPERATION[type] ?? null;
}

// --- El reloj de la clínica -------------------------------------------------

export interface FranjaHoraria {
  /** Minuto del día en que abre, contando desde medianoche. */
  desde: number;
  /** Minuto del día en que cierra. */
  hasta: number;
}

/** Horario semanal. La clave es el día según getDay(): 0 domingo, 6 sábado. */
export type HorarioClinica = Record<number, FranjaHoraria[]>;

/**
 * HORARIO EN EL QUE SE PUEDE ESCRIBIR, que NO es el horario de la clínica.
 *
 * La clínica atiende de 10:00 a 20:00 y los sábados hasta las 15:00. Pero mandar
 * un mensaje no es lo mismo que atender: el operador decidió que a partir de las
 * 8:00 ya es hora decente para escribir a alguien, aunque la puerta todavía no
 * esté abierta. Las CITAS se siguen ofreciendo solo en horario de clínica, y de
 * eso se encarga la disponibilidad real de Cal.com, no este archivo.
 *
 * La diferencia no es cosmética: abre dos horas por la mañana que resuelven justo
 * el caso que antes se quedaba sin seguimiento. Una consulta de las nueve de la
 * mañana vence a las nueve de la mañana siguiente, y con el horario de clínica no
 * había ni un minuto válido; con las 8:00 sí lo hay.
 */
const ABRE_MENSAJES = 8 * 60;

export const HORARIO_COI: HorarioClinica = {
  0: [],                                        // domingo: ni mensajes ni citas
  1: [{ desde: ABRE_MENSAJES, hasta: 20 * 60 }],
  2: [{ desde: ABRE_MENSAJES, hasta: 20 * 60 }],
  3: [{ desde: ABRE_MENSAJES, hasta: 20 * 60 }],
  4: [{ desde: ABRE_MENSAJES, hasta: 20 * 60 }],
  5: [{ desde: ABRE_MENSAJES, hasta: 20 * 60 }],
  6: [{ desde: ABRE_MENSAJES, hasta: 15 * 60 }] // sábado, media jornada
};

const DIAS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Día de la semana y minuto del día de un instante, EN LA ZONA DE LA CLÍNICA.
 *
 * Se hace con Intl y no con getHours() a propósito: el servidor puede estar en
 * otra zona, y en España hay cambio de hora dos veces al año. Preguntarle al
 * sistema de internacionalización evita tener que razonar sobre eso.
 */
export function momentoLocal(fecha: Date, zona: string): { dia: number; minuto: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(fecha);
  const valor = (tipo: string) => partes.find(p => p.type === tipo)?.value ?? '';
  const dia = DIAS.indexOf(valor('weekday').toLowerCase());
  // Intl devuelve "24" para medianoche en algunos entornos.
  const hora = Number(valor('hour')) % 24;
  return { dia, minuto: hora * 60 + Number(valor('minute')) };
}

export function clinicaAbierta(fecha: Date, zona: string, horario: HorarioClinica): boolean {
  const { dia, minuto } = momentoLocal(fecha, zona);
  if (dia < 0) return false;
  return (horario[dia] ?? []).some(f => minuto >= f.desde && minuto < f.hasta);
}

export interface VentanaSeguimiento {
  /** No antes de esto: si se escribe muy pronto, parece que se persigue. */
  horasMinimas: number;
  /**
   * No después de esto. Se deja un margen por debajo de las 24 de WhatsApp: si el
   * envío se retrasa unos minutos en la cola, el mensaje seguiría siendo válido.
   */
  horasMaximas: number;
  zona: string;
  horario: HorarioClinica;
}

export const VENTANA_POR_DEFECTO: VentanaSeguimiento = {
  horasMinimas: 12,
  horasMaximas: 23,
  zona: 'Europe/Madrid',
  horario: HORARIO_COI
};

/**
 * El mejor momento para escribir, o null si no existe ninguno.
 *
 * Se busca el instante MÁS TEMPRANO que cumpla las tres condiciones, y esto tiene
 * su historia: la primera versión buscaba el más tardío, pensando que cuanto más
 * tarde más se parece a «al día siguiente». Era un error. Apurar hasta el último
 * minuto del plazo deja CERO margen: si el worker se retrasa una hora, o la cola
 * se atasca, el plazo de WhatsApp se cierra y el mensaje ya no se puede mandar
 * libre. Con el más temprano, una consulta de la tarde recibe respuesta a la
 * mañana siguiente al abrir —que es exactamente la sensación buscada— y quedan
 * horas de sobra por si algo va lento.
 *
 * Se recorre hacia delante en pasos de quince minutos; once horas como mucho.
 */
export function calcularMomentoDeEnvio(
  interesEn: Date,
  ventana: VentanaSeguimiento = VENTANA_POR_DEFECTO
): Date | null {
  const base = interesEn.getTime();
  const pronto = base + ventana.horasMinimas * 3600_000;
  const tarde = base + ventana.horasMaximas * 3600_000;
  const PASO = 15 * 60_000;

  for (let t = pronto; t <= tarde; t += PASO) {
    const candidato = new Date(t);
    if (clinicaAbierta(candidato, ventana.zona, ventana.horario)) return candidato;
  }
  return null;
}

export interface LeadState {
  lead_interest?: unknown;
  lead_interest_at?: unknown;
  lead_followup_at?: unknown;
  lead_blocked_reason?: unknown;
}

export type LeadOutcome =
  | { action: 'send'; interest: LeadInterest; at: Date }
  | { action: 'skip'; reason: LeadBlockReason | 'no_interest' | 'already_sent' | 'no_window' | 'too_soon' };

/**
 * Qué hacer con esta conversación AHORA.
 *
 * El orden importa: primero lo que prohíbe escribir, y solo después el reloj. Un
 * paciente que se fue enfadado no debe pasar ni siquiera por el cálculo horario.
 */
export function decidirSeguimiento(
  state: LeadState,
  ahora: Date,
  ventana: VentanaSeguimiento = VENTANA_POR_DEFECTO
): LeadOutcome {
  if (isLeadBlockReason(state.lead_blocked_reason)) {
    return { action: 'skip', reason: state.lead_blocked_reason };
  }
  if (state.lead_followup_at) {
    // UN SOLO MENSAJE, NUNCA DOS. Es lo que separa un seguimiento de un acoso.
    return { action: 'skip', reason: 'already_sent' };
  }
  if (!isLeadInterest(state.lead_interest) || !state.lead_interest_at) {
    return { action: 'skip', reason: 'no_interest' };
  }

  const interesEn = new Date(String(state.lead_interest_at));
  if (Number.isNaN(interesEn.getTime())) return { action: 'skip', reason: 'no_interest' };

  const momento = calcularMomentoDeEnvio(interesEn, ventana);
  if (!momento) {
    // No hay ningún hueco que sea a la vez horario de clínica y dentro del plazo
    // de WhatsApp. Pasa sobre todo con las consultas de por la mañana, cuyo plazo
    // vence al día siguiente antes de abrir. No se fuerza: se cuenta y se deja.
    return { action: 'skip', reason: 'no_window' };
  }
  if (ahora.getTime() < momento.getTime()) return { action: 'skip', reason: 'too_soon' };

  // Si se pasó el plazo mientras la fila esperaba, ya no se puede escribir libre.
  if (ahora.getTime() > interesEn.getTime() + ventana.horasMaximas * 3600_000) {
    return { action: 'skip', reason: 'no_window' };
  }

  return { action: 'send', interest: state.lead_interest, at: momento };
}

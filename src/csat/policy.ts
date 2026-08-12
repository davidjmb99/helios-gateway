/**
 * Política de la encuesta de satisfacción (CSAT).
 *
 * Lógica pura: decide si una conversación merece encuesta y, si no, por qué no.
 * Sin efectos y sin red, para poder probarla entera sin infraestructura.
 *
 * REGLA DE ORO: la exclusión SIEMPRE gana sobre la aptitud, y da igual el orden
 * en que lleguen. Un paciente puede agendar la cita y enfadarse después; la
 * conversación deja de ser encuestable en ese momento y no vuelve a serlo.
 */

/** Motivos de exclusión, del más específico al más genérico. */
export const CSAT_EXCLUSION_REASONS = [
  'technical_failure',
  'complaint',
  'frustration',
  'human_handoff'
] as const;

export type CsatExclusionReason = typeof CSAT_EXCLUSION_REASONS[number];

/**
 * Gravedad, para no perder información. Si una conversación se excluye primero
 * por «la atendió una persona» y luego resulta que además hubo un fallo técnico,
 * el motivo guardado tiene que ser el fallo técnico: es el que sirve para
 * medir calidad. Al contrario NO se sobreescribe.
 */
const SEVERITY: Record<CsatExclusionReason, number> = {
  technical_failure: 4,
  complaint: 3,
  frustration: 2,
  human_handoff: 1
};

export function isCsatExclusionReason(value: unknown): value is CsatExclusionReason {
  return typeof value === 'string'
    && (CSAT_EXCLUSION_REASONS as readonly string[]).includes(value);
}

/**
 * Elige qué motivo se queda en la fila. Devuelve null si no hay que escribir
 * nada, para no gastar una escritura en cada turno.
 */
export function mergeExclusionReason(
  current: unknown,
  incoming: CsatExclusionReason
): CsatExclusionReason | null {
  if (!isCsatExclusionReason(current)) return incoming;
  return SEVERITY[incoming] > SEVERITY[current] ? incoming : null;
}

/** Operaciones de Hermes que significan «servicio prestado». */
const ELIGIBLE_OPERATIONS: ReadonlySet<string> = new Set([
  'appointment_created',
  'appointment_rescheduled'
]);

/**
 * ¿Este turno vuelve apta la conversación?
 *
 * Se exige status 'success' explícito: una operación en 'pending' o 'failed' no
 * es una cita agendada, y encuestar por una cita que no existe sería peor que no
 * encuestar. La cancelación NO retira la aptitud, por decisión del operador.
 */
export function isEligibleOperation(operation: any): boolean {
  const type = String(operation?.type ?? '').trim().toLowerCase();
  const status = String(operation?.status ?? '').trim().toLowerCase();
  return ELIGIBLE_OPERATIONS.has(type) && status === 'success';
}

export interface CsatState {
  csat_eligible_at?: unknown;
  csat_excluded_reason?: unknown;
  csat_label_applied_at?: unknown;
}

export type CsatOutcome =
  | { action: 'send'; reason: 'eligible_and_clean' }
  | { action: 'exclude'; reason: CsatExclusionReason }
  | { action: 'none'; reason: 'not_eligible' | 'already_applied' };

/**
 * Qué hacer cuando la conversación se resuelve.
 *
 * La etiqueta se aplica AQUÍ y no al agendar: si se aplicara al agendar, la
 * encuesta podría salir mientras el paciente sigue escribiendo.
 */
export function decideOnResolution(state: CsatState): CsatOutcome {
  if (state.csat_label_applied_at) {
    // Una conversación puede reabrirse y volver a resolverse. La encuesta se
    // manda una vez.
    return { action: 'none', reason: 'already_applied' };
  }

  const excluded = state.csat_excluded_reason;
  if (isCsatExclusionReason(excluded)) {
    return { action: 'exclude', reason: excluded };
  }

  if (!state.csat_eligible_at) {
    // Sin cita agendada no hay servicio que valorar. Es el caso por defecto y
    // por eso las conversaciones históricas, con las tres columnas en NULL,
    // nunca generan una encuesta retroactiva.
    return { action: 'none', reason: 'not_eligible' };
  }

  return { action: 'send', reason: 'eligible_and_clean' };
}

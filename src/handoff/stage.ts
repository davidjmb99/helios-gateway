/**
 * Máquina de estados canónica del handoff humano.
 *
 * Fuente de verdad: helios_conversation_state.stage.
 * human_handoff_active se sigue escribiendo, derivado de stage, por
 * compatibilidad con el dashboard y con el payload que recibe Hermes.
 *
 * Este módulo es lógica pura: no toca Supabase, Chatwoot ni la red.
 */

export const HANDOFF_STAGES = [
  'bot_active',
  'handoff_requested',
  'human_queue',
  'human_active',
  'waiting_patient',
  'return_requested',
  'handoff_failed',
  'closed'
] as const;

export type HandoffStage = typeof HANDOFF_STAGES[number];

export const DEFAULT_STAGE: HandoffStage = 'bot_active';

/**
 * Etapas en las que la conversación pertenece a una persona. Con cualquiera de
 * ellas el Gateway persiste el mensaje pero NO construye patient_message_ready
 * ni llama al Adapter (ítem 16).
 *
 * 'closed' NO bloquea: un paciente que vuelve a escribir después de cerrar
 * debe ser atendido, y bloquearlo dejaría el mensaje muerto (requisito A).
 */
const HUMAN_OWNED_STAGES: ReadonlySet<HandoffStage> = new Set<HandoffStage>([
  'handoff_requested',
  'human_queue',
  'human_active',
  'waiting_patient',
  'return_requested',
  'handoff_failed'
]);

const VALID_TRANSITIONS: Record<HandoffStage, ReadonlySet<HandoffStage>> = {
  bot_active: new Set<HandoffStage>(['handoff_requested', 'handoff_failed', 'closed']),
  handoff_requested: new Set<HandoffStage>(['human_queue', 'human_active', 'handoff_failed']),
  human_queue: new Set<HandoffStage>(['human_active', 'waiting_patient', 'human_queue', 'handoff_failed', 'closed']),
  human_active: new Set<HandoffStage>(['waiting_patient', 'return_requested', 'human_queue', 'handoff_failed', 'closed']),
  waiting_patient: new Set<HandoffStage>(['human_active', 'return_requested', 'handoff_failed', 'closed']),
  return_requested: new Set<HandoffStage>(['bot_active', 'human_active', 'handoff_failed', 'closed']),
  // Un handoff fallido solo sale por intervención humana o por cierre.
  handoff_failed: new Set<HandoffStage>(['human_queue', 'human_active', 'bot_active', 'closed']),
  // Una conversación cerrada se reabre si el paciente vuelve a escribir.
  closed: new Set<HandoffStage>(['bot_active', 'handoff_requested', 'handoff_failed'])
};

export function isHandoffStage(value: unknown): value is HandoffStage {
  return typeof value === 'string' && (HANDOFF_STAGES as readonly string[]).includes(value);
}

/**
 * Resuelve el stage efectivo de una fila de conversation_state.
 *
 * Las filas anteriores a la migración no tienen stage. Para ellas se traduce el
 * booleano legacy: human_handoff_active=true significa modo humano, salvo la
 * combinación status='error' + human_handoff_active, que el Gateway siempre ha
 * tratado como fallo técnico y no como derivación real.
 */
export function resolveStage(state: any): { stage: HandoffStage; source: string } {
  if (isHandoffStage(state?.stage)) {
    return { stage: state.stage, source: 'conversation_state.stage' };
  }
  if (state?.stage !== undefined && state?.stage !== null) {
    return { stage: DEFAULT_STAGE, source: 'invalid_stage_value' };
  }
  if (state?.human_handoff_active === true) {
    if (String(state?.status || '') === 'error') {
      return { stage: DEFAULT_STAGE, source: 'legacy_recovered_from_technical_error' };
    }
    return { stage: 'human_active', source: 'legacy_human_handoff_active' };
  }
  return { stage: DEFAULT_STAGE, source: state ? 'legacy_default' : 'missing_state_default' };
}

/** Verdadero cuando la conversación pertenece a una persona. */
export function isHumanOwnedStage(stage: HandoffStage): boolean {
  return HUMAN_OWNED_STAGES.has(stage);
}

/** El valor que debe persistirse en la columna legacy human_handoff_active. */
export function humanHandoffActiveFor(stage: HandoffStage): boolean {
  return isHumanOwnedStage(stage);
}

export function canTransition(from: HandoffStage, to: HandoffStage): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.has(to) === true;
}

export interface StageDecision {
  allowed: boolean;
  from: HandoffStage;
  to: HandoffStage;
  reason: string;
}

export function evaluateTransition(from: HandoffStage, to: HandoffStage): StageDecision {
  if (from === to) {
    return { allowed: true, from, to, reason: 'noop_same_stage' };
  }
  if (canTransition(from, to)) {
    return { allowed: true, from, to, reason: 'valid_transition' };
  }
  return { allowed: false, from, to, reason: 'invalid_transition' };
}

// --------------------------------------------------------------------------
// Contrato de handoff (ítem 17)
// --------------------------------------------------------------------------

export const HANDOFF_REASON_CODES = [
  'human_requested',
  'clinical_question',
  'possible_urgency',
  'complaint',
  'price_exception',
  'financing_exception',
  'operational_exception'
] as const;

export type HandoffReasonCode = typeof HANDOFF_REASON_CODES[number];

export const HANDOFF_DESTINATIONS = [
  'reception',
  'clinical_lead',
  'helios_support'
] as const;

export type HandoffDestination = typeof HANDOFF_DESTINATIONS[number];

export const HANDOFF_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type HandoffPriority = typeof HANDOFF_PRIORITIES[number];

/** Mapeo de motivo a equipo (ítem 19). Los IDs reales son configurables por tenant. */
const REASON_DESTINATION: Record<HandoffReasonCode, HandoffDestination> = {
  human_requested: 'reception',
  complaint: 'reception',
  price_exception: 'reception',
  financing_exception: 'reception',
  operational_exception: 'reception',
  clinical_question: 'clinical_lead',
  possible_urgency: 'clinical_lead'
};

const DEFAULT_PRIORITY: Record<HandoffReasonCode, HandoffPriority> = {
  human_requested: 'normal',
  complaint: 'high',
  price_exception: 'normal',
  financing_exception: 'normal',
  operational_exception: 'high',
  clinical_question: 'high',
  possible_urgency: 'urgent'
};

export function isHandoffReasonCode(value: unknown): value is HandoffReasonCode {
  return typeof value === 'string' && (HANDOFF_REASON_CODES as readonly string[]).includes(value);
}

export function normalizeReasonCode(value: unknown): HandoffReasonCode {
  if (isHandoffReasonCode(value)) return value;
  return 'operational_exception';
}

export function normalizePriority(value: unknown, reasonCode: HandoffReasonCode): HandoffPriority {
  const normalized = String(value ?? '').trim().toLowerCase();
  if ((HANDOFF_PRIORITIES as readonly string[]).includes(normalized)) {
    return normalized as HandoffPriority;
  }
  if (normalized === 'medium') return 'normal';
  return DEFAULT_PRIORITY[reasonCode];
}

/**
 * Resuelve el destino. Un fallo técnico siempre va a Soporte Helios: un error
 * transitorio no se convierte en handoff clínico (ítem 17).
 */
export function resolveDestination(
  reasonCode: HandoffReasonCode,
  requested: unknown,
  origin: 'model' | 'technical_failure'
): HandoffDestination {
  if (origin === 'technical_failure') return 'helios_support';
  const normalized = String(requested ?? '').trim().toLowerCase();
  if ((HANDOFF_DESTINATIONS as readonly string[]).includes(normalized)) {
    return normalized as HandoffDestination;
  }
  return REASON_DESTINATION[reasonCode];
}

export interface NormalizedHandoffRequest {
  reason_code: HandoffReasonCode;
  destination: HandoffDestination;
  priority: HandoffPriority;
  summary: string | null;
  treatment_interest: string | null;
  origin: 'model' | 'technical_failure';
}

const MAX_SUMMARY_LENGTH = 500;

function trimmedOrNull(value: unknown, maxLength: number): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

/**
 * Normaliza la petición de handoff que llega en la respuesta del Adapter.
 * Ante la duda, normalizar en vez de rechazar: un handoff mal formado no puede
 * dejar el mensaje del paciente sin atender.
 */
export function normalizeHandoffRequest(
  raw: any,
  origin: 'model' | 'technical_failure' = 'model'
): NormalizedHandoffRequest {
  const reasonCode = normalizeReasonCode(raw?.reason_code ?? raw?.reason);
  return {
    reason_code: reasonCode,
    destination: resolveDestination(reasonCode, raw?.destination, origin),
    priority: normalizePriority(raw?.priority, reasonCode),
    summary: trimmedOrNull(raw?.summary, MAX_SUMMARY_LENGTH),
    treatment_interest: trimmedOrNull(raw?.treatment_interest, 120),
    origin
  };
}

/**
 * Deduce el motivo y el contexto del handoff cuando el modelo no los manda.
 *
 * POR QUÉ EXISTE ESTO. El contrato de salida está fijado en tres sitios que exigen
 * exactamente diez claves raíz: la línea del contrato en el SOUL, las instrucciones
 * que inyecta el Adapter, y el output guard de Hermes, que rechaza una respuesta con
 * claves raíz de más. Un objeto `handoff` adicional no puede llegar: el Adapter lo
 * descarta al construir su resultado clave por clave, y antes de eso el guard
 * habría tumbado la respuesta entera y el paciente se habría quedado con el
 * fallback de 324 caracteres.
 *
 * Así que el motivo se deduce aquí, en código, a partir de señales que el Gateway
 * ya calcula de forma determinista sobre las palabras del propio paciente. Es la
 * regla de este proyecto: lo que debe ser exacto va en código, no en el modelo.
 *
 * El orden es por gravedad. Una urgencia clínica manda sobre todo lo demás.
 */
export function deriveHandoffRequest(input: {
  /** Lo que haya mandado el modelo, si algún día el contrato lo permite. */
  modelHandoff?: any;
  signals: {
    possible_emergency?: boolean;
    asks_for_human?: boolean;
    possible_frustration?: boolean;
  };
  /** Mensaje real del paciente. Se usa como contexto: son sus palabras, no una interpretación. */
  patientMessage?: string | null;
  /** operation.summary del modelo, que sí viaja en el contrato. */
  operationSummary?: string | null;
}): Record<string, unknown> {
  const model = input.modelHandoff && typeof input.modelHandoff === 'object'
    ? input.modelHandoff
    : {};

  let derivedReason: HandoffReasonCode;
  if (input.signals.possible_emergency) {
    derivedReason = 'possible_urgency';
  } else if (input.signals.possible_frustration) {
    derivedReason = 'complaint';
  } else if (input.signals.asks_for_human) {
    derivedReason = 'human_requested';
  } else {
    derivedReason = 'operational_exception';
  }

  return {
    reason_code: isHandoffReasonCode(model.reason_code) ? model.reason_code : derivedReason,
    priority: model.priority ?? undefined,
    // El resumen que ve el equipo: lo que pidió el modelo, o lo que dijo el
    // paciente con sus propias palabras. Nunca una interpretación inventada.
    summary: model.summary
      ?? input.operationSummary
      ?? (input.patientMessage ? `El paciente escribió: «${String(input.patientMessage).trim()}»` : null),
    treatment_interest: model.treatment_interest ?? null
  };
}

/**
 * ¿La respuesta del Adapter pide una derivación humana?
 *
 * Un error técnico NO se convierte aquí en handoff clínico: esa ruta la decide
 * el clasificador de fallos, con destino Soporte Helios.
 */
/**
 * Valores de operation.type que significan derivación. 'human_handoff' es el que
 * declara el enum del SOUL del perfil helios; 'handoff' se acepta también porque
 * ante la duda se normaliza, no se rechaza: un handoff no detectado deja al
 * paciente esperando a una persona que nadie ha avisado.
 */
const HANDOFF_OPERATION_TYPES: ReadonlySet<string> = new Set([
  'human_handoff',
  'handoff'
]);

export function detectHandoffRequest(response: any): boolean {
  if (!response) return false;
  if (response.error_code) return false;
  return response.handoff_required === true
    || response.requires_handoff === true
    || response.decision === 'needs_handoff'
    || HANDOFF_OPERATION_TYPES.has(String(response?.operation?.type || '').trim().toLowerCase())
    || Boolean(response?.handoff?.reason_code);
}

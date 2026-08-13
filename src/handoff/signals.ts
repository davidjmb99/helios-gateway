/**
 * Interpretación de las señales de Chatwoot (ítem 21).
 *
 * En esta instalación las macros no pueden escribir atributos personalizados, así
 * que el equipo señaliza con etiquetas, equipos y cambios de estado, y el Gateway
 * traduce eso a la máquina de estados y escribe los atributos por API.
 *
 * El payload de conversation_updated de Chatwoot (EventDataPresenter#webhook_data)
 * incluye labels, status, priority, meta.team y meta.assignee, que es todo lo que
 * hace falta aquí.
 *
 * Este módulo es lógica pura y no toca la red.
 */

import { HandoffStage, canTransition } from './stage.js';
import { HandoffRouting } from './routing.js';

export interface ConversationSignal {
  event: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  inbox_id: string;
  phone: string;
  labels: string[];
  status: string;
  priority: string | null;
  team_id: string | null;
  team_name: string | null;
  assignee_id: string | null;
  snoozed_until: string | null;
}

function normalizedString(value: unknown): string {
  return String(value ?? '').trim();
}

export function parseConversationSignal(body: any): ConversationSignal {
  const meta = body?.meta || {};
  const labels = Array.isArray(body?.labels)
    ? body.labels.map((label: unknown) => normalizedString(label)).filter(Boolean)
    : [];

  let phone = normalizedString(meta?.sender?.phone_number || body?.contact_inbox?.source_id);
  if (phone && !phone.startsWith('+')) phone = `+${phone}`;

  return {
    event: normalizedString(body?.event),
    account_id: normalizedString(body?.account?.id ?? body?.account_id),
    // En el payload de conversación el identificador visible va en la raíz.
    conversation_id: normalizedString(body?.id ?? body?.conversation?.id),
    contact_id: normalizedString(body?.contact_inbox?.contact_id ?? meta?.sender?.id),
    inbox_id: normalizedString(body?.inbox_id),
    phone,
    labels,
    status: normalizedString(body?.status),
    priority: normalizedString(body?.priority) || null,
    team_id: meta?.team?.id === undefined || meta?.team?.id === null
      ? null
      : normalizedString(meta.team.id),
    team_name: normalizedString(meta?.team?.name) || null,
    assignee_id: meta?.assignee?.id === undefined || meta?.assignee?.id === null
      ? null
      : normalizedString(meta.assignee.id),
    snoozed_until: normalizedString(body?.snoozed_until) || null
  };
}

export interface SignalInterpretation {
  target: HandoffStage | null;
  reason: string;
}

/** ¿El equipo asignado es Soporte Helios? Por ID configurado o por nombre. */
export function isSupportTeam(signal: ConversationSignal, routing: HandoffRouting): boolean {
  const configuredId = routing.teams.helios_support;
  if (configuredId && signal.team_id === configuredId) return true;
  // Respaldo por nombre, para cuando el ID no está configurado todavía. Se buscan
  // las dos palabras por separado y NO la frase exacta: la clínica renombró el
  // equipo a «Soporte Técnico Helios» el 13-08-2026, y un `includes('soporte
  // helios')` dejó de coincidir por la palabra intercalada. Este respaldo existe
  // precisamente para el rato en que el ID aún no está puesto, así que no puede
  // depender del orden ni de las palabras exactas del nombre.
  const name = (signal.team_name || '').toLowerCase();
  return name.includes('soporte') && name.includes('helios');
}

/**
 * Traduce una señal a la etapa que pide el equipo.
 *
 * Devuelve null cuando la conversación no lleva ninguna etiqueta de Helios: en
 * ese caso NO se toca el estado. Devolver la conversación al bot solo puede
 * ocurrir por la macro de retorno explícita, nunca por ausencia de etiquetas.
 */
export function interpretSignal(
  signal: ConversationSignal,
  routing: HandoffRouting,
  currentStage: HandoffStage
): SignalInterpretation {
  const labels = new Set(signal.labels);

  if (labels.has(routing.labels.return_requested)) {
    return { target: 'return_requested', reason: 'label_return_requested' };
  }

  if (labels.has(routing.labels.failed) && isSupportTeam(signal, routing)) {
    return { target: 'handoff_failed', reason: 'label_urgent_support_team' };
  }

  if (labels.has(routing.labels.escalated)) {
    return { target: 'human_queue', reason: 'label_escalated' };
  }

  if (labels.has(routing.labels.active)) {
    if (signal.status === 'snoozed' || signal.status === 'pending') {
      return { target: 'waiting_patient', reason: `label_active_status_${signal.status}` };
    }
    return { target: 'human_active', reason: 'label_active' };
  }

  if (labels.has(routing.labels.queue)) {
    return { target: 'human_queue', reason: 'label_queue' };
  }

  // Sin etiquetas de Helios: solo se interpreta el cierre, y únicamente si la
  // conversación ya estaba en manos de una persona.
  if (signal.status === 'resolved' && currentStage !== 'bot_active' && currentStage !== 'closed') {
    return { target: 'closed', reason: 'status_resolved' };
  }

  return { target: null, reason: 'no_helios_signal' };
}

/** Etapas desde las que se permite devolver la conversación al bot (ítem 22). */
const RETURN_ALLOWED_FROM: ReadonlySet<HandoffStage> = new Set<HandoffStage>([
  'human_active',
  'waiting_patient',
  'return_requested'
]);

export type SignalAction =
  | { kind: 'none'; reason: string }
  | { kind: 'return_to_bot'; reason: string }
  | { kind: 'set_stage'; stage: HandoffStage; reason: string }
  | { kind: 'rejected'; from: HandoffStage; to: HandoffStage; reason: string };

/** Decide qué hacer con la señal, sin ejecutar nada. */
export function planSignalAction(
  interpretation: SignalInterpretation,
  currentStage: HandoffStage
): SignalAction {
  const target = interpretation.target;
  if (!target) return { kind: 'none', reason: interpretation.reason };

  if (target === 'return_requested') {
    if (RETURN_ALLOWED_FROM.has(currentStage)) {
      return { kind: 'return_to_bot', reason: interpretation.reason };
    }
    return {
      kind: 'rejected',
      from: currentStage,
      to: 'return_requested',
      reason: 'return_only_from_human_active_or_waiting_patient'
    };
  }

  if (target === currentStage) return { kind: 'none', reason: 'already_in_target_stage' };

  if (!canTransition(currentStage, target)) {
    return { kind: 'rejected', from: currentStage, to: target, reason: 'invalid_transition' };
  }

  return { kind: 'set_stage', stage: target, reason: interpretation.reason };
}

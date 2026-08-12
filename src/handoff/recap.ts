/**
 * Resumen de la conversación para el equipo humano.
 *
 * El objetivo es que quien recibe el handoff entienda qué pasa sin leer toda la
 * conversación. No hay ningún modelo de lenguaje aquí: el resumen son los últimos
 * mensajes reales, recortados y etiquetados por quién habló. Nada inventado, nada
 * interpretado, que es lo único aceptable en un contexto clínico.
 *
 * Cuando la conversación es larga se dice explícitamente, para que el equipo sepa
 * que hay más historia y decida si la lee entera.
 */

export type RecapRole = 'patient' | 'helios' | 'clinic_team';

export interface RecapMessage {
  role: RecapRole;
  text: string;
  at: string;
}

export interface ConversationRecap {
  messages: RecapMessage[];
  total_messages: number;
  truncated: boolean;
}

const MAX_LINE_LENGTH = 180;

function trimForRecap(text: unknown): string {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_LINE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_LINE_LENGTH - 1)}…`;
}

const ROLE_LABELS: Record<RecapRole, string> = {
  patient: 'Paciente',
  helios: 'Helios',
  clinic_team: 'Equipo'
};

/**
 * Une los mensajes del paciente y del equipo (buffer) con los que envió Helios
 * (outbox), los ordena y se queda con los últimos.
 */
export function buildRecap(
  bufferRows: Array<{ body?: unknown; direction?: unknown; author?: unknown; created_at?: unknown }>,
  outboxRows: Array<{ content?: unknown; created_at?: unknown }>,
  limit: number
): ConversationRecap {
  const merged: RecapMessage[] = [];

  for (const row of bufferRows || []) {
    const text = trimForRecap(row.body);
    if (!text) continue;
    const isOutgoing = String(row.direction ?? '') === 'outgoing';
    merged.push({
      role: isOutgoing ? 'clinic_team' : 'patient',
      text,
      at: String(row.created_at ?? '')
    });
  }

  for (const row of outboxRows || []) {
    const text = trimForRecap(row.content);
    if (!text) continue;
    merged.push({ role: 'helios', text, at: String(row.created_at ?? '') });
  }

  merged.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const safeLimit = Math.max(1, limit);
  return {
    messages: merged.slice(-safeLimit),
    total_messages: merged.length,
    truncated: merged.length > safeLimit
  };
}

/** Hora local legible, sin fecha: el equipo mira la conversación del día. */
function shortTime(at: string, timeZone: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(date);
  }
}

/** El resumen en texto plano, tal como lo lee una persona. */
export function renderRecap(recap: ConversationRecap, timeZone: string): string[] {
  if (recap.messages.length === 0) return [];
  const lines = recap.messages.map(message => {
    const time = shortTime(message.at, timeZone);
    return `${time ? `${time} ` : ''}${ROLE_LABELS[message.role]}: ${message.text}`;
  });
  if (recap.truncated) {
    lines.push(
      `(Son los últimos ${recap.messages.length} de ${recap.total_messages} mensajes. `
      + 'Conviene leer la conversación completa antes de responder.)'
    );
  }
  return lines;
}

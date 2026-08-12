/**
 * Enrutado del handoff por tenant (ítem 19).
 *
 * Los IDs de equipo, las etiquetas y el destino de las alertas nunca se
 * codifican en la lógica: se leen de HELIOS_HANDOFF_ROUTING_JSON, con la misma
 * estrategia de caché por texto crudo que tenants/context.ts.
 *
 * Forma esperada:
 * {
 *   "democoi1": {
 *     "teams":  { "reception": "3", "clinical_lead": "4", "helios_support": "5" },
 *     "labels": { "queue": "helios-nuevo", "active": "helios-en-curso",
 *                 "escalated": "helios-escalado",
 *                 "return_requested": "helios-retorno-solicitado",
 *                 "failed": "urgente" },
 *     "attribute_keys": { "case_id": "helios_case_id", "stage": "helios_stage",
 *                         "priority": "helios_clinical_priority" },
 *     "telegram": { "chat_id": "-1001234567890" },
 *     "transition_message": "Te paso con una persona del equipo…"
 *   }
 * }
 *
 * Si un tenant no está configurado se usan los valores por defecto y el handoff
 * sigue funcionando: el estado se persiste, Hermes queda bloqueado, la nota
 * privada se crea y el paciente recibe el mensaje de transición. Solo se pierde
 * la asignación de equipo o la alerta, y eso queda visible en /health.
 */

import { HandoffDestination, HandoffStage } from './stage.js';

export interface HandoffLabels {
  queue: string;
  active: string;
  escalated: string;
  return_requested: string;
  failed: string;
}

export interface HandoffAttributeKeys {
  case_id: string;
  stage: string;
  priority: string;
}

/**
 * Etiquetas de la encuesta de satisfaccion. Van APARTE de HandoffLabels a
 * proposito: son etiquetas DE LA CLINICA, no de Helios. Helios las escribe
 * porque el operador lo pidio, pero NUNCA las retira, y por eso no pueden
 * acabar por descuido en managedLabels(), que es la lista de lo que se limpia.
 */
export interface CsatLabels {
  send: string;
  exclude: string;
}

export interface HandoffRouting {
  tenant_id: string;
  teams: Partial<Record<HandoffDestination, string>>;
  labels: HandoffLabels;
  csat_labels: CsatLabels;
  attribute_keys: HandoffAttributeKeys;
  telegram_chat_id: string | null;
  transition_message: string | null;
}

export const DEFAULT_HANDOFF_LABELS: HandoffLabels = Object.freeze({
  queue: 'helios-nuevo',
  active: 'helios-en-curso',
  escalated: 'helios-escalado',
  return_requested: 'helios-retorno-solicitado',
  // Etiqueta propia, no 'urgente'. Helios solo debe tocar etiquetas suyas: si
  // aplicara una de la clinica no podria distinguir la que puso el de la que puso
  // una persona a mano, y al limpiar borraria trabajo ajeno.
  failed: 'helios-fallo-tecnico'
});

export const DEFAULT_CSAT_LABELS: CsatLabels = Object.freeze({
  send: 'csat-enviar',
  exclude: 'csat-excluir'
});

export const DEFAULT_HANDOFF_ATTRIBUTE_KEYS: HandoffAttributeKeys = Object.freeze({
  case_id: 'helios_case_id',
  stage: 'helios_stage',
  priority: 'helios_clinical_priority'
});

export const DEFAULT_TRANSITION_MESSAGE =
  'Voy a pasar tu caso a una persona del equipo de la clínica. Te responderán por aquí mismo lo antes posible.';

let cachedRaw: string | null = null;
let cachedByTenant = new Map<string, HandoffRouting>();

function normalizedString(value: unknown): string {
  return String(value ?? '').trim();
}

function optionalString(value: unknown): string | null {
  const normalized = normalizedString(value);
  return normalized || null;
}

function buildDefault(tenantId: string): HandoffRouting {
  return {
    tenant_id: tenantId,
    teams: {},
    labels: { ...DEFAULT_HANDOFF_LABELS },
    csat_labels: { ...DEFAULT_CSAT_LABELS },
    attribute_keys: { ...DEFAULT_HANDOFF_ATTRIBUTE_KEYS },
    telegram_chat_id: optionalString(process.env.TELEGRAM_ALERT_CHAT_ID),
    transition_message: null
  };
}

export function parseHandoffRouting(raw: string): Map<string, HandoffRouting> {
  const byTenant = new Map<string, HandoffRouting>();
  const trimmed = normalizedString(raw);
  if (!trimmed) return byTenant;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    console.warn(JSON.stringify({
      event: 'handoff_routing_invalid_json',
      configured_value_present: true
    }));
    return byTenant;
  }

  const entries: Array<[string, any]> = Array.isArray(parsed)
    ? parsed.map((item: any) => [normalizedString(item?.tenant_id), item])
    : Object.entries((parsed ?? {}) as Record<string, unknown>);

  for (const [key, value] of entries) {
    const tenantId = normalizedString(value?.tenant_id ?? key);
    if (!tenantId) continue;

    const base = buildDefault(tenantId);
    const teams: Partial<Record<HandoffDestination, string>> = {};
    for (const destination of ['reception', 'clinical_lead', 'helios_support'] as HandoffDestination[]) {
      const teamId = optionalString(value?.teams?.[destination]);
      if (teamId) teams[destination] = teamId;
    }

    byTenant.set(tenantId, {
      tenant_id: tenantId,
      teams,
      labels: {
        queue: optionalString(value?.labels?.queue) ?? base.labels.queue,
        active: optionalString(value?.labels?.active) ?? base.labels.active,
        escalated: optionalString(value?.labels?.escalated) ?? base.labels.escalated,
        return_requested:
          optionalString(value?.labels?.return_requested) ?? base.labels.return_requested,
        failed: optionalString(value?.labels?.failed) ?? base.labels.failed
      },
      csat_labels: {
        send: optionalString(value?.csat?.send) ?? base.csat_labels.send,
        exclude: optionalString(value?.csat?.exclude) ?? base.csat_labels.exclude
      },
      attribute_keys: {
        case_id: optionalString(value?.attribute_keys?.case_id) ?? base.attribute_keys.case_id,
        stage: optionalString(value?.attribute_keys?.stage) ?? base.attribute_keys.stage,
        priority: optionalString(value?.attribute_keys?.priority) ?? base.attribute_keys.priority
      },
      telegram_chat_id: optionalString(value?.telegram?.chat_id) ?? base.telegram_chat_id,
      transition_message: optionalString(value?.transition_message)
    });
  }

  return byTenant;
}

export function resolveHandoffRouting(tenantId: string): HandoffRouting {
  const json = normalizedString(process.env.HELIOS_HANDOFF_ROUTING_JSON);
  // La clave de caché incluye el chat de Telegram porque es el valor por defecto
  // que usa parseHandoffRouting. Cachear solo por el JSON servía un destino viejo
  // cuando se configuraba TELEGRAM_ALERT_CHAT_ID sin tocar ese JSON.
  const raw = `${json}\0${normalizedString(process.env.TELEGRAM_ALERT_CHAT_ID)}`;
  if (raw !== cachedRaw) {
    cachedByTenant = parseHandoffRouting(json);
    cachedRaw = raw;
  }
  return cachedByTenant.get(normalizedString(tenantId)) ?? buildDefault(normalizedString(tenantId));
}

export function clearHandoffRoutingCache(): void {
  cachedRaw = null;
  cachedByTenant = new Map();
}

/** Etiqueta humana que corresponde a un stage, o null si el stage no marca ninguna. */
export function labelForStage(routing: HandoffRouting, stage: HandoffStage): string | null {
  switch (stage) {
    case 'handoff_requested':
    case 'human_queue':
      return routing.labels.queue;
    case 'human_active':
      return routing.labels.active;
    case 'return_requested':
      return routing.labels.return_requested;
    case 'handoff_failed':
      return routing.labels.failed;
    default:
      return null;
  }
}

/** Todas las etiquetas que gestiona Helios: se retiran al devolver la conversación al bot. */
export function managedLabels(routing: HandoffRouting): string[] {
  return [
    routing.labels.queue,
    routing.labels.active,
    routing.labels.escalated,
    routing.labels.return_requested,
    // La de fallo tecnico TAMBIEN se limpia. Antes se aplicaba y no se quitaba
    // nunca: quedaba pegada a la conversacion para siempre.
    routing.labels.failed
  ];
}

/** Enlace directo a la conversación en Chatwoot para la alerta del equipo. */
export function conversationDeepLink(
  chatwootBaseUrl: string,
  accountId: string,
  conversationId: string
): string {
  const base = normalizedString(chatwootBaseUrl).replace(/\/+$/, '');
  return `${base}/app/accounts/${accountId}/conversations/${conversationId}`;
}

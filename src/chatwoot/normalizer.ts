import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { resolveChatwootAlias } from '../utils/normalizeProfilePatch.js';

export interface NormalizedMessage {
  tenant_id: string;
  provider: string;
  channel: string;
  event: string;
  direction: 'incoming' | 'outgoing';
  direction_source_used: string;
  conversation_id: string;
  contact_id: string;
  inbox_id: string;
  message_id: string;
  source_id: string | null;
  text: string;
  phone: string;
  patient_name: string | null;
  created_at: string;
  trace_id: string;
  should_process: boolean;
  ignore_reason: string | null;
  raw_payload: any;
  signals: {
    possible_frustration: boolean;
    possible_emergency: boolean;
    asks_for_human: boolean;
    asks_for_financing: boolean;
  };
}

export function normalizeChatwootPayload(body: any): NormalizedMessage {
  const event = body.event || 'message_created';
  const conversation = body.conversation || {};
  const contact = body.sender || body.contact || {};
  
  const tenant_id = String(body.account?.id || '1');
  const conversation_id = String(conversation.id || body.conversation_id || '');
  const contact_id = String(contact.id || conversation.contact_inbox?.contact_id || body.contact_id || body.messages?.[0]?.sender_id || '');
  const inbox_id = String(conversation.inbox_id || body.inbox_id || '');
  
  // 1. Resolver y normalizar el número de teléfono con prioridades
  let phone = contact.phone_number || 
              body.meta?.sender?.phone_number || 
              body.sender?.phone_number || 
              body.messages?.[0]?.phone_number ||
              conversation.contact_inbox?.source_id ||
              '';
              
  if (phone && !phone.startsWith('+')) {
    phone = `+${phone}`;
  }

  // 2. Resolver el nombre del paciente con prioridades unificadas
  const patient_name = resolveChatwootAlias(body, contact?.name);

  // 1. Detección robusta de la dirección del mensaje
  let direction: 'incoming' | 'outgoing' = 'outgoing';
  let directionSourceUsed = 'default';

  const rootMessageType = body.message_type;
  const arrayMsgType = body.messages?.[0]?.message_type;
  const arraySenderType = body.messages?.[0]?.sender_type;
  const senderType = contact.type || body.sender?.type;

  // Evaluar las condiciones de ENTRADA en orden de prioridad
  if (rootMessageType === 'incoming') {
    direction = 'incoming';
    directionSourceUsed = 'root.message_type';
  } else if (arrayMsgType === 0) {
    direction = 'incoming';
    directionSourceUsed = 'messages[0].message_type';
  } else if (arraySenderType === 'Contact') {
    direction = 'incoming';
    directionSourceUsed = 'messages[0].sender_type';
  } else if (senderType === 'contact') {
    direction = 'incoming';
    directionSourceUsed = 'sender.type';
  }
  // Evaluar las condiciones de SALIDA para corroboración
  else if (rootMessageType === 'outgoing') {
    direction = 'outgoing';
    directionSourceUsed = 'root.message_type';
  } else if (arrayMsgType === 1) {
    direction = 'outgoing';
    directionSourceUsed = 'messages[0].message_type';
  } else if (arraySenderType === 'User') {
    direction = 'outgoing';
    directionSourceUsed = 'messages[0].sender_type';
  } else if (senderType === 'user') {
    direction = 'outgoing';
    directionSourceUsed = 'sender.type';
  }

  // Extraer el texto del mensaje
  const text = (body.content || body.messages?.[0]?.content || '').trim();

  // Extraer IDs
  const message_id = String(body.id || body.messages?.[0]?.id || '');
  const source_id = body.source_id || body.messages?.[0]?.source_id || null;

  // Lógica de descarte / filtros
  let should_process = true;
  let ignore_reason: string | null = null;

  // Filtro A: Validar si es una nota privada o evento no apto
  const isPrivate = body.private === true || body.messages?.[0]?.private === true;

  if (event !== 'message_created') {
    should_process = false;
    ignore_reason = `Evento de Chatwoot no soportado: ${event}`;
  } else if (direction === 'outgoing') {
    should_process = false;
    ignore_reason = 'Mensaje saliente (outgoing/bot/agente)';
  } else if (isPrivate) {
    should_process = false;
    ignore_reason = 'Mensaje privado o nota interna';
  } else if (!text) {
    should_process = false;
    ignore_reason = 'El cuerpo del mensaje de texto está vacío';
  } else if (!conversation_id) {
    should_process = false;
    ignore_reason = 'conversation_id no presente en el webhook';
  }

  // Detección de señales
  const textLower = text.toLowerCase();
  const asks_for_human = /humano|agente|persona|hablar con alguien|operador/.test(textLower);
  const asks_for_financing = /financiar|financiamiento|cuotas|pago fraccionado|crédito|credito|pagar a plazos/.test(textLower);
  const possible_frustration = /molesto|enfadado|nadie responde|pérdida de tiempo|perdida de tiempo|solucion|queja|mal servicio/.test(textLower);
  const possible_emergency = /respirar|hinchazon|hinchazón|sangro|sangrando|golpe fuerte|urgencia|emergencia|dolor insoportable/.test(textLower);

  const trace_id = body.trace_id || randomUUID();

  return {
    tenant_id,
    provider: 'chatwoot',
    channel: body.meta?.channel || 'whatsapp',
    event,
    direction,
    direction_source_used: directionSourceUsed,
    conversation_id,
    contact_id,
    inbox_id,
    message_id,
    source_id,
    text,
    phone,
    patient_name,
    created_at: body.created_at || body.messages?.[0]?.created_at || new Date().toISOString(),
    trace_id,
    should_process,
    ignore_reason,
    raw_payload: body,
    signals: {
      possible_frustration,
      possible_emergency,
      asks_for_human,
      asks_for_financing
    }
  };
}

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { normalizarAdjuntos, type AdjuntoNormalizado } from './adjuntos.js';
import { resolveChatwootAlias } from '../utils/normalizeProfilePatch.js';
import { resolveTenantContext } from '../tenants/context.js';

export interface NormalizedMessage {
  account_id: string;
  tenant_id: string;
  clinic_id: string;
  hermes_profile: string;
  provider: string;
  channel: string;
  event: string;
  direction: 'incoming' | 'outgoing';
  direction_source_used: string;
  conversation_id: string;
  contact_id: string;
  sender_id: string;
  sender_type: string;
  inbox_id: string;
  message_id: string;
  source_id: string | null;
  text: string;
  /**
   * Los archivos que vinieron con el mensaje, ya clasificados y con su motivo de
   * rechazo si lo hay. Vacío en la inmensa mayoría de mensajes.
   */
  adjuntos: AdjuntoNormalizado[];
  phone: string;
  patient_name: string | null;
  created_at: string;
  trace_id: string;
  should_process: boolean;
  ignore_reason: string | null;
  /**
   * El mensaje tiene la forma de un texto escrito por una persona del equipo en
   * Chatwoot. Es condición necesaria, no suficiente: aún hay que descartar el
   * eco de Helios comprobando el message_id contra helios_chatwoot_outbox.
   */
  human_agent_candidate: boolean;
  is_private: boolean;
  raw_payload: any;
  signals: MessageSignals;
}

export interface MessageSignals {
  possible_frustration: boolean;
  possible_emergency: boolean;
  asks_for_human: boolean;
  asks_for_financing: boolean;
  /** Preguntó cuánto cuesta algo. Es la señal más comercial que hay. */
  asks_for_price: boolean;
}

/**
 * Señales de texto del mensaje del paciente.
 *
 * Pura y exportada a propósito, porque las mismas señales hacen falta en dos
 * sitios: el webhook, que arma el payload para Hermes, y el worker del lote, que
 * deduce el motivo del handoff.
 *
 * IMPORTANTE: no existe columna `signals` en helios_inbound_buffer. El webhook
 * las calcula y se pierden al insertar la fila, así que el worker NO puede
 * heredarlas del mensaje: tiene que recalcularlas sobre el texto consolidado.
 * Cuando esto se pasó por alto, todas las señales llegaban en false y cada
 * derivación salía como «excepción operativa» con prioridad alta.
 */
export function detectSignals(text: unknown): MessageSignals {
  const t = String(text ?? '').toLowerCase();
  return {
    asks_for_human: /humano|agente|persona|hablar con alguien|operador/.test(t),
    asks_for_financing: /financiar|financiamiento|cuotas|pago fraccionado|crédito|credito|pagar a plazos/.test(t),
    possible_frustration: /molesto|enfadado|nadie responde|pérdida de tiempo|perdida de tiempo|solucion|queja|mal servicio/.test(t),
    possible_emergency: /respirar|hinchazon|hinchazón|sangro|sangrando|golpe fuerte|urgencia|emergencia|dolor insoportable/.test(t),
    // PREGUNTAR UN PRECIO ES LA SEÑAL MÁS COMERCIAL QUE HAY, y hasta hoy no dejaba rastro:
    // el interés `treatment` estaba declarado en la política de leads y NADIE lo activaba.
    // Lo vio David probando: cancelo una cita, pregunto el precio de una limpieza, y ese
    // segundo mensaje no genero nada.
    //
    // SE EXIGE «CUANTO» PEGADO A UNA PALABRA DE DINERO. «Cuánto» suelto aparece en «cuanto
    // antes» y «en cuanto pueda», que no preguntan ningún precio; y «vale» suelto es media
    // conversación en español. Mejor perder alguna pregunta que llamar lead a un «vale,
    // gracias».
    asks_for_price: /precio|precios|cu[aá]nto cuesta|cu[aá]nto vale|cu[aá]nto sale|cu[aá]nto es|costo|coste|tarifa|presupuesto|cu[aá]nto me sale|qu[eé] vale/.test(t)
  };
}

export function normalizeChatwootPayload(body: any): NormalizedMessage {
  const event = body.event || 'message_created';
  const conversation = body.conversation || {};
  const contact = body.sender || body.contact || {};
  
  const tenantContext = resolveTenantContext(body.account?.id);
  const account_id = tenantContext.account_id;
  const tenant_id = tenantContext.tenant_id;
  const conversation_id = String(conversation.id || body.conversation_id || '');
  const sender_id = String(body.sender?.id || body.messages?.[0]?.sender_id || '');
  const sender_type = String(body.sender?.type || body.messages?.[0]?.sender_type || '');
  const senderIsIncomingContact = sender_type.toLowerCase() === 'contact'
    || body.message_type === 'incoming'
    || body.messages?.[0]?.message_type === 0;
  const contact_id = String(
    conversation.contact_inbox?.contact_id
    || body.contact_id
    || body.contact?.id
    || body.meta?.sender?.id
    || (senderIsIncomingContact ? sender_id : '')
    || ''
  );
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

  // Y LOS ARCHIVOS. Hasta hoy no se miraban: `attachments` no aparecia en ninguna parte
  // del codigo, asi que una nota de voz -que llega con el cuerpo VACIO y el archivo
  // aqui- se descartaba como «mensaje de texto vacio». Un paciente con dolor mandando
  // una foto de su muela se quedaba sin respuesta y nadie se enteraba.
  //
  // La base de Chatwoot se pasa para poder comprobar que la URL del archivo es SUYA
  // antes de que nadie la descargue. Ver adjuntos.ts: es lo que evita que un webhook
  // falsificado haga que nuestro propio servidor vaya a buscar una direccion interna.
  const adjuntos = normalizarAdjuntos(body, config.CHATWOOT_BASE_URL || '');

  // Extraer IDs
  const message_id = String(body.id || body.messages?.[0]?.id || '');
  const source_id = body.source_id || body.messages?.[0]?.source_id || null;

  // Lógica de descarte / filtros
  let should_process = true;
  let ignore_reason: string | null = null;

  // Filtro A: Validar si es una nota privada o evento no apto
  const isPrivate = body.private === true || body.messages?.[0]?.private === true;

  // ¿Lo escribió el propio Helios por iniciativa propia?
  //
  // El eco de las respuestas normales se descarta buscando el message_id en
  // helios_chatwoot_outbox. Pero el seguimiento de leads NO pasa por el outbox
  // —no nace de ningún lote y la tabla exige uno—, así que su message_id no está
  // allí y Helios leería su propio mensaje como si lo hubiera escrito una persona
  // del equipo: se guardaría con autoría equivocada, ensuciaría el resumen que ve
  // recepción y falsearía el recuento de mensajes del equipo.
  //
  // Por eso el envío va marcado con content_attributes.helios_lead_followup, y
  // aquí se reconoce. Es una marca que pone el propio Gateway al enviar: si
  // alguna vez no llegara de vuelta, el peor caso es el comportamiento anterior.
  const contentAttributes = body.content_attributes
    ?? body.messages?.[0]?.content_attributes
    ?? {};
  const esSeguimientoDeHelios = Boolean(contentAttributes?.helios_lead_followup);

  if (event !== 'message_created') {
    should_process = false;
    ignore_reason = `Evento de Chatwoot no soportado: ${event}`;
  } else if (direction === 'outgoing') {
    should_process = false;
    ignore_reason = 'Mensaje saliente (outgoing/bot/agente)';
  } else if (isPrivate) {
    should_process = false;
    ignore_reason = 'Mensaje privado o nota interna';
  } else if (!text && adjuntos.length === 0) {
    // AQUI ESTABA EL AGUJERO. La condicion era solo `!text`, y una nota de voz o una
    // foto llegan SIN texto: se descartaban en silencio. Ahora un mensaje sin texto
    // pero CON archivos sigue adelante; el archivo se convierte en texto marcado antes
    // de llegar a Hermes, que es quien decide si continua, deriva o pide que se lo
    // escriban.
    should_process = false;
    ignore_reason = 'El mensaje no tiene texto ni archivos';
  } else if (!conversation_id) {
    should_process = false;
    ignore_reason = 'conversation_id no presente en el webhook';
  }

  // ¿Lo escribió una persona del equipo en Chatwoot?
  //
  // Se exige que el tipo de mensaje sea explícitamente saliente: 'outgoing' del
  // normalizador es también el valor por defecto, y con él entrarían los eventos
  // de actividad ("asignada a…", cambios de estado) que Chatwoot publica como
  // message_created. Se excluyen además las notas privadas —entre ellas la del
  // propio handoff— y los mensajes del agent bot.
  const explicitlyOutgoing = rootMessageType === 'outgoing' || arrayMsgType === 1;
  const senderIsAgentBot = sender_type.toLowerCase() === 'agent_bot';
  const human_agent_candidate = event === 'message_created'
    && direction === 'outgoing'
    && explicitlyOutgoing
    && !isPrivate
    && !senderIsAgentBot
    && !esSeguimientoDeHelios
    && Boolean(text)
    && Boolean(conversation_id)
    && Boolean(message_id);

  const { asks_for_human, asks_for_financing, asks_for_price, possible_frustration, possible_emergency } =
    detectSignals(text);

  const trace_id = body.trace_id || randomUUID();

  return {
    account_id,
    tenant_id,
    clinic_id: tenantContext.clinic_id,
    hermes_profile: tenantContext.hermes_profile,
    provider: 'chatwoot',
    channel: body.meta?.channel || 'whatsapp',
    event,
    direction,
    direction_source_used: directionSourceUsed,
    conversation_id,
    contact_id,
    sender_id,
    sender_type,
    inbox_id,
    message_id,
    source_id,
    text,
    phone,
    patient_name,
    created_at: body.created_at || body.messages?.[0]?.created_at || new Date().toISOString(),
    trace_id,
    should_process,
    adjuntos,
    ignore_reason,
    human_agent_candidate,
    is_private: isPrivate,
    raw_payload: body,
    signals: {
      possible_frustration,
      possible_emergency,
      asks_for_human,
      asks_for_financing,
      asks_for_price
    }
  };
}

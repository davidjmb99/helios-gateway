import axios from 'axios';
import { config } from '../config.js';
import { HermesResponse, HermesResponseSchema } from './schema.js';

export async function callHermes(payload: any, traceId: string): Promise<HermesResponse> {
  const tenantId = payload.metadata?.tenant_id || 'unknown';
  const conversationId = payload.metadata?.conversation_id || 'unknown';
  const contactId = payload.metadata?.contact_id || 'unknown';
  const inboxId = payload.metadata?.inbox_id || 'unknown';

  // 1. Caso de Hermes Deshabilitado
  if (!config.HERMES_ENABLED) {
    console.log(`[Hermes Client] HERMES_NOT_CONFIGURED: Hermes está desactivado (HERMES_ENABLED=false).`);
    throw new Error('HERMES_DISABLED');
  }

  // 2. Modo MOCK (Solo si HERMES_MOCK es explícitamente true en entorno de desarrollo)
  if (config.HERMES_MOCK) {
    console.log(`[Hermes Client] MOCKING: Ejecutando en modo mock de desarrollo.`);
    return mockHermesResponse(payload);
  }

  // 3. Validación de URL en producción
  if (!config.HERMES_BASE_URL) {
    console.error(`[Hermes Client] HERMES_NOT_CONFIGURED: Falta definir HERMES_BASE_URL en producción.`);
    throw new Error('HERMES_BASE_URL_MISSING');
  }

  const cleanBaseUrl = config.HERMES_BASE_URL.replace(/\/$/, '');
  const url = `${cleanBaseUrl}${config.HERMES_ENDPOINT}`;

  // Consolidar el mensaje del buffer
  const consolidatedText = payload.message?.text || '';

  // Construcción del payload estructurado solicitado
  const hermesPayload = {
    model: config.HERMES_MODEL,
    messages: [
      {
        role: "user",
        content: consolidatedText
      }
    ],
    metadata: {
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contactId,
      inbox_id: inboxId,
      source: "chatwoot",
      channel: "whatsapp",
      trace_id: traceId
    }
  };

  // Headers recomendados
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-hermes-profile': config.HERMES_PROFILE,
    'x-hermes-session-key': `${tenantId}:${conversationId}:${contactId}`,
    'x-trace-id': traceId
  };

  if (config.HERMES_API_KEY) {
    headers['Authorization'] = `Bearer ${config.HERMES_API_KEY}`;
  }
  if (config.HERMES_CWD) {
    headers['x-hermes-cwd'] = config.HERMES_CWD;
  }
  if (config.HERMES_SOUL_PATH) {
    headers['x-hermes-soul-path'] = config.HERMES_SOUL_PATH;
  }

  console.log(`[Hermes Client] HERMES_CALL_STARTED: Llamando a Hermes real en ${url}`);

  try {
    const response = await axios.post(url, hermesPayload, {
      headers,
      timeout: config.HERMES_TIMEOUT_MS
    });

    console.log(`[Hermes Client] HERMES_CALL_SUCCESS: Respuesta recibida de Hermes.`);

    const responseData = response.data;
    if (!responseData) {
      throw new Error('Respuesta vacía recibida de Hermes.');
    }

    // Extracción jerárquica de la respuesta (abarcando OpenAI-compatible y formato nativo)
    let replyText = '';
    
    if (responseData.reply_text) {
      replyText = responseData.reply_text;
    } else if (responseData.output_text) {
      replyText = responseData.output_text;
    } else if (responseData.reply) {
      replyText = responseData.reply;
    } else if (responseData.message && typeof responseData.message === 'string') {
      replyText = responseData.message;
    } else if (responseData.choices?.[0]?.message?.content) {
      replyText = responseData.choices[0].message.content;
    }

    if (!replyText) {
      console.error('[Hermes Client] Estructura de respuesta inesperada:', JSON.stringify(responseData));
      throw new Error('No se encontró un texto de respuesta válido en la respuesta de Hermes.');
    }

    // Formatear respuesta al esquema HermesResponse esperado por el orquestador
    const normalizedResponse: HermesResponse = {
      route: responseData.route || 'faq',
      intent: responseData.intent || 'general_query',
      reply: replyText,
      handoff_required: responseData.handoff_required || responseData.handoff || false,
      reason: responseData.reason || '',
      state_update: responseData.state_update || undefined,
      tool_calls: responseData.tool_calls || []
    };

    // Validar con Zod
    const parsed = HermesResponseSchema.safeParse(normalizedResponse);
    if (!parsed.success) {
      console.error('[Hermes Client] Estructura de esquema inválida tras normalización:', parsed.error.format());
      throw new Error('Error al normalizar la respuesta de Hermes al esquema de la aplicación.');
    }

    return parsed.data;

  } catch (error: any) {
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      console.error(`[Hermes Client] HERMES_TIMEOUT: Hermes superó el timeout de ${config.HERMES_TIMEOUT_MS}ms.`);
      throw new Error('HERMES_TIMEOUT');
    }
    console.error(`[Hermes Client] HERMES_CALL_FAILED: Error al contactar a Hermes:`, error.message);
    throw error;
  }
}

function mockHermesResponse(payload: any): HermesResponse {
  const text = payload.message?.text || '';
  const name = payload.patient?.name;
  const email = payload.patient?.email;
  const isNew = payload.patient?.is_new;

  if (isNew && (!name || !email)) {
    return {
      route: 'collect_profile',
      intent: 'greeting',
      reply: '¡Hola! Qué gusto saludarte. Veo que es tu primera vez por aquí. Para poder ayudarte de la mejor manera, ¿me podrías indicar tu nombre completo y correo electrónico?',
      handoff_required: false,
      state_update: {
        status: 'collecting_profile',
        pending_question: text,
        missing_fields: ['name', 'email']
      },
      tool_calls: []
    };
  }

  return {
    route: 'faq',
    intent: 'general_query',
    reply: `[MOCK RESPONSE] Hola ${name || 'paciente'}, gracias por tu mensaje: "${text}". Modo desarrollo activo.`,
    handoff_required: false,
    tool_calls: []
  };
}

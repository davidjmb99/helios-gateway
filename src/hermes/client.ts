import axios from 'axios';
import { config } from '../config.js';
import { HermesResponse, HermesResponseSchema } from './schema.js';
import { debugTracker } from '../debug/debug-tracker.js';

export async function callHermes(payload: any, traceId: string): Promise<HermesResponse> {
  const tenantId = payload.metadata?.tenant_id || 'unknown';
  const conversationId = payload.metadata?.conversation_id || 'unknown';
  const contactId = payload.metadata?.contact_id || 'unknown';
  const inboxId = payload.metadata?.inbox_id || 'unknown';
  const phone = payload.patient?.phone || '';

  // 1. Caso de Hermes Deshabilitado
  if (!config.HERMES_ENABLED) {
    console.log(`[Hermes Client] HERMES_NOT_CONFIGURED: Hermes está desactivado (HERMES_ENABLED=false).`);
    const errObj = {
      error_type: 'HERMES_CALL_SKIPPED',
      reason: 'Hermes está deshabilitado en las variables de entorno (HERMES_ENABLED=false).'
    };
    debugTracker.updateEvent(traceId, { hermesResponse: errObj });
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
    const errObj = {
      error_type: 'HERMES_CALL_SKIPPED',
      reason: 'Falta configurar HERMES_BASE_URL en las variables de entorno de producción.'
    };
    debugTracker.updateEvent(traceId, { hermesResponse: errObj });
    throw new Error('HERMES_BASE_URL_MISSING');
  }

  const cleanBaseUrl = config.HERMES_BASE_URL.replace(/\/$/, '');
  const url = `${cleanBaseUrl}${config.HERMES_ENDPOINT}`;

  const consolidatedText = payload.message?.text || '';
  const isNew = payload.patient?.is_new || false;
  const missing = isNew ? ["first_name", "last_name", "email"] : [];

  // 4. Preparación del cuerpo OpenAI-Compatible
  let requestBody: any;
  if (config.HERMES_ENDPOINT.includes('/v1/chat/completions')) {
    requestBody = {
      model: config.HERMES_MODEL,
      messages: [
        {
          role: "system",
          content: `Eres Hermes, el asistente de Inteligencia Artificial para el Centro Odontológico Integral (Helios). 
Tu misión en este momento es gestionar la conversación. 
Regla de oro: Si el paciente es nuevo (is_new: true) o faltan sus datos básicos de identidad, debes solicitar amablemente su Nombre, Apellido y Correo electrónico. NO debes solicitar el teléfono ya que disponemos de él. NO intentes agendar citas ni utilices herramientas de agenda hasta que el perfil de identidad esté completo.`
        },
        {
          role: "user",
          content: `Mensaje del paciente: ${consolidatedText}\n\nContexto: Paciente Nuevo: ${isNew}. Faltan campos: ${JSON.stringify(missing)}. Teléfono: ${phone}.`
        }
      ],
      metadata: {
        trace_id: traceId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        contact_id: contactId,
        phone: phone,
        patient_is_new: isNew,
        missing_fields: missing
      }
    };
  } else {
    // Si no es endpoint compatible con OpenAI, mandamos el payload nativo limpio
    requestBody = {
      ...payload,
      model: config.HERMES_MODEL
    };
  }

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
    const response = await axios.post(url, requestBody, {
      headers,
      timeout: config.HERMES_TIMEOUT_MS
    });

    console.log(`[Hermes Client] HERMES_CALL_SUCCESS: Respuesta recibida de Hermes.`);

    const responseData = response.data;
    if (!responseData) {
      throw new Error('HERMES_RESPONSE_EMPTY');
    }

    // Extracción jerárquica de la respuesta
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
      throw new Error('HERMES_RESPONSE_EMPTY');
    }

    // Formatear respuesta al esquema HermesResponse esperado por el orquestador
    const normalizedResponse: HermesResponse = {
      route: responseData.route || (isNew ? 'collect_profile' : 'faq'),
      intent: responseData.intent || (isNew ? 'collect_patient_identity' : 'general_query'),
      reply: replyText,
      handoff_required: responseData.handoff_required || responseData.handoff || false,
      reason: responseData.reason || '',
      state_update: responseData.state_update || {
        status: isNew ? 'collecting_profile' : 'active',
        missing_fields: isNew ? ['first_name', 'last_name', 'email'] : []
      },
      tool_calls: responseData.tool_calls || []
    };

    // Validar con Zod
    const parsed = HermesResponseSchema.safeParse(normalizedResponse);
    if (!parsed.success) {
      console.error('[Hermes Client] Estructura de esquema inválida tras normalización:', parsed.error.format());
      throw new Error('Error al normalizar la respuesta de Hermes al esquema de la aplicación.');
    }

    // Almacenar respuesta correcta detallada para depuración
    const debugResponseObj = {
      status: response.status,
      reply_text: replyText,
      body: responseData
    };
    debugTracker.updateEvent(traceId, { hermesResponse: debugResponseObj });

    return parsed.data;

  } catch (error: any) {
    let errorDetail: any;

    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        console.error(`[Hermes Client] HERMES_TIMEOUT: Hermes superó el timeout de ${config.HERMES_TIMEOUT_MS}ms.`);
        errorDetail = {
          error_type: 'HERMES_TIMEOUT',
          timeout_ms: config.HERMES_TIMEOUT_MS,
          message: error.message
        };
        debugTracker.updateEvent(traceId, { hermesResponse: errorDetail });
        throw new Error('HERMES_TIMEOUT');
      }
      
      if (error.response) {
        // El servidor respondió con código de estado fuera de 2xx
        errorDetail = {
          error_type: 'HERMES_HTTP_ERROR',
          status: error.response.status,
          response: error.response.data,
          headers: {
            'content-type': error.response.headers['content-type'],
            'date': error.response.headers['date']
          },
          message: error.message
        };
      } else {
        // La petición se realizó pero no se recibió respuesta (Error de red)
        errorDetail = {
          error_type: 'HERMES_NETWORK_ERROR',
          code: error.code || 'UNKNOWN',
          message: error.message
        };
      }
    } else {
      // Error genérico o interno
      errorDetail = {
        error_type: 'HERMES_INTERNAL_ERROR',
        message: error.message
      };
    }

    debugTracker.updateEvent(traceId, { hermesResponse: errorDetail });
    throw error;
  }
}

function mockHermesResponse(payload: any): HermesResponse {
  const text = payload.message?.text || '';
  const isNew = payload.patient?.is_new;

  if (isNew) {
    return {
      route: 'collect_profile',
      intent: 'collect_patient_identity',
      reply: '¡Hola! Gracias por escribir al Centro Odontológico Integral. Para ayudarte mejor, ¿me indicas por favor tu nombre, apellido y correo electrónico?',
      handoff_required: false,
      state_update: {
        status: 'collecting_profile',
        pending_question: text,
        missing_fields: ['first_name', 'last_name', 'email']
      },
      tool_calls: []
    };
  }

  return {
    route: 'faq',
    intent: 'general_query',
    reply: `[MOCK RESPONSE] Modo desarrollo activo.`,
    handoff_required: false,
    tool_calls: []
  };
}

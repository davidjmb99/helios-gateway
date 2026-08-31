import axios from 'axios';
import { leerContextoDeClinica } from '../tenants/settings.js';
import { config } from '../config.js';
import { HermesResponse, HermesResponseSchema } from './schema.js';
import { debugTracker } from '../debug/debug-tracker.js';

export function normalizeHermesToolCalls(toolCalls: unknown): HermesResponse['tool_calls'] {
  if (!Array.isArray(toolCalls)) return [];

  const normalized: HermesResponse['tool_calls'] = [];
  for (const call of toolCalls) {
    const name = typeof call?.name === 'string' && call.name.trim()
      ? call.name.trim()
      : typeof call?.tool === 'string' && call.tool.trim()
        ? call.tool.trim()
        : null;

    if (!name) continue;

    normalized.push({
      name,
      arguments: call?.arguments ?? {},
      status: call?.status ?? null,
      duration_ms: call?.duration_ms ?? null,
      result_code: call?.result_code ?? null
    });
  }

  return normalized;
}

export async function callHermes(payload: any, traceId: string): Promise<HermesResponse> {
  const accountId = payload.account_id || '';
  const tenantId = payload.tenant_id || '';
  const clinicId = payload.clinic_id || '';
  const hermesProfile = payload.hermes_profile || '';
  const conversationId = payload.conversation?.conversation_id || '';
  const contactId = payload.conversation?.contact_id || '';
  const inboxId = payload.conversation?.inbox_id || '';
  const phone = payload.patient?.phone || '';

  if (!accountId || !tenantId || !clinicId || !hermesProfile) {
    throw new Error('TENANT_NOT_CONFIGURED');
  }

  // El horario y el tono de ESTA clínica, para el contexto que viaja a Hermes. Con
  // captura: un ajuste que no se puede leer no puede impedir contestarle a un
  // paciente, así que en el peor caso el turno va sin este contexto extra.
  let clinicHours: unknown = null;
  let clinicTone: string | null = null;
  let clinicTimezone = config.CLINIC_TIMEZONE;
  try {
    const ajustes = await leerContextoDeClinica(tenantId);
    clinicHours = ajustes.horario;
    clinicTone = ajustes.tono;
    clinicTimezone = ajustes.zona;
  } catch {
    /* se sigue sin contexto de clínica */
  }

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
  // SIN CORREO. Se pedia para que Cal.com mandara la confirmacion de la cita; Cal.com ya
  // no esta y Google Calendar no manda ningun correo. Pedirlo aqui hacia que Helios lo
  // reclamase «para enviarle la confirmacion» y despues tuviera que desdecirse.
  const missing = isNew ? ["first_name", "last_name"] : [];

  // 4. El cuerpo que se manda al Adapter.
  //
  // AQUI HABIA UNA RAMA MUERTA Y PELIGROSA. Si el endpoint contenia
  // «/v1/chat/completions», se construia un cuerpo estilo OpenAI con un prompt de
  // sistema escrito a mano —con «Centro Odontologico Integral» dentro, o sea el
  // nombre de UNA clinica en un producto multiclinica—. El Adapter no expone esa
  // ruta: solo tiene /helios/message. Asi que esa rama no podia funcionar con
  // nadie, y ademas era el VALOR POR DEFECTO de ADAPTER_ENDPOINT: bastaba con no
  // definir la variable para que el Gateway mandara un cuerpo que el Adapter no
  // entiende.
  //
  // Y se llevaba otra cosa por delante: el contexto de la clinica -horario y tono-
  // solo se añadia en esa rama. En produccion nunca viajaba, asi que la pantalla de
  // Ajustes guardaba un horario que no llegaba a ningun sitio. Ahora va dentro de
  // clinic_context, que lo construye el orquestador con los ajustes de la clinica.
  //
  // Se manda el payload nativo y ya. Una sola forma, la que funciona.
  const requestBody = {
    ...payload,
    model: config.HERMES_MODEL
  };

  // Headers recomendados
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-hermes-profile': hermesProfile,
    'x-hermes-session-key': `${tenantId}:${hermesProfile}:${conversationId}:${contactId}`,
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
      timeout: config.HERMES_TIMEOUT_MS,
      validateStatus: function (status) {
        return (status >= 200 && status < 300) || status === 422 || status === 502;
      }
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
    } else if (responseData.reply) {
      replyText = responseData.reply;
    } else if (responseData.output_text) {
      replyText = responseData.output_text;
    } else if (responseData.message && typeof responseData.message === 'string') {
      replyText = responseData.message;
    } else if (responseData.choices?.[0]?.message?.content) {
      replyText = responseData.choices[0].message.content;
      try {
        const parsed = JSON.parse(replyText);
        if (parsed.reply_text) replyText = parsed.reply_text;
        else if (parsed.reply) replyText = parsed.reply;
      } catch (e) {}
    }

    const isErrorRoute = responseData.route === 'error' || responseData.ok === false;
    
    if (!replyText && !isErrorRoute) {
      console.error('[Hermes Client] Estructura de respuesta inesperada:', {
        response_keys: typeof responseData === 'object' ? Object.keys(responseData) : [],
        trace_id: traceId
      });
      throw new Error('HERMES_RESPONSE_EMPTY');
    }

    // Detectar si la estructura de respuesta proviene del adapter
    const isAdapterShape = responseData.ok === true && responseData.reply !== undefined;
    if (isAdapterShape) {
      console.log(`[Hermes Client] Detected adapter response shape (ok + reply) for trace ${traceId}`);
    }

    const normalizedToolCalls = normalizeHermesToolCalls(responseData.tool_calls);

    // Formatear respuesta al esquema HermesResponse esperado por el orquestador
    const normalizedResponse: HermesResponse = {
      request_key: responseData.request_key || null,
      ok: responseData.ok,
      route: responseData.route || (isNew ? 'collect_profile' : 'faq'),
      intent: responseData.intent || (isNew ? 'collect_patient_identity' : 'general_query'),
      decision: responseData.decision || (isNew ? 'identity_required' : 'processed'),
      reply: replyText,
      reply_text: replyText,
      message_for_client: responseData.message_for_client,
      safe_to_send: responseData.safe_to_send !== false,
      // Booleano de verdad: el contrato del ítem 17 manda handoff como OBJETO, y
      // colarlo aquí hacía fallar la validación Zod y con ella el turno entero.
      handoff_required: Boolean(
        responseData.requires_handoff
        || responseData.handoff_required
        || responseData.handoff
        || responseData.decision === 'needs_handoff'
      ),
      handoff: typeof responseData.handoff === 'object' && responseData.handoff !== null
        ? responseData.handoff
        : null,
      reason: responseData.reason || '',
      profile_patch: responseData.profile_patch || responseData.patient_profile_update || null,
      state_patch: responseData.state_patch || responseData.state_update || null,
      booking_patch: responseData.booking_patch || null,
      operation: responseData.operation || null,
      tool_calls: normalizedToolCalls,
      error_code: responseData.error_code,
      recoverable: responseData.recoverable
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

    // Logs seguros requeridos por regla del problema 1
    console.log(`[Hermes Client] HERMES_RESPONSE_METADATA:`, JSON.stringify({
      hermes_final_url: url,
      hermes_response_status: response.status,
      hermes_response_shape: isAdapterShape ? "adapter_reply" : "standard_reply",
      trace_id: traceId
    }));

    return parsed.data;

  } catch (error: any) {
    let errorDetail: any = {};
    
    if (axios.isAxiosError(error)) {
      const redirectLocation = error.response?.headers?.location || '';
      
      if (error.code === 'ECONNABORTED') {
        console.error(`[Hermes Client] HERMES_TIMEOUT: Hermes superó el timeout de ${config.HERMES_TIMEOUT_MS}ms.`);
        errorDetail = {
          error_type: 'HERMES_TIMEOUT',
          hermes_base_url: config.HERMES_BASE_URL,
          hermes_endpoint: config.HERMES_ENDPOINT,
          final_url: url,
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
          hermes_base_url: config.HERMES_BASE_URL,
          hermes_endpoint: config.HERMES_ENDPOINT,
          final_url: url,
          status: error.response.status,
          redirect_location: redirectLocation,
          response: error.response.data,
          headers: {
            'content-type': error.response.headers['content-type'],
            'date': error.response.headers['date'],
            'location': redirectLocation
          },
          message: error.message
        };
      } else {
        // La petición se realizó pero no se recibió respuesta (Error de red/redirecciones excedidas)
        errorDetail = {
          error_type: 'HERMES_NETWORK_ERROR',
          hermes_base_url: config.HERMES_BASE_URL,
          hermes_endpoint: config.HERMES_ENDPOINT,
          final_url: url,
          code: error.code || 'UNKNOWN',
          redirect_location: error.config?.url !== url ? error.config?.url : '',
          message: error.message
        };
      }
    } else {
      // Error genérico o interno
      errorDetail = {
        error_type: 'HERMES_INTERNAL_ERROR',
        hermes_base_url: config.HERMES_BASE_URL,
        hermes_endpoint: config.HERMES_ENDPOINT,
        final_url: url,
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
      decision: 'identity_required',
      // SIN EL NOMBRE DE NINGUNA CLINICA. Aqui decia «Centro Odontologico Integral»
      // -una clinica concreta en un producto multiclinica-. Es la respuesta simulada
      // (ADAPTER_MOCK), asi que no llegaba a un paciente, pero es exactamente el error
      // que ya se corrigio en la rama de produccion de este mismo archivo.
      reply: '¡Hola! Gracias por escribir. Para ayudarle mejor, ¿me indica por favor su nombre y apellido?',
      handoff_required: false,
      state_update: {
        status: 'collecting_profile',
        pending_question: text,
        missing_fields: ['first_name', 'last_name']
      },
      tool_calls: []
    };
  }

  return {
    route: 'faq',
    intent: 'general_query',
    decision: 'processed',
    reply: `[MOCK RESPONSE] Modo desarrollo activo.`,
    handoff_required: false,
    tool_calls: []
  };
}

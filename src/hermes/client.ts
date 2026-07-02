import axios from 'axios';
import { config } from '../config.js';
import { HermesResponse, HermesResponseSchema } from './schema.js';

export async function callHermes(payload: any, traceId: string): Promise<HermesResponse> {
  const url = config.HERMES_WEBHOOK_URL;
  const apiKey = config.HERMES_API_KEY;

  if (!url) {
    console.log(`[Hermes Client] MOCKING: No se especificó HERMES_WEBHOOK_URL. Usando respuesta mock.`);
    return mockHermesResponse(payload);
  }

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'x-trace-id': traceId
      },
      timeout: 10000 // 10s
    });

    const parsed = HermesResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      console.error('[Hermes Client] Estructura inválida retornada por Hermes:', parsed.error.format());
      throw new Error('Estructura de respuesta inválida de Hermes');
    }
    return parsed.data;
  } catch (error: any) {
    console.error('[Hermes Client] Error llamando a Hermes:', error.message);
    throw error;
  }
}

function mockHermesResponse(payload: any): HermesResponse {
  const text = payload.message?.text || '';
  const name = payload.patient?.name;
  const email = payload.patient?.email;
  const isNew = payload.patient?.is_new;

  // CASO 1: Paciente Nuevo (Faltan datos)
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

  // CASO 3 & 4: Handoff a humano
  if (payload.signals?.asks_for_human || payload.signals?.possible_frustration) {
    return {
      route: 'handoff',
      intent: 'request_human',
      reply: 'Entiendo perfectamente tu solicitud. En este momento te estoy transfiriendo con un agente humano de nuestro equipo clínico para atenderte personalmente. Te responderemos en breve.',
      handoff_required: true,
      reason: 'Paciente solicita hablar con un humano o muestra frustración.',
      state_update: {
        status: 'human_assigned',
        human_handoff_active: true
      },
      tool_calls: [
        {
          name: 'chatwoot.create_private_note',
          arguments: { content: '⚠️ El paciente ha sido derivado a atención humana por solicitud o detección de molestia.' }
        },
        {
          name: 'chatwoot.add_labels',
          arguments: { labels: ['handoff-ia', 'atencion-urgente'] }
        },
        {
          name: 'chatwoot.assign_human',
          arguments: {}
        },
        {
          name: 'state.update',
          arguments: {
            ai_enabled: false,
            human_handoff_active: true
          }
        }
      ]
    };
  }

  // CASO 5: Financiamiento
  if (payload.signals?.asks_for_financing) {
    return {
      route: 'financing',
      intent: 'ask_financing',
      reply: 'Claro, en nuestra clínica contamos con cómodos planes de financiación a tu medida. ¿Para qué tratamiento deseas solicitar la financiación y qué monto aproximado necesitas?',
      handoff_required: false,
      tool_calls: []
    };
  }

  // CASO GENERAL: FAQ / Respuesta estándar
  return {
    route: 'faq',
    intent: 'general_query',
    reply: `Hola ${name || 'paciente'}, gracias por tu mensaje: "${text}". He recibido tu consulta correctamente.`,
    handoff_required: false,
    tool_calls: []
  };
}

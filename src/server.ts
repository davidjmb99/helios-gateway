import fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { normalizeChatwootPayload } from './chatwoot/normalizer.js';
import { idempotencyRepository, stateRepository, logsRepository } from './repositories/database.js';
import { supabase } from './supabase/client.js';
import { bufferService } from './buffer/buffer-service.js';
import { processBufferEvent } from './orchestrator.js';
import { debugTracker } from './debug/debug-tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
});

server.register(formbody);

// Registramos el soporte para servir la carpeta de archivos estáticos 'public'
server.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
  prefix: '/', 
});

// Inicializamos el callback del buffer para conectar con el orquestador
bufferService.setCallback(async (tenantId, conversationId, traceId) => {
  await processBufferEvent(tenantId, conversationId, traceId);
});

// Contadores en memoria para estadísticas del Dashboard
let totalWebhooksReceived = 0;
let totalMessagesProcessed = 0;
let totalEventsIgnored = 0;

// 1. GET /
// Servimos el archivo index.html para la ruta raíz
server.get('/', async (request, reply) => {
  return reply.sendFile('index.html');
});

// 2. GET /health
server.get('/health', async (request, reply) => {
  return {
    ok: true,
    service: 'helios-gateway',
    version: '0.1.0',
    hermesMode: config.HERMES_WEBHOOK_URL ? 'PRODUCTION' : 'MOCK'
  };
});

// Endpoint para obtener estadísticas del Gateway
server.get('/admin/stats', async (request, reply) => {
  return {
    status: 'online',
    webhookUrl: '/webhooks/chatwoot',
    totalWebhooksReceived,
    totalMessagesProcessed,
    totalEventsIgnored,
    hermesMode: config.HERMES_WEBHOOK_URL ? 'PRODUCTION' : 'MOCK'
  };
});

// Endpoint para obtener eventos detallados de depuración
server.get('/admin/debug/events', async (request, reply) => {
  const query = request.query as any;
  const conversation_id = query.conversation_id || undefined;
  const decision = query.decision || undefined;
  const onlyErrors = query.onlyErrors === 'true';

  return debugTracker.getEvents({ conversation_id, decision, onlyErrors });
});

// Endpoint para limpiar la lista de depuración
server.post('/admin/debug/clear', async (request, reply) => {
  debugTracker.clear();
  return { ok: true };
});

// Endpoint para el Dashboard: Obtener los últimos 20 logs desde Supabase
server.get('/admin/logs', async (request, reply) => {
  try {
    const { data, error } = await supabase
      .from('helios_gateway_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
      
    if (error) throw error;
    return data || [];
  } catch (error: any) {
    return reply.status(500).send({ error: error.message });
  }
});

// 3. POST /webhooks/chatwoot
server.post('/webhooks/chatwoot', async (request, reply) => {
  totalWebhooksReceived++;
  const payload = request.body as any;
  
  try {
    const normalized = normalizeChatwootPayload(payload);

    // Registrar evento inicial en el tracker de depuración
    debugTracker.addEvent({
      trace_id: normalized.trace_id,
      conversation_id: normalized.conversation_id,
      contact_id: normalized.contact_id,
      timestamp: normalized.created_at,
      event: normalized.event,
      message_type: normalized.direction,
      text: normalized.text,
      phone: normalized.phone,
      patient_name: normalized.patient_name || 'Paciente',
      decision: normalized.should_process ? 'accepted' : 'ignored',
      normalizedPayload: normalized
    });

    // Si no debe ser procesado (ej: mensaje saliente, evento secundario, etc.)
    if (!normalized.should_process) {
      totalEventsIgnored++;
      server.log.debug({ reason: normalized.ignore_reason }, 'Evento de Chatwoot ignorado');
      
      debugTracker.addTimelineStep(normalized.trace_id, 'action_executed', { action: 'ignored', reason: normalized.ignore_reason });
      
      // Registrar en logs que el evento fue ignorado
      if (normalized.conversation_id) {
        await logsRepository.save({
          trace_id: normalized.trace_id,
          tenant_id: normalized.tenant_id,
          conversation_id: normalized.conversation_id,
          contact_id: normalized.contact_id,
          event_type: 'event_ignored',
          metadata: { ignore_reason: normalized.ignore_reason, event: normalized.event }
        });
      }
      return reply.status(200).send({ ok: true, status: 'ignored', reason: normalized.ignore_reason });
    }

    // 3. Idempotencia: Verificar si ya procesamos este mensaje
    const isDuplicate = await idempotencyRepository.check(normalized.tenant_id, normalized.provider, normalized.message_id);
    if (isDuplicate) {
      totalEventsIgnored++;
      server.log.warn({ message_id: normalized.message_id }, 'Mensaje duplicado detectado, ignorando.');
      
      debugTracker.updateEvent(normalized.trace_id, { decision: 'duplicate' });
      debugTracker.addTimelineStep(normalized.trace_id, 'error', { message: 'Mensaje duplicado detectado por el módulo de idempotencia.' });

      await logsRepository.save({
        trace_id: normalized.trace_id,
        tenant_id: normalized.tenant_id,
        conversation_id: normalized.conversation_id,
        contact_id: normalized.contact_id,
        event_type: 'duplicate_message',
        metadata: { message_id: normalized.message_id }
      });
      return reply.status(200).send({ ok: true, status: 'duplicate' });
    }

    totalMessagesProcessed++;
    
    // Actualizar estado del tracker
    debugTracker.updateEvent(normalized.trace_id, { decision: 'buffered' });
    debugTracker.addTimelineStep(normalized.trace_id, 'buffer_waiting', { timeout: '5000ms' });

    // Registrar en logs el webhook recibido de forma exitosa
    await logsRepository.save({
      trace_id: normalized.trace_id,
      tenant_id: normalized.tenant_id,
      conversation_id: normalized.conversation_id,
      contact_id: normalized.contact_id,
      event_type: 'webhook_received',
      metadata: { message_id: normalized.message_id, body: normalized.text }
    });

    // Registrar como procesado en la tabla de idempotencia
    await idempotencyRepository.markProcessed(
      normalized.tenant_id,
      normalized.provider,
      normalized.message_id,
      normalized.conversation_id,
      normalized.trace_id
    );

    // 4. Agregar el mensaje al buffer (espera activa de 5s)
    await bufferService.addMessage(normalized);
    server.log.info({ conversation_id: normalized.conversation_id }, 'Mensaje ingresado al buffer.');

    await logsRepository.save({
      trace_id: normalized.trace_id,
      tenant_id: normalized.tenant_id,
      conversation_id: normalized.conversation_id,
      contact_id: normalized.contact_id,
      event_type: 'message_buffered',
      metadata: { body: normalized.text }
    });

    // 202 Aceptado: Liberamos a Chatwoot rápido antes de que se cumpla el buffer de 5s
    return reply.status(202).send({ ok: true, status: 'buffered', trace_id: normalized.trace_id });

  } catch (error: any) {
    server.log.error(error, 'Error procesando webhook de Chatwoot');
    return reply.status(500).send({ ok: false, error: error.message });
  }
});

// 3. POST /test/chatwoot-message (Simulación de Chatwoot)
server.post('/test/chatwoot-message', async (request, reply) => {
  const body = request.body as any;
  const mockPayload = {
    event: 'message_created',
    account: { id: body.tenant_id || '2' },
    conversation: {
      id: body.conversation_id || '23',
      contact_inbox: { contact_id: body.contact_id || '7' },
      inbox_id: body.inbox_id || '7'
    },
    sender: {
      id: body.contact_id || '7',
      name: body.name || null,
      email: body.email || null,
      phone_number: body.phone || '+584121234567'
    },
    message: {
      id: body.message_id || `msg_${Date.now()}`,
      message_type: 'incoming',
      content: body.text || 'Hola, quiero información sobre limpieza',
      created_at: new Date().toISOString()
    }
  };

  // Redirigimos el payload simulado directamente al endpoint del webhook
  const response = await server.inject({
    method: 'POST',
    url: '/webhooks/chatwoot',
    payload: mockPayload
  });

  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
});

// 4. POST /admin/reactivate-ai
server.post('/admin/reactivate-ai', async (request, reply) => {
  const { tenant_id, conversation_id } = request.body as any;
  if (!tenant_id || !conversation_id) {
    return reply.status(400).send({ error: 'tenant_id y conversation_id son obligatorios.' });
  }

  await stateRepository.upsert({
    tenant_id,
    conversation_id,
    contact_id: 'unknown',
    inbox_id: 'unknown',
    ai_enabled: true,
    human_handoff_active: false
  });

  return { ok: true, ai_enabled: true, message: 'IA reactivada correctamente para la conversación.' };
});

// 5. POST /admin/disable-ai
server.post('/admin/disable-ai', async (request, reply) => {
  const { tenant_id, conversation_id } = request.body as any;
  if (!tenant_id || !conversation_id) {
    return reply.status(400).send({ error: 'tenant_id y conversation_id son obligatorios.' });
  }

  await stateRepository.upsert({
    tenant_id,
    conversation_id,
    contact_id: 'unknown',
    inbox_id: 'unknown',
    ai_enabled: false
  });

  return { ok: true, ai_enabled: false, message: 'IA desactivada / pausada para la conversación.' };
});

const start = async () => {
  try {
    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    server.log.info(`Servidor escuchando en http://localhost:${config.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();

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

// Endpoint de Autenticación
server.post('/api/auth/login', async (request, reply) => {
  const { username, password } = request.body as any;
  if (!username || !password) {
    return reply.status(400).send({ error: 'Usuario y contraseña son requeridos.' });
  }

  try {
    // Buscar la clínica por el username
    const { data: tenant, error } = await supabase
      .from('helios_tenants')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !tenant) {
      return reply.status(401).send({ error: 'Credenciales inválidas.' });
    }

    // Para la demo, comparación directa del password
    if (tenant.password_hash !== password) {
      return reply.status(401).send({ error: 'Credenciales inválidas.' });
    }

    // Retornamos el token (usamos el tenant_id como token para simplicidad en la demo)
    return {
      ok: true,
      token: tenant.tenant_id,
      tenant: {
        tenant_id: tenant.tenant_id,
        name: tenant.name,
        username: tenant.username
      }
    };
  } catch (err: any) {
    return reply.status(500).send({ error: err.message });
  }
});

// Función de validación de seguridad a nivel de petición
async function checkAuth(request: any, reply: any) {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    reply.status(401).send({ error: 'No autorizado. Token faltante.' });
    throw new Error('Unauthorized');
  }

  const token = authHeader.replace('Bearer ', '').trim();
  
  // Validamos si el token corresponde a un tenant registrado en la DB
  const { data: tenant, error } = await supabase
    .from('helios_tenants')
    .select('tenant_id')
    .eq('tenant_id', token)
    .single();

  if (error || !tenant) {
    reply.status(401).send({ error: 'Token inválido o expirado.' });
    throw new Error('Unauthorized');
  }

  return tenant.tenant_id; // Retorna el tenant_id validado
}

// Endpoint para obtener estadísticas del Gateway filtradas por Tenant
server.get('/admin/stats', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);

  // Obtener estadísticas de Supabase filtradas por tenant_id
  const { count: receivedCount } = await supabase
    .from('helios_gateway_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  const { count: ignoredCount } = await supabase
    .from('helios_gateway_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('event_type', 'event_ignored');

  return {
    status: 'online',
    webhookUrl: `/webhooks/chatwoot/${tenantId}`,
    totalWebhooksReceived: receivedCount || 0,
    totalMessagesProcessed: (receivedCount || 0) - (ignoredCount || 0),
    totalEventsIgnored: ignoredCount || 0,
    hermesMode: config.HERMES_WEBHOOK_URL ? 'PRODUCTION' : 'MOCK'
  };
});

// Endpoint para obtener eventos detallados de depuración filtrados por Tenant
server.get('/admin/debug/events', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  const query = request.query as any;
  const conversation_id = query.conversation_id || undefined;
  const decision = query.decision || undefined;
  const onlyErrors = query.onlyErrors === 'true';

  // Obtenemos los eventos y filtramos por tenant_id para asegurar la separación de datos
  const events = debugTracker.getEvents({ conversation_id, decision, onlyErrors });
  return events.filter(e => e.normalizedPayload?.tenant_id === tenantId);
});

// Endpoint para limpiar la lista de depuración
server.post('/admin/debug/clear', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  // Limpia del tracker los eventos correspondientes a este tenant
  debugTracker.clearTenant(tenantId);
  return { ok: true };
});

// Endpoint para el Dashboard: Obtener los últimos 20 logs de Supabase filtrados por el Tenant
server.get('/admin/logs', async (request, reply) => {
  try {
    const tenantId = await checkAuth(request, reply);
    const { data, error } = await supabase
      .from('helios_gateway_logs')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(20);
      
    if (error) throw error;
    return data || [];
  } catch (error: any) {
    return reply.status(500).send({ error: error.message });
  }
});

// Helper interno para procesar webhook
async function handleChatwootWebhook(payload: any, urlTenantId: string | undefined, log: any) {
  const normalized = normalizeChatwootPayload(payload);
  
  // Si vino el tenant_id en la ruta del webhook, forzarlo en el normalized
  if (urlTenantId) {
    normalized.tenant_id = urlTenantId;
  }

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
    log.debug({ reason: normalized.ignore_reason }, 'Evento de Chatwoot ignorado');
    debugTracker.addTimelineStep(normalized.trace_id, 'action_executed', { action: 'ignored', reason: normalized.ignore_reason });
    
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
    return { ok: true, status: 'ignored', reason: normalized.ignore_reason };
  }

  // Idempotencia: Verificar si ya procesamos este mensaje
  const isDuplicate = await idempotencyRepository.check(normalized.tenant_id, normalized.provider, normalized.message_id);
  if (isDuplicate) {
    log.warn({ message_id: normalized.message_id }, 'Mensaje duplicado detectado, ignorando.');
    
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
    return { ok: true, status: 'duplicate' };
  }
  
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

  // Agregar el mensaje al buffer (espera activa de 5s)
  await bufferService.addMessage(normalized);
  log.info({ conversation_id: normalized.conversation_id }, 'Mensaje ingresado al buffer.');

  await logsRepository.save({
    trace_id: normalized.trace_id,
    tenant_id: normalized.tenant_id,
    conversation_id: normalized.conversation_id,
    contact_id: normalized.contact_id,
    event_type: 'message_buffered',
    metadata: { body: normalized.text }
  });

  return { ok: true, status: 'buffered', trace_id: normalized.trace_id };
}

// POST /webhooks/chatwoot
server.post('/webhooks/chatwoot', async (request, reply) => {
  const payload = request.body as any;
  try {
    const result = await handleChatwootWebhook(payload, undefined, server.log);
    if (result.status === 'buffered') {
      return reply.status(202).send(result);
    }
    return reply.status(200).send(result);
  } catch (error: any) {
    server.log.error(error, 'Error procesando webhook de Chatwoot');
    return reply.status(500).send({ ok: false, error: error.message });
  }
});

// POST /webhooks/chatwoot/:tenant_id
server.post('/webhooks/chatwoot/:tenant_id', async (request, reply) => {
  const { tenant_id } = request.params as any;
  const payload = request.body as any;
  try {
    const result = await handleChatwootWebhook(payload, tenant_id, server.log);
    if (result.status === 'buffered') {
      return reply.status(202).send(result);
    }
    return reply.status(200).send(result);
  } catch (error: any) {
    server.log.error(error, 'Error procesando webhook de Chatwoot');
    return reply.status(500).send({ ok: false, error: error.message });
  }
});

// Simulación de Chatwoot
server.post('/test/chatwoot-message', async (request, reply) => {
  const body = request.body as any;
  const targetTenant = body.tenant_id || 'democoi1';
  
  const mockPayload = {
    event: 'message_created',
    account: { id: targetTenant },
    conversation: {
      id: body.conversation_id || '23',
      contact_inbox: { contact_id: body.contact_id || '7' },
      inbox_id: body.inbox_id || '7'
    },
    sender: {
      id: body.contact_id || '7',
      name: body.name || 'David Mercado',
      email: body.email || null,
      phone_number: body.phone || '+584125207119'
    },
    message: {
      id: body.message_id || `msg_${Date.now()}`,
      message_type: 'incoming',
      content: body.text || 'Hola, quiero información sobre limpieza',
      created_at: new Date().toISOString()
    }
  };

  const response = await server.inject({
    method: 'POST',
    url: `/webhooks/chatwoot/${targetTenant}`,
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

import fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { normalizeChatwootPayload } from './chatwoot/normalizer.js';
import { idempotencyRepository, stateRepository, logsRepository, patientRepository } from './repositories/database.js';
import { supabase } from './supabase/client.js';
import { bufferService } from './buffer/buffer-service.js';
import { processBufferEvent } from './orchestrator.js';
import { debugTracker } from './debug/debug-tracker.js';
import { startRecoveryWorker } from './services/inbound-recovery-worker.js';

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

// Estado global en memoria para rastrear si la última llamada a Hermes falló
export const hermesStatusTracker = {
  lastCallFailed: false
};

function getHermesStatus(): 'CONNECTED' | 'MOCK' | 'DISABLED' | 'ERROR' {
  if (!config.HERMES_ENABLED) return 'DISABLED';
  if (config.HERMES_MOCK) return 'MOCK';
  if (hermesStatusTracker.lastCallFailed) return 'ERROR';
  return 'CONNECTED';
}

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
    hermesMode: getHermesStatus()
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

  // 1. Total Global
  const { count: receivedCount } = await supabase
    .from('helios_gateway_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  // 2. Incoming de Pacientes
  const { count: incomingCount } = await supabase
    .from('helios_gateway_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('event_type', 'webhook_received');

  // 3. Outgoing del Bot
  const { count: outgoingCount } = await supabase
    .from('helios_gateway_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('event_type', 'CHATWOOT_REPLY_SENT');

  // 4. Ignorados
  const { count: ignoredCount } = await supabase
    .from('helios_gateway_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('event_type', 'event_ignored');

  // 5. Duplicados
  const { count: duplicateCount } = await supabase
    .from('helios_gateway_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('event_type', 'duplicate_message');

  // 6. Procesados exitosamente por Hermes
  const { count: processedCount } = await supabase
    .from('helios_gateway_logs')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('event_type', 'HERMES_CALL_SUCCESS');

  return {
    status: 'online',
    webhookUrl: `/webhooks/chatwoot/${tenantId}`,
    totalWebhooksReceived: receivedCount || 0,
    incomingCount: incomingCount || 0,
    outgoingCount: outgoingCount || 0,
    totalEventsIgnored: ignoredCount || 0,
    duplicateCount: duplicateCount || 0,
    totalMessagesProcessed: processedCount || 0,
    hermesMode: getHermesStatus()
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
  // Limpia del tracker los eventos correspondientes a este tenant en memoria
  debugTracker.clearTenant(tenantId);

  // Limpiar logs de Supabase para este tenant para reiniciar los contadores a 0
  try {
    const { error } = await supabase
      .from('helios_gateway_logs')
      .delete()
      .eq('tenant_id', tenantId);
    if (error) {
      server.log.error(error, '[Supabase Cleanup] Error al vaciar logs');
    }
  } catch (err: any) {
    server.log.error(err, '[Supabase Cleanup] Exception al vaciar logs');
  }

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

// Endpoint para el Dashboard: Perfiles de pacientes verificados desde Supabase
// Devuelve los perfiles con PII enmascarada para display seguro
server.get('/admin/contacts', async (request, reply) => {
  try {
    const tenantId = await checkAuth(request, reply);
    const { data, error } = await supabase
      .from('helios_patient_profiles')
      .select('contact_id, first_name, last_name, name, phone, email, profile_complete, crm_contact_id, updated_at')
      .eq('tenant_id', tenantId);

    if (error) throw error;

    // Enmascarar PII para el dashboard
    const masked = (data || []).map(p => {
      const maskedEmail = p.email
        ? p.email.replace(/^(.{2})(.*)(@.*)$/, '$1***$3')
        : null;
      const maskedPhone = p.phone
        ? p.phone.slice(0, 5) + '***' + p.phone.slice(-2)
        : null;

      // Determinar fuente del nombre
      let displayName = null;
      let displayNameSource = 'unknown';

      if (p.first_name || p.last_name) {
        displayName = [p.first_name, p.last_name].filter(Boolean).join(' ');
        displayNameSource = 'gateway_profile';
      } else if (p.name && p.name !== 'Paciente de Chatwoot') {
        displayName = p.name;
        displayNameSource = 'chatwoot';
      }

      if (p.crm_contact_id) {
        displayNameSource = 'hubspot_crm';
      }

      return {
        contact_id: p.contact_id,
        display_name: displayName,
        display_name_source: displayNameSource,
        first_name: p.first_name || null,
        last_name: p.last_name || null,
        email_masked: maskedEmail,
        phone_masked: maskedPhone,
        profile_complete: p.profile_complete || false,
        has_crm_id: !!p.crm_contact_id,
        updated_at: p.updated_at
      };
    });

    return masked;
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

  // Inicializar de forma proactiva el perfil del paciente con el teléfono y nombre de Chatwoot si no existe
  try {
    const existingPatient = await patientRepository.get(normalized.tenant_id, normalized.contact_id);
    if (!existingPatient && normalized.phone) {
      await patientRepository.upsert({
        tenant_id: normalized.tenant_id,
        contact_id: normalized.contact_id,
        phone: normalized.phone,
        name: normalized.patient_name || 'Paciente de Chatwoot'
      });
      log.info({ contact_id: normalized.contact_id }, 'Perfil del paciente inicializado con datos de Chatwoot.');
    }
  } catch (err: any) {
    log.warn({ err: err.message }, 'No se pudo inicializar proactivamente el perfil de paciente.');
  }

  // Inicializar de forma proactiva el estado de conversación con el teléfono e identificadores reales
  try {
    const existingState = await stateRepository.getRefined(normalized.tenant_id, normalized.conversation_id, normalized.contact_id);
    if (!existingState) {
      await stateRepository.upsert({
        tenant_id: normalized.tenant_id,
        conversation_id: normalized.conversation_id,
        contact_id: normalized.contact_id,
        inbox_id: normalized.inbox_id,
        phone: normalized.phone,
        ai_enabled: true,
        human_handoff_active: false,
        status: 'new'
      });
      log.info({ conversation_id: normalized.conversation_id }, 'Estado de la conversación inicializado de forma proactiva.');
    } else if (!existingState.phone && normalized.phone) {
      // Si existía pero le faltaba el teléfono, lo actualizamos
      await stateRepository.upsert({
        ...existingState,
        phone: normalized.phone
      });
    }
  } catch (err: any) {
    log.warn({ err: err.message }, 'No se pudo inicializar proactivamente el estado de conversación.');
  }

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
  if (process.env.NODE_ENV === 'production') {
    return reply.status(403).send({ ok: false, error: 'Simulator disabled in production.' });
  }

  const body = request.body as any;
  const targetTenant = body.tenant_id || 'debug_tenant';
  
  const uuid = require('crypto').randomUUID().substring(0, 8);
  const contactId = body.contact_id || `debug_contact_${uuid}`;
  const conversationId = body.conversation_id || `debug_conversation_${uuid}`;
  const patientName = body.name;

  if (!patientName) {
     return reply.status(400).send({ ok: false, error: 'name is strictly required for simulator' });
  }

  if (!body.phone) {
     return reply.status(400).send({ ok: false, error: 'phone is strictly required for simulator' });
  }
  
  const mockPayload = {
    event: 'message_created',
    account: { id: targetTenant },
    conversation: {
      id: conversationId,
      contact_inbox: { contact_id: contactId },
      inbox_id: body.inbox_id || '7'
    },
    sender: {
      id: contactId,
      name: patientName,
      email: body.email || null,
      phone_number: body.phone
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

// Endpoint de Healthcheck alternativo
server.get('/healthz', async (request, reply) => {
  return { ok: true, status: 'healthy' };
});

const stopRecoveryWorker = process.env.NODE_ENV !== 'test' 
  ? startRecoveryWorker() 
  : () => Promise.resolve();

const start = async () => {
  try {
    console.log("[BOOT] Helios Gateway starting...");
    console.log("[BOOT] Node version:", process.version);
    console.log("[BOOT] Hermes enabled:", config.HERMES_ENABLED);
    console.log("[BOOT] Hermes mock:", config.HERMES_MOCK);
    console.log("[BOOT] Hermes base url configured:", Boolean(config.HERMES_BASE_URL));

    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log("[BOOT] Server listening on port:", config.PORT);
    server.log.info(`Servidor escuchando en http://localhost:${config.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

async function gracefulShutdown(signal: string) {
  console.log(`\n[Helios Gateway] Received ${signal}, starting graceful shutdown...`);
  
  await stopRecoveryWorker();
  
  server.close().then(() => {
    console.log('[Helios Gateway] Fastify server closed.');
    process.exit(0);
  }, (err) => {
    console.error('[Helios Gateway] Error closing Fastify server:', err);
    process.exit(1);
  });

  // Force exit if taking too long
  setTimeout(() => {
    console.error('[Helios Gateway] Forced shutdown due to timeout.');
    process.exit(1);
  }, 20000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

start();

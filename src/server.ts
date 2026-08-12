import fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { applyCsatOnResolution, csatMetrics } from './csat/service.js';
import { normalizeChatwootPayload } from './chatwoot/normalizer.js';
import { resolveTenantContext, TenantContextError, validateWebhookTenantRoute } from './tenants/context.js';
import {
  bufferRepository,
  idempotencyRepository,
  logsRepository,
  patientRepository,
  stateRepository
} from './repositories/database.js';
import { outboxRepository } from './repositories/durable.js';
import {
  canTransition,
  humanHandoffActiveFor,
  isHumanOwnedStage,
  resolveStage
} from './handoff/stage.js';
import { interpretSignal, parseConversationSignal, planSignalAction } from './handoff/signals.js';
import { resolveHandoffRouting } from './handoff/routing.js';
import { returnConversationToBot } from './handoff/service.js';
import { detectCommand, RETURN_TO_BOT_COMMAND } from './handoff/commands.js';
import { chatwootClient } from './chatwoot/client.js';
import { supabase } from './supabase/client.js';
import { bufferService } from './buffer/buffer-service.js';
import { processBufferEvent } from './orchestrator.js';
import { debugTracker } from './debug/debug-tracker.js';
import { startRecoveryWorker } from './services/inbound-recovery-worker.js';
import { recoveryMetrics } from './services/inbound-recovery-worker.js';
import { startOutboxWorker, outboxMetrics } from './services/chatwoot-outbox-worker.js';
import { startNotificationWorker, notificationMetrics } from './services/notification-outbox-worker.js';
import { startStaleHandoffWorker, staleHandoffMetrics } from './services/handoff-stale-worker.js';
import { componentHealth } from './services/component-health.js';
import { refreshDependencyHealth } from './services/health-probes.js';
import { assertSupabaseSuccess } from './supabase/assert-success.js';
import {
  isValidClinicalName,
  loadAdminObservability,
  parseAdminRange
} from './admin/observability.js';
import {
  assertConversationHistoryAccountAccess,
  ConversationHistoryError,
  loadAdminConversationHistory
} from './admin/conversation-history.js';
import crypto from 'crypto';

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

server.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/admin')) {
    reply.header('Cache-Control', 'no-store, private, max-age=0');
    reply.header('Pragma', 'no-cache');
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
});

// Registramos el soporte para servir la carpeta de archivos estáticos 'public'
server.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
  prefix: '/', 
});

// Inicializamos el callback del buffer para conectar con el orquestador
bufferService.setCallback(async (tenantId, conversationId, traceId) => {
  await processBufferEvent(tenantId, conversationId, traceId);
});

function getHermesStatus(): string {
  if (!config.HERMES_ENABLED) return 'DISABLED';
  if (config.HERMES_MOCK) return 'MOCK';
  return componentHealth.hermes.state === 'OK' ? 'HERMES_OK' : componentHealth.hermes.state;
}

function createAdminSessionToken(tenantId: string): string {
  const payload = Buffer.from(JSON.stringify({
    tenant_id: tenantId,
    exp: Date.now() + config.HELIOS_ADMIN_SESSION_TTL_MS
  })).toString('base64url');
  const secret = config.HELIOS_ADMIN_SESSION_SECRET || config.SUPABASE_SERVICE_ROLE_KEY;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAdminSessionToken(token: string): string | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const secret = config.HELIOS_ADMIN_SESSION_SECRET || config.SUPABASE_SERVICE_ROLE_KEY;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.tenant_id || !decoded.exp || decoded.exp <= Date.now()) return null;
    return String(decoded.tenant_id);
  } catch {
    return null;
  }
}

// 1. GET /
// Servimos el archivo index.html para la ruta raíz
server.get('/', async (request, reply) => {
  return reply.sendFile('index.html');
});

// 2. GET /health
server.get('/health', async (request, reply) => {
  await refreshDependencyHealth();
  return {
    ok: true,
    service: 'helios-gateway',
    version: '0.1.0',
    recovery_mode: config.HELIOS_RECOVERY_MODE,
    admin_pii_enabled: config.HELIOS_ADMIN_SHOW_PII,
    components: {
      hermes_agent_api: componentHealth.hermes,
      adapter: componentHealth.adapter,
      supabase: componentHealth.supabase,
      chatwoot: {
        ...componentHealth.chatwoot,
        delivery_unknown_count: outboxMetrics.delivery_unknown
      }
    },
    recovery: recoveryMetrics,
    handoff: {
      enabled: config.HELIOS_HANDOFF_ENABLED,
      notifications: notificationMetrics,
      stale_return: {
        ...staleHandoffMetrics,
        threshold_hours: config.HELIOS_HANDOFF_STALE_HOURS
      }
    },
    csat: {
      // enabled=false NO significa apagado del todo: la decisión se sigue
      // anotando y contando, pero no se escribe ninguna etiqueta en Chatwoot.
      enabled: config.HELIOS_CSAT_ENABLED,
      observe_only: !config.HELIOS_CSAT_ENABLED,
      ...csatMetrics
    },
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
      token: createAdminSessionToken(tenant.tenant_id),
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
  const tenantId = verifyAdminSessionToken(token);
  if (!tenantId) {
    reply.status(401).send({ error: 'Token inválido o expirado.' });
    throw new Error('Unauthorized');
  }
  
  // Validamos si el token corresponde a un tenant registrado en la DB
  const { data: tenant, error } = await supabase
    .from('helios_tenants')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .single();

  if (error || !tenant) {
    reply.status(401).send({ error: 'Token inválido o expirado.' });
    throw new Error('Unauthorized');
  }

  console.log(JSON.stringify({
    event: 'admin_dashboard_access',
    tenant_fingerprint: crypto.createHash('sha256').update(tenant.tenant_id).digest('hex').slice(0, 12),
    path: request.url.split('?')[0]
  }));
  return tenant.tenant_id; // Retorna el tenant_id validado
}

async function getAdministrativeObservability(request: any, reply: any) {
  const tenantId = await checkAuth(request, reply);
  await refreshDependencyHealth();
  const range = parseAdminRange(request.query?.range);
  const observability = await loadAdminObservability(supabase, {
    tenantId,
    showPii: config.HELIOS_ADMIN_SHOW_PII,
    range
  });
  return {
    ...observability,
    webhookUrl: `/webhooks/chatwoot/${tenantId}`,
    health: {
      hermes_agent_api: componentHealth.hermes,
      adapter: componentHealth.adapter,
      supabase: componentHealth.supabase,
      chatwoot: componentHealth.chatwoot,
      recovery_mode: config.HELIOS_RECOVERY_MODE
    }
  };
}

// Las tablas operativas son la fuente principal; los logs solo complementan la timeline.
server.get('/admin/observability', async (request, reply) => {
  return getAdministrativeObservability(request, reply);
});

server.get('/admin/conversations/:conversation_id/messages', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  const params = request.params as { conversation_id?: string };
  const query = request.query as {
    account_id?: string;
    contact_id?: string;
    limit?: string;
    cursor?: string;
  };

  try {
    const accountContext = resolveTenantContext(query.account_id);
    assertConversationHistoryAccountAccess(tenantId, accountContext);
    return await loadAdminConversationHistory(supabase, {
      tenantId,
      accountId: query.account_id || '',
      conversationId: params.conversation_id || '',
      contactId: query.contact_id || '',
      showPii: config.HELIOS_ADMIN_SHOW_PII,
      limit: query.limit,
      cursor: query.cursor
    });
  } catch (error: any) {
    if (error instanceof ConversationHistoryError) {
      return reply.status(error.statusCode).send({ error: error.code });
    }
    if (error instanceof TenantContextError) {
      return reply.status(403).send({ error: 'CONVERSATION_HISTORY_FORBIDDEN' });
    }
    throw error;
  }
});

// Alias compatible para consumidores del endpoint de estadísticas anterior.
server.get('/admin/stats', async (request, reply) => {
  const result = await getAdministrativeObservability(request, reply);
  const stats = result.stats;
  return {
    ...stats,
    status: 'online',
    webhookUrl: result.webhookUrl,
    totalWebhooksReceived: stats.uniqueWebhooks,
    incomingCount: stats.uniqueIncomingMessages,
    outgoingCount: stats.chatwootSent,
    totalEventsIgnored: stats.ignoredWebhooks,
    duplicateCount: stats.duplicatesPrevented,
    totalMessagesProcessed: stats.hermesCompleted,
    batchesCreated: stats.batchesProcessed,
    adapterExecutionsNew: stats.adapterExecutionsNew,
    adapterExecutionsDeduplicated: stats.adapterExecutionsDeduplicated,
    hermesRequestsReal: stats.hermesRequestsReal,
    hermesResponsesCompleted: stats.hermesCompleted,
    outboxPending: stats.outboxPending,
    chatwootSent: stats.chatwootSent,
    deliveryUnknown: stats.deliveryUnknown,
    recoveryAi: recoveryMetrics.ai_recovery,
    recoveryDelivery: recoveryMetrics.delivery_recovery,
    duplicatesPrevented: stats.duplicatesPrevented,
    range: result.range,
    range_start: result.range_start,
    recoveryMode: config.HELIOS_RECOVERY_MODE,
    hermesMode: getHermesStatus(),
    health: result.health
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
  const events = debugTracker.getEvents(
    { conversation_id, decision, onlyErrors },
    config.HELIOS_ADMIN_SHOW_PII
  );
  return events.filter((e: any) => e.normalizedPayload?.tenant_id === tenantId);
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

// Endpoint para el Dashboard: perfiles clínicos, sujeto al flag administrativo de PII.
server.get('/admin/contacts', async (request, reply) => {
  try {
    const tenantId = await checkAuth(request, reply);
    const { data, error } = await supabase
      .from('helios_patient_profiles')
      .select('contact_id, first_name, last_name, name, phone, email, profile_complete, crm_contact_id, updated_at')
      .eq('tenant_id', tenantId);

    if (error) throw error;

    // PII completa solo para el dashboard autenticado y con flag explícito.
    const masked = (data || []).map(p => {
      const maskedEmail = p.email
        ? p.email.replace(/^(.{2})(.*)(@.*)$/, '$1***$3')
        : null;
      const maskedPhone = p.phone
        ? p.phone.slice(0, 5) + '***' + p.phone.slice(-2)
        : null;

      let displayName = null;
      let displayNameSource = 'unknown';

      const candidateName = [p.first_name, p.last_name]
        .filter(isValidClinicalName)
        .join(' ')
        .trim() || (isValidClinicalName(p.name) ? String(p.name).trim() : '');
      if (candidateName) {
        displayName = candidateName;
        displayNameSource = 'persisted_profile';
      } else {
        displayName = null;
        displayNameSource = 'unknown';
      }

      if (p.crm_contact_id) {
        displayNameSource = 'hubspot_crm';
      }

      return {
        contact_id: p.contact_id,
        display_name: config.HELIOS_ADMIN_SHOW_PII ? displayName : null,
        display_name_source: displayNameSource,
        first_name: config.HELIOS_ADMIN_SHOW_PII ? p.first_name || null : undefined,
        last_name: config.HELIOS_ADMIN_SHOW_PII ? p.last_name || null : undefined,
        email: config.HELIOS_ADMIN_SHOW_PII ? p.email || null : undefined,
        phone: config.HELIOS_ADMIN_SHOW_PII ? p.phone || null : undefined,
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

/**
 * Un mensaje saliente de Chatwoot puede ser el eco de Helios o algo que escribió
 * una persona del equipo. El discriminador es limpio: todo saliente de Helios
 * queda en helios_chatwoot_outbox con su chatwoot_outbound_message_id.
 *
 * Los mensajes del equipo se guardan en el buffer con direction='outgoing' y
 * processed_at ya puesto, así que claim_conversation_messages nunca los recoge y
 * no pueden disparar ninguna llamada a la IA. Existen para que Helios pueda
 * consultar después lo que se habló en modo humano (requisito D).
 */
async function captureHumanAgentMessage(
  normalized: ReturnType<typeof normalizeChatwootPayload>,
  log: any
): Promise<{ stored: boolean; reason: string }> {
  const isHeliosEcho = await outboxRepository
    .isHeliosOutboundMessage(normalized.tenant_id, normalized.message_id)
    .catch((error: any) => {
      // Sin poder comprobarlo, no se inventa: se trata como eco y solo se ignora.
      log.warn({ err: error?.message }, 'No se pudo comprobar el eco de Helios.');
      return true;
    });
  if (isHeliosEcho) return { stored: false, reason: 'helios_echo' };

  // Reclamar ANTES de guardar. Chatwoot puede entregar el mismo message_created
  // más de una vez (reintentos, o el webhook de cuenta y el del AgentBot a la vez),
  // y comprobar-y-luego-insertar dejaba pasar las dos peticiones concurrentes: por
  // eso el mensaje del equipo se guardó dos veces. El INSERT en la tabla de
  // idempotencia es el candado, porque su clave primaria lo hace atómico.
  const won = await idempotencyRepository.claim(
    normalized.tenant_id,
    normalized.provider,
    normalized.message_id,
    normalized.conversation_id,
    normalized.trace_id
  );
  if (!won) return { stored: false, reason: 'duplicate' };

  await bufferRepository.saveHumanAgentMessage(normalized);

  // Que el equipo escriba es la señal más fuerte de que ya está atendiendo.
  let stageTransition: string | null = null;
  try {
    const state = await stateRepository.getRefined(
      normalized.tenant_id,
      normalized.conversation_id,
      normalized.contact_id
    );
    const { stage } = resolveStage(state);
    if (canTransition(stage, 'human_active') && stage !== 'human_active' && isHumanOwnedStage(stage)) {
      await stateRepository.upsert({
        tenant_id: normalized.tenant_id,
        conversation_id: normalized.conversation_id,
        contact_id: normalized.contact_id,
        inbox_id: normalized.inbox_id,
        stage: 'human_active',
        human_handoff_active: humanHandoffActiveFor('human_active'),
        human_accepted_at: new Date().toISOString(),
        human_accepted_by: normalized.sender_id || null
      });
      stageTransition = `${stage}->human_active`;
    }
  } catch (error: any) {
    log.warn({ err: error?.message }, 'No se pudo actualizar el stage tras el mensaje del equipo.');
  }

  await logsRepository.save({
    trace_id: normalized.trace_id,
    tenant_id: normalized.tenant_id,
    conversation_id: normalized.conversation_id,
    contact_id: normalized.contact_id,
    event_type: 'HUMAN_AGENT_MESSAGE_STORED',
    metadata: {
      message_id: normalized.message_id,
      sender_id: normalized.sender_id,
      sender_type: normalized.sender_type,
      stage_transition: stageTransition,
      claimable_by_ai: false
    }
  });

  return { stored: true, reason: 'human_agent_message' };
}

/**
 * Señales del equipo en Chatwoot (ítems 21 y 22): etiquetas, equipo y estado se
 * traducen a la máquina de estados, y los atributos personalizados los escribe el
 * Gateway por API porque las macros de esta instalación no pueden hacerlo.
 *
 * Es idempotente: si la etapa que pide la señal ya es la actual, no se escribe
 * nada. Tres webhooks repetidos producen un solo cambio.
 */
async function handleConversationSignal(payload: any, urlTenantId: string | undefined, log: any) {
  const signal = parseConversationSignal(payload);
  const tenantContext = resolveTenantContext(signal.account_id);
  validateWebhookTenantRoute(tenantContext, urlTenantId);

  if (!signal.conversation_id) {
    return { ok: true, status: 'ignored', reason: 'conversation_id no presente en el webhook' };
  }

  // Encuesta de satisfacción. Va ANTES del flag del handoff y de toda la lógica
  // de etapas A PROPÓSITO: la conversación que hay que encuestar es justo la que
  // Helios llevó de principio a fin, y esa no genera ninguna señal de handoff.
  // Si esto estuviera más abajo, no se ejecutaría nunca en el caso que importa.
  // No lanza: se traga sus propios errores para no tumbar la señal.
  if (String(signal.status ?? '') === 'resolved') {
    await applyCsatOnResolution({
      tenantId: tenantContext.tenant_id,
      accountId: tenantContext.account_id,
      conversationId: signal.conversation_id,
      contactId: signal.contact_id || 'unknown',
      traceId: `csat-${signal.conversation_id}`
    });
  }

  if (!config.HELIOS_HANDOFF_ENABLED) {
    return { ok: true, status: 'ignored', reason: 'handoff_disabled' };
  }

  const state = await stateRepository.getRefined(
    tenantContext.tenant_id,
    signal.conversation_id,
    signal.contact_id
  );
  if (!state) {
    // Una conversación que Helios nunca ha visto no tiene estado que mover.
    return { ok: true, status: 'ignored', reason: 'unknown_conversation' };
  }

  const { stage: currentStage } = resolveStage(state);
  const routing = resolveHandoffRouting(tenantContext.tenant_id);
  const interpretation = interpretSignal(signal, routing, currentStage);
  const action = planSignalAction(interpretation, currentStage);

  const contactId = signal.contact_id || state.contact_id || 'unknown';
  const inboxId = signal.inbox_id || state.inbox_id || 'unknown';
  const traceId = `signal-${crypto.randomUUID()}`;

  if (action.kind === 'none') {
    log.debug({ stage: currentStage, reason: action.reason }, 'Señal de Chatwoot sin efecto');
    return { ok: true, status: 'no_change', stage: currentStage, reason: action.reason };
  }

  if (action.kind === 'rejected') {
    await logsRepository.save({
      trace_id: traceId,
      tenant_id: tenantContext.tenant_id,
      conversation_id: signal.conversation_id,
      contact_id: contactId,
      event_type: 'HANDOFF_SIGNAL_REJECTED',
      metadata: {
        from_stage: action.from,
        requested_stage: action.to,
        reason: action.reason,
        labels: signal.labels,
        chatwoot_status: signal.status
      }
    });
    return { ok: true, status: 'rejected', stage: currentStage, reason: action.reason };
  }

  if (action.kind === 'return_to_bot') {
    await returnConversationToBot({
      tenantContext,
      conversation_id: signal.conversation_id,
      contact_id: contactId,
      inbox_id: inboxId,
      phone: signal.phone || state.phone || '',
      trace_id: traceId,
      handoff_id: state.handoff_id || null,
      accepted_by: signal.assignee_id
    });
    return { ok: true, status: 'returned_to_bot', stage: 'bot_active' };
  }

  const nextStage = action.stage;
  const now = new Date().toISOString();
  await stateRepository.upsert({
    tenant_id: tenantContext.tenant_id,
    conversation_id: signal.conversation_id,
    contact_id: contactId,
    inbox_id: inboxId,
    stage: nextStage,
    human_handoff_active: humanHandoffActiveFor(nextStage),
    ...(nextStage === 'human_active' && !state.human_accepted_at
      ? { human_accepted_at: now, human_accepted_by: signal.assignee_id }
      : {})
  });

  // El atributo Stage se mantiene alineado; las macros no pueden escribirlo.
  await chatwootClient
    .mergeCustomAttributes(tenantContext.account_id, signal.conversation_id, {
      [routing.attribute_keys.stage]: nextStage
    })
    .catch((error: any) => {
      log.warn({ err: error?.message }, 'No se pudo escribir el atributo de stage en Chatwoot.');
    });

  await logsRepository.save({
    trace_id: traceId,
    tenant_id: tenantContext.tenant_id,
    conversation_id: signal.conversation_id,
    contact_id: contactId,
    event_type: 'HANDOFF_STAGE_CHANGED_BY_SIGNAL',
    metadata: {
      from_stage: currentStage,
      to_stage: nextStage,
      reason: action.reason,
      labels: signal.labels,
      chatwoot_status: signal.status,
      team_id: signal.team_id,
      handoff_id: state.handoff_id || null
    }
  });

  return { ok: true, status: 'stage_changed', stage: nextStage, reason: action.reason };
}

/**
 * Comando /fin: devuelve la conversación al modo IA de inmediato.
 *
 * Funciona lo escriba el paciente por WhatsApp o el equipo desde Chatwoot, y
 * también dentro de una nota privada, que es la forma de usarlo sin que el
 * paciente vea el comando.
 *
 * A diferencia de la macro de retorno, se acepta desde CUALQUIER etapa en manos
 * humanas: es una orden explícita, no una señal de flujo de trabajo. Y el mensaje
 * del comando no se guarda como parte de la conversación ni se responde: es una
 * instrucción, no algo que el paciente esté preguntando.
 */
async function handleReturnCommand(
  normalized: ReturnType<typeof normalizeChatwootPayload>,
  log: any
): Promise<{ handled: boolean; reason: string }> {
  const tenantContext = resolveTenantContext(normalized.account_id);

  const state = await stateRepository.getRefined(
    normalized.tenant_id,
    normalized.conversation_id,
    normalized.contact_id
  );
  const { stage } = resolveStage(state);

  if (!isHumanOwnedStage(stage)) {
    // Ya está en modo IA: el comando no tiene nada que hacer.
    return { handled: false, reason: 'already_bot_active' };
  }

  // Un solo webhook actúa, aunque Chatwoot entregue el mismo mensaje varias veces.
  const won = await idempotencyRepository.claim(
    normalized.tenant_id,
    normalized.provider,
    normalized.message_id,
    normalized.conversation_id,
    normalized.trace_id
  );
  if (!won) return { handled: false, reason: 'duplicate_command' };

  await returnConversationToBot({
    tenantContext,
    conversation_id: normalized.conversation_id,
    contact_id: normalized.contact_id,
    inbox_id: normalized.inbox_id,
    phone: normalized.phone || state?.phone || '',
    trace_id: normalized.trace_id,
    handoff_id: state?.handoff_id || null,
    accepted_by: normalized.sender_id
  });

  await logsRepository.save({
    trace_id: normalized.trace_id,
    tenant_id: normalized.tenant_id,
    conversation_id: normalized.conversation_id,
    contact_id: normalized.contact_id,
    event_type: 'HANDOFF_RETURNED_BY_COMMAND',
    metadata: {
      command: RETURN_TO_BOT_COMMAND,
      from_stage: stage,
      written_by: normalized.direction === 'incoming' ? 'patient' : 'clinic_team',
      was_private_note: normalized.is_private,
      handoff_id: state?.handoff_id || null
    }
  });

  log.info({ conversation_id: normalized.conversation_id, from_stage: stage }, 'Comando /fin: conversación devuelta a la IA.');
  return { handled: true, reason: 'returned_by_command' };
}

// Helper interno para procesar webhook
async function handleChatwootWebhook(payload: any, urlTenantId: string | undefined, log: any) {
  const incomingEvent = String(payload?.event || '');
  if (incomingEvent === 'conversation_updated' || incomingEvent === 'conversation_status_changed') {
    return handleConversationSignal(payload, urlTenantId, log);
  }

  const normalized = normalizeChatwootPayload(payload);

  // La ruta nunca puede sobrescribir el tenant resuelto desde account_id.
  validateWebhookTenantRoute(normalized, urlTenantId);

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

  // El comando /fin se atiende ANTES que cualquier otra cosa: lo escriba el
  // paciente o el equipo, en un mensaje normal o en una nota privada.
  if (
    config.HELIOS_HANDOFF_ENABLED
    && normalized.event === 'message_created'
    && normalized.conversation_id
    && normalized.message_id
    && detectCommand(normalized.text) === 'return_to_bot'
  ) {
    try {
      const result = await handleReturnCommand(normalized, log);
      if (result.handled) {
        debugTracker.updateEvent(normalized.trace_id, { decision: 'ignored', reason: result.reason } as any);
        debugTracker.addTimelineStep(normalized.trace_id, 'action_executed', {
          action: 'HANDOFF_RETURNED_BY_COMMAND'
        });
        return { ok: true, status: 'returned_by_command' };
      }
      if (result.reason === 'duplicate_command') {
        return { ok: true, status: 'duplicate' };
      }
    } catch (error: any) {
      log.error({ err: error?.message }, 'No se pudo aplicar el comando /fin.');
    }
  }

  // Un saliente con forma de mensaje humano se guarda antes de descartarlo como
  // eco: es la única forma de que quede registro consultable de lo que escribió
  // el equipo durante el modo humano.
  if (normalized.human_agent_candidate) {
    const captured = await captureHumanAgentMessage(normalized, log);
    if (captured.stored) {
      debugTracker.updateEvent(normalized.trace_id, { decision: 'ignored', reason: captured.reason } as any);
      debugTracker.addTimelineStep(normalized.trace_id, 'action_executed', {
        action: 'HUMAN_AGENT_MESSAGE_STORED'
      });
      return { ok: true, status: 'human_agent_message_stored' };
    }
    if (captured.reason === 'duplicate') {
      return { ok: true, status: 'duplicate' };
    }
  }

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
        metadata: {
          ignore_reason: normalized.ignore_reason,
          event: normalized.event,
          conversation_contact_id: normalized.contact_id,
          sender_id: normalized.sender_id,
          sender_type: normalized.sender_type
        }
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

  // Inicializar de forma proactiva el perfil del paciente con el teléfono si no existe
  // NO guardar el alias de Chatwoot en name; name solo se llena con identidad verificada
  try {
    const existingPatient = await patientRepository.get(normalized.tenant_id, normalized.contact_id);
    if (!existingPatient && normalized.phone) {
      await patientRepository.upsert({
        tenant_id: normalized.tenant_id,
        contact_id: normalized.contact_id,
        phone: normalized.phone,
        name: null // name solo se llena cuando Hermes devuelve identidad verificada
      });
      log.info({ contact_id: normalized.contact_id }, 'Perfil del paciente inicializado con teléfono.');
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
    if (error instanceof TenantContextError) {
      server.log.warn({
        error_code: error.code,
        account_id: error.account_id
      }, 'Webhook rechazado por contexto tenant');
      return reply.status(422).send({
        ok: false,
        error_code: error.code,
        recoverable: false
      });
    }
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
    if (error instanceof TenantContextError) {
      server.log.warn({
        error_code: error.code,
        account_id: error.account_id
      }, 'Webhook rechazado por contexto tenant');
      return reply.status(422).send({
        ok: false,
        error_code: error.code,
        recoverable: false
      });
    }
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
  
  const uuid = crypto.randomUUID().substring(0, 8);
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
const stopOutboxWorker = process.env.NODE_ENV !== 'test'
  ? startOutboxWorker()
  : () => Promise.resolve();
const stopNotificationWorker = process.env.NODE_ENV !== 'test'
  ? startNotificationWorker()
  : () => Promise.resolve();
const stopStaleHandoffWorker = process.env.NODE_ENV !== 'test'
  ? startStaleHandoffWorker()
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
  await stopOutboxWorker();
  await stopNotificationWorker();
  await stopStaleHandoffWorker();
  
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

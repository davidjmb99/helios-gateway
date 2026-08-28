import fastify from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { applyCsatOnResolution, csatMetrics } from './csat/service.js';
import { describirModo, accionPara } from './handoff/modo.js';
import { pedirEmpezarDeCero } from './conversaciones/empezar-de-cero.js';
import { normalizeChatwootPayload } from './chatwoot/normalizer.js';
import { procesarMediaDelMensaje } from './media/pipeline.js';
import { resolveTenantContext, TenantContextError, validateWebhookTenantRoute, resolveTenantContextByTenantId } from './tenants/context.js';
import {
  bufferRepository,
  idempotencyRepository,
  logsRepository,
  mediaRepository,
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
import { startLeadFollowupWorker } from './services/lead-followup-worker.js';
import { leadMetrics } from './leads/service.js';
import { cifrarContrasena, esHashSeguro, verificarContrasena } from './admin/passwords.js';
import { contarFilas, purgarDatos } from './admin/data-purge.js';
import { leerAjustes, guardarAjustes, obtenerHorarioYVentana } from './tenants/settings.js';
import { probarAgenda } from './agenda/prueba.js';
import { atenderMcp } from './agenda/mcp.js';
import { clinicaDelToken, tokenDeLaCabecera, tokenDeAgenda } from './agenda/credencial.js';
import { leerDoctores } from './agenda/doctores.js';
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
import { puedeCambiarDeCuenta, estadoHttpDe } from './admin/operador.js';
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

/**
 * El token de la sesion del panel.
 *
 * `operador` NO es un si/no: es el tenant_id de la cuenta de operador que abrio la sesion.
 * Guardar QUIEN es y no solo QUE puede permite volver a comprobarlo contra la base de
 * datos al cambiar de cuenta, asi que quitarle el permiso a alguien surte efecto en el
 * momento y no cuando le caduque la sesion.
 *
 * El token va firmado con HMAC, asi que el navegador no puede inventarse este campo: solo
 * existe en un token que hayamos emitido nosotros.
 */
function createAdminSessionToken(tenantId: string, operador: string | null = null): string {
  const payload = Buffer.from(JSON.stringify({
    tenant_id: tenantId,
    ...(operador ? { operador } : {}),
    exp: Date.now() + config.HELIOS_ADMIN_SESSION_TTL_MS
  })).toString('base64url');
  const secret = config.HELIOS_ADMIN_SESSION_SECRET || config.SUPABASE_SERVICE_ROLE_KEY;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

interface SesionDelPanel {
  /** La clinica que se esta viendo AHORA. Es de donde sale el tenant de cada endpoint. */
  tenant_id: string;
  /** El operador que abrio la sesion, si lo era. null en una sesion de clinica. */
  operador: string | null;
}

function verifyAdminSessionToken(token: string): SesionDelPanel | null {
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
    return {
      tenant_id: String(decoded.tenant_id),
      operador: decoded.operador ? String(decoded.operador) : null
    };
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
        // Ya NO es el umbral efectivo: cada clínica puede tener el suyo en
        // helios_tenants.handoff_stale_hours. Este es el que se usa cuando una
        // clínica no ha elegido nada. El efectivo de cada una sale de
        // GET /admin/settings, que va autenticado por clínica.
        threshold_hours_por_defecto: config.HELIOS_HANDOFF_STALE_HOURS
      }
    },
    // El modo de estas dos funciones es POR CLÍNICA desde HEL-072, así que aquí ya
    // no se puede decir «enabled: false» y quedarse tan ancho: seria mentir igual
    // que hacía threshold_hours con el umbral del handoff. Lo que se publica es el
    // modo POR DEFECTO derivado del entorno; el efectivo de cada clínica sale de
    // GET /admin/settings, que va autenticado por clínica.
    leads: {
      modo_por_defecto: config.HELIOS_LEADS_ENABLED ? 'on' : 'observe',
      nota: 'el modo efectivo es por clinica: ver GET /admin/settings',
      ...leadMetrics
    },
    csat: {
      modo_por_defecto: config.HELIOS_CSAT_ENABLED ? 'on' : 'observe',
      nota: 'el modo efectivo es por clinica: ver GET /admin/settings',
      ...csatMetrics
    },
    hermesMode: getHermesStatus()
  };
});

// --- Datos de la clínica: ver y vaciar --------------------------------------
//
// La clínica SIEMPRE sale de checkAuth, o sea del token de sesión. Nunca del
// cuerpo de la petición. Es lo único que impide que una clínica borre datos de
// otra manipulando el navegador, y por eso no hay ni un parámetro para elegirla.

server.get('/admin/data/counts', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  try {
    return { ok: true, tenant_id: tenantId, tablas: await contarFilas(tenantId) };
  } catch (err: any) {
    return reply.status(500).send({ error: true, error_code: 'DATA_COUNTS_FAILED' });
  }
});

server.post('/admin/data/purge', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  const cuerpo = (request.body || {}) as { tables?: unknown; confirmation?: unknown };

  const resultado = await purgarDatos({
    tenantId,
    solicitadoPor: tenantId,
    tablas: cuerpo.tables,
    confirmacion: cuerpo.confirmation,
    ip: request.ip || null
  });

  if (!resultado.ok) {
    // 400 y no 500: los fallos aquí son de lo que pidió quien llama -confirmación
    // que no coincide, tabla fuera de la lista blanca-, no del servidor.
    return reply.status(400).send({ error: true, error_code: resultado.error });
  }
  return resultado;
});

// --- Ajustes de la clínica ---------------------------------------------------
//
// Misma regla que arriba: la clínica sale del token, no del cuerpo. Aquí importa
// igual, porque cambiar el buffer de otra clínica le cambiaría el comportamiento
// del bot a un negocio ajeno.

server.get('/admin/settings', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  return { ok: true, tenant_id: tenantId, ...(await leerAjustes(tenantId)) };
});

// Un solo endpoint para todos los ajustes: se manda solo lo que cambia, y si algo
// viene mal NO se guarda nada. Media peticion aplicada dejaria la pantalla
// mostrando un estado distinto del que hay de verdad.
server.post('/admin/settings', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  const resultado = await guardarAjustes(tenantId, (request.body || {}) as Record<string, unknown>);
  if (!resultado.ok) {
    return reply.status(400).send({ error: true, error_code: resultado.error });
  }
  return resultado;
});


// --- LA AGENDA, SERVIDA COMO MCP --------------------------------------------
//
// Es lo que llama Hermes desde el perfil de cada clinica, igual que llama a Cal.com hoy.
//
// DE QUE CLINICA ES CADA LLAMADA LO DICE EL TOKEN, y no hay ningun parametro `tenant_id`
// ni lo va a haber. Al otro lado hay un modelo de lenguaje: si la clinica viajara como
// argumento, bastaria con que un paciente escribiera «consulta la agenda de la clinica
// lapaz» para que Helios lo intentara -no por malicia, sino porque hace lo que le piden-.
//
// NO LLEVA `checkAuth`: eso es para el panel, con sesiones que caducan. Aqui la credencial
// vive en el `.env` de un perfil de Hermes, donde nadie la va a renovar.
server.post('/mcp', async (request, reply) => {
  const tenantId = clinicaDelToken(tokenDeLaCabecera((request.headers as any)?.authorization));
  if (!tenantId) {
    // 401 SECO, SIN DECIR POR QUE. Distinguir «token mal firmado» de «clinica que no
    // existe» le dice a quien prueba por donde seguir probando.
    return reply.status(401).send({ error: 'unauthorized' });
  }

  const peticion = request.body as any;

  // UN LOTE ES UN ARRAY. JSON-RPC lo permite y algun cliente lo usa al arrancar.
  const mensajes = Array.isArray(peticion) ? peticion : [peticion];
  if (mensajes.length === 0 || mensajes.length > 50) {
    return reply.status(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }

  let ctx: any;
  try {
    const ajustes = await leerAjustes(tenantId) as any;
    const { horario, zona } = await obtenerHorarioYVentana(tenantId);
    ctx = {
      tenantId,
      doctores: leerDoctores(ajustes.clinic_doctors, horario as any) ?? [],
      cierresTexto: ajustes.clinic_closures,
      horario,
      zona,
      // Para devolver `location` al confirmar, que es lo que hacia Cal.com (SOUL, linea 125).
      direccion: ajustes.clinic_address
    };
  } catch (err: any) {
    // SI NO SE PUEDEN LEER LOS AJUSTES NO SE CONTESTA CON UNA AGENDA VACIA. Una lista de
    // doctores vacia se leeria como «esta clinica no tiene doctores», y Helios diria que no
    // hay con quien citar. Un 503 lo hace derivar, que es lo correcto.
    return reply.status(503).send({
      jsonrpc: '2.0', id: null,
      error: { code: -32000, message: 'ajustes_no_disponibles' }
    });
  }

  const salidas: any[] = [];
  for (const m of mensajes) {
    const r = await atenderMcp(m, ctx);
    if (r) salidas.push(r);
  }

  // SIN NADA QUE CONTESTAR, 202 Y CUERPO VACIO. Es lo que manda el transporte de MCP para
  // un lote que solo traia notificaciones; mandar `null` o un 200 vacio confunde al cliente.
  if (salidas.length === 0) return reply.status(202).send();
  return Array.isArray(peticion) ? salidas : salidas[0];
});

// COMPROBAR LA AGENDA. Existe por el paso 5 del manual -compartir cada calendario con la
// cuenta de servicio- que es el que se olvida y el que no da error en ninguna pantalla:
// Google devuelve el fallo junto a una lista de ocupacion vacia, o sea, un doctor que
// parece libre. Sin esto, la primera senal seria un paciente citado a una hora ya cogida.
//
// SOLO LEE. No crea ningun evento de prueba: dejar basura en el calendario de un doctor
// para comprobar que se puede escribir es peor que no comprobarlo.
server.get('/admin/agenda/prueba', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  const consulta = (request.query || {}) as { servicio?: string; dias?: string };

  try {
    const ajustes = await leerAjustes(tenantId) as any;
    const { horario, zona } = await obtenerHorarioYVentana(tenantId);
    const informe = await probarAgenda({
      doctoresTexto: ajustes.clinic_doctors,
      cierresTexto: ajustes.clinic_closures,
      horario,
      zona,
      servicio: consulta.servicio,
      dias: consulta.dias ? Number(consulta.dias) : undefined
    });
    return { tenant_id: tenantId, ...informe };
  } catch (err: any) {
    // 200 CON EL PROBLEMA DENTRO, y no un 500. Esto es un diagnostico: quien lo abre
    // quiere saber que pasa, y un 500 en el panel solo dice «algo fallo».
    return {
      tenant_id: tenantId, ok: false, zona: '', doctores: [], cierres: [], huecos: [],
      usando: { horario: [], ventana: '', huecos_sin_filtrar: 0, duracion_min: 0, margen_min: 0 },
      problemas: [`No se pudo hacer la comprobacion: ${err?.message || 'error desconocido'}`]
    };
  }
});

// EL TOKEN DE LA AGENDA, PARA PEGARLO EN EL `.env` DEL PERFIL DE HERMES.
//
// VA EN UN ENDPOINT APARTE Y NO EN EL INFORME DE `/admin/agenda/prueba`. El informe se mira
// a menudo -y con alguien mirando la pantalla-; el token se necesita una vez, al dar de
// alta la clinica. Un secreto que sale solo cuando se pide es un secreto que casi nunca
// esta a la vista.
//
// LA CLINICA SALE DEL TOKEN DE SESION, como en todo el panel: cada quien ve el suyo.
server.get('/admin/agenda/token', async (request, reply) => {
  const tenantId = await checkAuth(request, reply);
  return { ok: true, tenant_id: tenantId, token: tokenDeAgenda(tenantId) };
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

    if (!verificarContrasena(password, tenant.password_hash)) {
      return reply.status(401).send({ error: 'Credenciales inválidas.' });
    }

    // La contraseña era correcta. Si estaba guardada EN CLARO —como estuvo hasta
    // el 15-08-2026— se reescribe cifrada ahora mismo. Así la tabla se migra sola
    // a medida que la gente entra, sin script y sin que nadie se quede fuera.
    if (!esHashSeguro(tenant.password_hash)) {
      await supabase
        .from('helios_tenants')
        .update({ password_hash: cifrarContrasena(password) })
        .eq('tenant_id', tenant.tenant_id)
        .then(({ error: upgradeError }) => {
          if (upgradeError) {
            // No se bloquea el acceso por esto: la contraseña ya se verificó. Se
            // reintentará en el siguiente inicio de sesión.
            console.warn(JSON.stringify({
              event: 'password_upgrade_failed',
              tenant_id: tenant.tenant_id
            }));
          } else {
            console.log(JSON.stringify({
              event: 'password_upgraded_to_hash',
              tenant_id: tenant.tenant_id
            }));
          }
        });
    }

    // SI ESTA CUENTA ES DE OPERADOR, la sesion lo lleva dentro. Se lee de la fila y no
    // de nada que mande el navegador; el token va firmado, asi que nadie puede añadirselo.
    const esOperador = tenant.es_operador === true;

    return {
      ok: true,
      token: createAdminSessionToken(tenant.tenant_id, esOperador ? tenant.tenant_id : null),
      operador: esOperador,
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
  const sesion = verifyAdminSessionToken(token);
  const tenantId = sesion?.tenant_id;
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

/**
 * La sesion completa, con el rol. Solo la usan los dos endpoints del selector de cuentas.
 *
 * VA APARTE DE `checkAuth` A PROPOSITO. checkAuth sigue devolviendo un tenant_id y nada
 * mas, asi que NINGUN endpoint existente cambia: todos siguen sacando el tenant del token
 * y ninguno acepta un tenant como parametro. Esa es la propiedad que hace que el selector
 * no toque el aislamiento entre clinicas.
 */
function sesionDelPanel(request: any): SesionDelPanel | null {
  const authHeader = request.headers?.authorization;
  if (!authHeader) return null;
  return verifyAdminSessionToken(String(authHeader).replace('Bearer ', '').trim());
}

/**
 * Comprueba que la sesion es de operador, CONTRA LA BASE DE DATOS y no solo contra el
 * token.
 *
 * El token va firmado, asi que su `operador` es de fiar. Pero se vuelve a mirar la fila
 * igualmente: asi quitarle el permiso a alguien surte efecto EN EL MOMENTO, y no cuando le
 * caduque la sesion. Para un permiso que deja ver los datos de todas las clinicas, esperar
 * a que caduque una sesion no es aceptable.
 */
async function exigirOperador(request: any, reply: any): Promise<string | null> {
  const sesion = sesionDelPanel(request);

  // La fila SOLO se consulta si la sesion dice ser de operador. Preguntar por una fila
  // nula seria pedirle a la base de datos algo sin sentido, y ademas dejaria la decision
  // dependiendo de como reaccione Supabase a un id vacio en vez de de una regla nuestra.
  let fila: { es_operador?: unknown } | null = null;
  if (sesion?.operador) {
    const { data } = await supabase
      .from('helios_tenants')
      .select('tenant_id, es_operador')
      .eq('tenant_id', sesion.operador)
      .single();
    fila = data ?? null;
  }

  const motivo = puedeCambiarDeCuenta(sesion, fila);
  if (motivo !== 'permitido') {
    reply.status(estadoHttpDe(motivo)).send({ error: 'No autorizado.', motivo });
    return null;
  }
  return sesion!.operador!;
}

// GET /admin/cuentas — las clinicas entre las que puede moverse un operador.
//
// DEVUELVE LO MINIMO: identificador y nombre. Es una lista para un desplegable, no una
// ventana a los datos de nadie; para ver una cuenta hay que cambiarse a ella y entonces
// el token apunta ahi.
server.get('/admin/cuentas', async (request, reply) => {
  const operador = await exigirOperador(request, reply);
  if (!operador) return;

  // LAS CUENTAS DE OPERADOR NO SON CLINICAS Y NO SE LISTAN. La fila del equipo que opera
  // no tiene pacientes, ni horario, ni citas: cambiarse «a ella» dejaria el panel vacio
  // sin que nada explicara por que. Se listan las clinicas, que es lo que hay que mirar.
  const { data, error } = await supabase
    .from('helios_tenants')
    .select('tenant_id, name')
    .or('es_operador.is.null,es_operador.eq.false')
    .order('name', { ascending: true });

  if (error) return reply.status(500).send({ error: 'No se pudieron leer las cuentas.' });

  const actual = sesionDelPanel(request)?.tenant_id ?? null;

  // Y SE DICE SI LA CUENTA ACTUAL ESTA EN LA LISTA. Al entrar como operador se esta en la
  // fila de operador, que no es ninguna clinica: el panel lo usa para pedir que se elija
  // una en vez de mostrar seleccionada la primera, que seria mentira.
  const enLaLista = (data ?? []).some((c: any) => c.tenant_id === actual);

  return { ok: true, actual, actual_es_clinica: enLaLista, cuentas: data ?? [] };
});

// POST /admin/cambiar-cuenta — un token nuevo apuntando a otra clinica.
//
// ESTO ES TODO LO QUE HACE EL SELECTOR: pedir un token distinto. No abre una segunda
// sesion ni deja ver dos cuentas a la vez, y no hay ningun endpoint al que se le pueda
// pasar un tenant. Cambiar de cuenta es cambiar de token, y el token lo emite el servidor.
server.post('/admin/cambiar-cuenta', async (request, reply) => {
  const operador = await exigirOperador(request, reply);
  if (!operador) return;

  const destino = String((request.body as any)?.tenant_id ?? '').trim();
  if (!destino) return reply.status(400).send({ error: 'Falta la cuenta.' });

  // La cuenta de destino tiene que EXISTIR. Sin esto se emitiria un token para un
  // tenant inventado, y aunque no daria acceso a nada, dejaria el panel en un estado
  // sin explicacion.
  const { data, error } = await supabase
    .from('helios_tenants')
    .select('tenant_id, name')
    .eq('tenant_id', destino)
    .single();

  if (error || !data) return reply.status(404).send({ error: 'Esa cuenta no existe.' });

  console.log(JSON.stringify({
    event: 'operador_cambio_de_cuenta',
    operador_fingerprint: crypto.createHash('sha256').update(operador).digest('hex').slice(0, 12),
    destino: data.tenant_id
  }));

  return {
    ok: true,
    token: createAdminSessionToken(data.tenant_id, operador),
    tenant: { tenant_id: data.tenant_id, name: data.name }
  };
});

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
  // Exponia metricas de la clinica sin pedir nada. El panel ya mandaba el token.
  const tenantIdAutenticado = await checkAuth(request, reply);
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
  // Exponia estadisticas de la clinica sin pedir nada.
  await checkAuth(request, reply);
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

  // --- LOS ARCHIVOS SE CONVIERTEN EN TEXTO AQUI ----------------------------
  //
  // AQUI Y NO EN OTRO SITIO. Despues de la idempotencia, porque si Chatwoot reintenta el
  // webhook no se paga Gemini dos veces por la misma nota de voz; y antes del buffer,
  // porque desde el buffer hacia dentro -Hermes, el contrato, las metricas- todo el
  // sistema ve texto y no hace falta cambiar nada mas.
  if (normalized.adjuntos && normalized.adjuntos.length > 0) {
    try {
      const media = await procesarMediaDelMensaje({
        texto: normalized.text,
        adjuntos: normalized.adjuntos
      });

      // El gasto se registra SIEMPRE, incluso cuando el mensaje se ignora. «Ignorar»
      // significa no contestar, no no enterarse: si manana el clasificador empieza a
      // comerse fotos de pacientes de verdad, tiene que poder verse aqui. Y una cadena
      // ignorada CUESTA DINERO sin generar respuesta, asi que sin esta fila ese gasto
      // seria invisible en el panel.
      for (const gasto of media.gastos) {
        await mediaRepository.registrar({
          tenant_id: normalized.tenant_id,
          conversation_id: normalized.conversation_id,
          contact_id: normalized.contact_id,
          trace_id: normalized.trace_id,
          tipo: gasto.tipo,
          extension: gasto.extension,
          categoria: gasto.categoria,
          accion: gasto.accion,
          modelo: config.GEMINI_MODEL,
          // El nivel se guarda TAL COMO ESTABA en este momento, no se deduce despues.
          nivel: config.GEMINI_NIVEL,
          input_tokens: gasto.input_tokens,
          output_tokens: gasto.output_tokens,
          error: gasto.error
        });
      }

      if (media.ignorarMensaje) {
        // UNA CADENA REENVIADA NO MERECE RESPUESTA, y lo pidio David asi: «si no tiene
        // nada que ver, que no lo pase a nadie, que lo ignore, el paciente no reciba ni
        // respuesta». No entra en el buffer, asi que no hay turno ni coste de DeepSeek.
        log.info({
          conversation_id: normalized.conversation_id,
          categorias: media.gastos.map(g => g.categoria)
        }, 'Mensaje ignorado: solo archivos sin relacion con la clinica.');
        debugTracker.updateEvent(normalized.trace_id, {
          decision: 'ignored', reason: 'media_irrelevante'
        } as any);
        return { ok: true, status: 'ignored', reason: 'media_irrelevante' };
      }

      normalized.text = media.texto;
      debugTracker.updateEvent(normalized.trace_id, { text: media.texto } as any);
      log.info({
        conversation_id: normalized.conversation_id,
        archivos: media.gastos.length,
        derivar: media.derivar
      }, 'Archivos convertidos en texto.');
    } catch (error: any) {
      // SI ESTO FALLA, EL MENSAJE SIGUE. Un fallo procesando el archivo no puede dejar al
      // paciente sin respuesta: Hermes recibe la linea de abajo y pide que se lo escriban.
      log.error({ err: error?.message }, 'No se pudieron procesar los archivos del mensaje.');
      normalized.text = [
        normalized.text,
        '[El paciente ha enviado un archivo que no se ha podido leer. Pidele con amabilidad que te lo escriba.]'
      ].filter(Boolean).join('\n\n');
    }
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

// 4. GET /admin/conversation-mode  -  quien atiende esta conversacion AHORA
//
// El panel necesita saberlo sin interpretar booleanos: son TRES estados y no dos.
// La frase que se muestra la escribe describirModo(), no el navegador, para que
// panel y backend no puedan discrepar.
server.get('/admin/conversation-mode', async (request, reply) => {
  await checkAuth(request, reply);
  const { tenant_id, conversation_id, contact_id } = request.query as any;
  if (!tenant_id || !conversation_id) {
    return reply.status(400).send({ error: 'tenant_id y conversation_id son obligatorios.' });
  }
  const fila = contact_id
    ? await stateRepository.getRefined(tenant_id, conversation_id, contact_id)
    : await stateRepository.get(tenant_id, conversation_id);
  return { ok: true, existe: Boolean(fila), ...describirModo(fila) };
});

// 5. POST /admin/conversation-mode  -  cambiarlo, de verdad
//
// LO QUE HABIA ANTES ESTABA ROTO DE DOS FORMAS, y las dos se arreglan aqui:
//
//  1. Escribia contact_id: 'unknown' e inbox_id: 'unknown' ENCIMA de los reales,
//     porque el upsert persiste todos los campos que recibe. Corrompia la fila.
//     La prueba de que ya paso: getRefined() lleva un fallback escrito
//     explicitamente «para saltar filas unknown corruptas».
//  2. Movia human_handoff_active, que es un booleano DERIVADO, y no tocaba stage,
//     que es la fuente de verdad. Respondia ok y Helios seguia sin contestar.
//
// Ahora se lee la fila real primero, y devolver una conversacion derivada usa el
// camino canonico -returnConversationToBot- que limpia el handoff y avisa en
// Chatwoot, en vez de un UPDATE a mano.
server.post('/admin/conversation-mode', async (request, reply) => {
  await checkAuth(request, reply);
  const { tenant_id, conversation_id, modo } = request.body as any;
  if (!tenant_id || !conversation_id) {
    return reply.status(400).send({ error: 'tenant_id y conversation_id son obligatorios.' });
  }
  if (modo !== 'helios' && modo !== 'pausada') {
    return reply.status(400).send({ error: "modo tiene que ser 'helios' o 'pausada'." });
  }

  const fila = await stateRepository.get(tenant_id, conversation_id);
  if (!fila) {
    return reply.status(404).send({ error: 'Esa conversación no tiene estado guardado.' });
  }
  const antes = describirModo(fila);
  const accion = accionPara(antes.modo, modo);

  if (accion === 'nada') {
    return { ok: true, cambiado: false, accion, antes, despues: antes };
  }

  // Los identificadores salen de la FILA, nunca del cuerpo de la peticion ni de
  // un literal. Es lo que impide volver a escribir 'unknown'.
  const contactId = String(fila.contact_id ?? '');
  const inboxId = String(fila.inbox_id ?? '');
  const phone = String(fila.phone ?? '');

  if (accion === 'devolver_a_helios') {
    await returnConversationToBot({
      tenantContext: resolveTenantContextByTenantId(tenant_id),
      conversation_id: String(conversation_id),
      contact_id: contactId,
      inbox_id: inboxId,
      phone,
      trace_id: `panel-modo-${conversation_id}`,
      handoff_id: fila.handoff_id ?? null
    });
  } else {
    await stateRepository.upsert({
      tenant_id,
      conversation_id: String(conversation_id),
      contact_id: contactId,
      inbox_id: inboxId,
      ai_enabled: accion === 'encender_ia'
    });
  }

  const filaDespues = await stateRepository.get(tenant_id, conversation_id);
  const despues = describirModo(filaDespues);
  console.log(JSON.stringify({
    event: 'modo_conversacion_cambiado_desde_panel',
    tenant_id,
    conversation_id,
    accion,
    de: antes.modo,
    a: despues.modo
  }));
  return { ok: true, cambiado: despues.modo !== antes.modo, accion, antes, despues };
});

// 6. POST /admin/conversation-reset  -  «empezar esta conversacion de cero»
//
// EL PROBLEMA QUE RESUELVE: casi todas las pruebas de esta semana salieron
// contaminadas por el historial. Helios tuteaba en una conversacion vieja y trataba
// de usted en una nueva, con el mismo prompt y en el mismo minuto. Repetia una
// direccion de Madrid leyendola de sus propios mensajes de hacia un mes. Se negaba a
// dar la direccion porque en cuatro turnos anteriores se habia negado.
//
// Hasta ahora esto eran tres comandos dentro del contenedor del Adapter y un
// reinicio. Y ni funcionaba: el proceso tenia el mapa de sesiones en memoria.
//
// NO PROMETE EFECTO INMEDIATO. Surte efecto en el siguiente mensaje del paciente, y
// el mensaje que devuelve lo dice. El panel ya nos hizo una vez la de responder
// «hecho» sin haber hecho nada.
server.post('/admin/conversation-reset', async (request, reply) => {
  await checkAuth(request, reply);
  const { tenant_id, conversation_id } = request.body as any;
  if (!tenant_id || !conversation_id) {
    return reply.status(400).send({ error: 'tenant_id y conversation_id son obligatorios.' });
  }

  const resultado = await pedirEmpezarDeCero({
    tenantId: String(tenant_id),
    conversationId: String(conversation_id),
    pedidoPor: 'panel'
  });

  console.log(JSON.stringify({
    event: 'conversacion_empieza_de_cero_pedido',
    tenant_id,
    conversation_id,
    habia_sesion: resultado.habia_sesion,
    turnos_descartados: resultado.turnos_descartados,
    tokens_del_ultimo_turno: resultado.tokens_del_ultimo_turno
  }));

  return resultado;
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
const stopLeadFollowupWorker = process.env.NODE_ENV !== 'test'
  ? startLeadFollowupWorker()
  : async () => {};
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
  await stopLeadFollowupWorker();
  
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

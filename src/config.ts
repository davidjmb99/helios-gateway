import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// Helpers para parsear de forma robusta en Coolify
function envBool(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function envNumber(value: unknown, defaultValue: number): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export type RecoveryMode = 'disabled' | 'observe' | 'ai_only' | 'delivery_only' | 'full';

export function parseRecoveryMode(value: unknown): RecoveryMode {
  const normalized = String(value ?? 'observe').trim().toLowerCase();
  if (['disabled', 'observe', 'ai_only', 'delivery_only', 'full'].includes(normalized)) {
    return normalized as RecoveryMode;
  }
  console.warn(JSON.stringify({
    event: 'invalid_recovery_mode',
    configured_value_present: Boolean(value),
    fallback: 'observe'
  }));
  return 'observe';
}

/**
 * LAS VARIABLES HERMES_* DE ESTE SERVICIO NO APUNTAN A HERMES. APUNTAN AL ADAPTER.
 *
 * Es el nombre mas peligroso de toda la instalacion, y salio en la auditoria de
 * variables del 18 de agosto de 2026. El Gateway NUNCA habla con Hermes: habla con
 * el helios-hermes-adapter, y es el Adapter quien habla con Hermes. Pero las
 * variables se llaman HERMES_BASE_URL, HERMES_API_KEY, HERMES_ENDPOINT...
 *
 * El accidente que esto provoca es concreto: alguien lee «HERMES_BASE_URL», piensa
 * «esto es Hermes», le pone la URL real de Hermes -el puerto 8643- y el Gateway
 * empieza a hablar con Hermes directamente. Se salta el Adapter, y con el se salta
 * la idempotencia, el contrato, la caja negra y el registro de tokens. Todo
 * seguiria pareciendo que funciona hasta que algo fallara sin dejar rastro.
 *
 * Se aceptan los dos juegos de nombres: ADAPTER_* es el correcto y tiene
 * prioridad; HERMES_* sigue funcionando para no romper el despliegue actual, pero
 * avisa en el log al arrancar. Las claves internas del objeto config se dejan como
 * estan a proposito: renombrar 33 usos es mucho ruido para un problema que esta en
 * lo que LEE una persona, no en lo que compila el codigo.
 */
function leerVariableDelAdapter(sufijo: string): string | undefined {
  const nombreBueno = `ADAPTER_${sufijo}`;
  const nombreViejo = `HERMES_${sufijo}`;
  const valorBueno = process.env[nombreBueno];
  if (valorBueno !== undefined && String(valorBueno).trim() !== '') return valorBueno;

  const valorViejo = process.env[nombreViejo];
  if (valorViejo !== undefined && String(valorViejo).trim() !== '') {
    nombresViejosEnUso.push(`${nombreViejo} -> ${nombreBueno}`);
    return valorViejo;
  }
  return undefined;
}

const nombresViejosEnUso: string[] = [];

// Configuración del ADAPTER parseada de forma segura. Se llama hermes* por
// compatibilidad con los 33 usos que ya existen; lo que hay al otro lado es el
// Adapter.
const hermesEnabled = envBool(leerVariableDelAdapter('ENABLED'), true);
const hermesMock = envBool(leerVariableDelAdapter('MOCK'), false);
const hermesTimeoutMs = envNumber(leerVariableDelAdapter('TIMEOUT_MS'), 30000);

// Esquema Zod más relajado para variables básicas esenciales (Supabase y Chatwoot)
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  BUFFER_MS: z.coerce.number().default(5000),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  CHATWOOT_BASE_URL: z.string().url().default('https://app.chatwoot.com'),
  CHATWOOT_ACCOUNT_ID: z.string().optional().or(z.literal('')),
  CHATWOOT_API_TOKEN: z.string().optional().or(z.literal('')),
  CHATWOOT_HUMAN_TEAM_ID: z.string().optional().or(z.literal('')),
  CHATWOOT_HUMAN_ASSIGNEE_ID: z.string().optional().or(z.literal('')),



  CLINIC_ID: z.string().default('coi_demo'),
  CLINIC_TIMEZONE: z.string().default('Europe/Madrid'),
  CLINIC_TONE: z.string().default('es-ES'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.warn('⚠️ Advertencia en variables de entorno básicas, se usarán valores por defecto donde sea posible:', parsed.error.format());
}

// Consolidar la configuración segura final
export const config = {
  PORT: parsed.data?.PORT ?? 3000,
  BUFFER_MS: parsed.data?.BUFFER_MS ?? 5000,
  SUPABASE_URL: parsed.data?.SUPABASE_URL ?? process.env.SUPABASE_URL ?? '',
  SUPABASE_SERVICE_ROLE_KEY: parsed.data?.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  
  // Variables de Hermes Seguras
  HERMES_ENABLED: hermesEnabled,
  HERMES_MOCK: hermesMock,
  HERMES_BASE_URL: (leerVariableDelAdapter('BASE_URL') ?? '').trim(),
  HERMES_ENDPOINT: (leerVariableDelAdapter('ENDPOINT') ?? '/helios/message').trim(),
  HERMES_API_KEY: (leerVariableDelAdapter('API_KEY') ?? '').trim(),
  HERMES_MODEL: (leerVariableDelAdapter('MODEL') ?? 'default').trim(),
  HERMES_PROFILE: (process.env.HERMES_PROFILE ?? 'helios').trim(),
  HERMES_CWD: (leerVariableDelAdapter('CWD') ?? '').trim(),
  HERMES_SOUL_PATH: (leerVariableDelAdapter('SOUL_PATH') ?? '').trim(),
  HERMES_TIMEOUT_MS: hermesTimeoutMs,
  HELIOS_RECOVERY_MODE: parseRecoveryMode(process.env.HELIOS_RECOVERY_MODE),
  HELIOS_ADMIN_SHOW_PII: envBool(process.env.HELIOS_ADMIN_SHOW_PII, false),
  HELIOS_ADMIN_SESSION_SECRET: (process.env.HELIOS_ADMIN_SESSION_SECRET ?? '').trim(),
  HELIOS_ADMIN_SESSION_TTL_MS: envNumber(process.env.HELIOS_ADMIN_SESSION_TTL_MS, 8 * 60 * 60 * 1000),
  HELIOS_BATCH_LEASE_MS: Math.max(
    envNumber(process.env.HELIOS_BATCH_LEASE_MS, 180000),
    hermesTimeoutMs + 60000
  ),
  HELIOS_OUTBOX_LEASE_MS: envNumber(process.env.HELIOS_OUTBOX_LEASE_MS, 60000),
  CHATWOOT_TIMEOUT_MS: envNumber(process.env.CHATWOOT_TIMEOUT_MS, 15000),

  // --- Archivos: audios, imagenes, videos y documentos ---
  //
  // Sin GEMINI_API_KEY, los archivos siguen ENTRANDO al sistema -no se descartan como
  // antes- pero llegan a Hermes sin procesar: «[nota de voz que no se pudo transcribir]».
  // Es peor que transcribirla y muchisimo mejor que el silencio de antes.
  // SE LIMPIAN LOS DOS, y no es por pulcritud. Un espacio invisible al final del nombre
  // del modelo -de copiar y pegar en Coolify- se convierte en «%20» al montar la URL y
  // Google devuelve un 404 identico al de un modelo que no existe. Con la clave es peor:
  // un salto de linea pegado la invalida y el error dice «clave rechazada», que manda a
  // buscar el problema a la consola de Google en vez de al campo del formulario.
  //
  // Los dos fallos son invisibles: `echo "[$GEMINI_MODEL]"` imprime lo mismo con espacio
  // que sin el si el espacio va justo antes del corchete de cierre.
  GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
  // EL VALOR POR DEFECTO CAMBIO EL 24-ago-2026. gemini-2.5-flash-lite sigue listado y
  // sigue en la pagina de precios de Google, pero esta CERRADO A CLAVES NUEVAS: devuelve
  // un 404 diciendo «no longer available to new users, please update your code to use
  // models/gemini-3.5-flash-lite». Con la clave y el nombre perfectamente correctos.
  GEMINI_MODEL: (process.env.GEMINI_MODEL || '').trim() || 'gemini-3.5-flash-lite',

  /**
   * Que nivel de la API de Gemini se esta usando. Lo DECLARA el operador, no se detecta:
   * no hay forma fiable de saberlo desde la clave.
   *
   * Existe porque el nivel gratuito usa el contenido para entrenar los modelos de Google
   * -su tabla de precios dice «Data usage: Yes»- y eso serian la voz y las fotos de los
   * pacientes. El plan es «gratis para probar, de pago para produccion», y eso es
   * exactamente el tipo de cosa que se queda olvidada. Mientras diga «gratuito», el panel
   * lo avisa en rojo.
   *
   * Por defecto «gratuito»: si nadie lo declara, se avisa. Es el lado seguro.
   */
  GEMINI_NIVEL: (process.env.GEMINI_NIVEL || 'gratuito').trim().toLowerCase() === 'pago'
    ? 'pago' as const
    : 'gratuito' as const,

  /** Tiempo maximo para descargar el archivo y para la llamada al modelo, por separado. */
  MEDIA_TIMEOUT_MS: envNumber(process.env.MEDIA_TIMEOUT_MS, 20000),

  // --- Handoff humano ---
  // Con el flag apagado el comportamiento es exactamente el de antes del bloque
  // de handoff: la IA se bloquea con el booleano legacy, sin efectos en Chatwoot
  // ni avisos al equipo. Es la palanca de rollback sin volver por SHA.
  // El bloqueo de Hermes por stage y la captura de los mensajes del equipo
  // humano NO dependen de este flag: son propiedades de seguridad.
  HELIOS_HANDOFF_ENABLED: envBool(process.env.HELIOS_HANDOFF_ENABLED, false),
  HELIOS_NOTIFICATION_LEASE_MS: envNumber(process.env.HELIOS_NOTIFICATION_LEASE_MS, 60000),
  HELIOS_NOTIFICATION_MAX_ATTEMPTS: envNumber(process.env.HELIOS_NOTIFICATION_MAX_ATTEMPTS, 8),
  HELIOS_NOTIFICATION_POLL_MS: envNumber(process.env.HELIOS_NOTIFICATION_POLL_MS, 15000),
  HELIOS_HUMAN_TRANSCRIPT_LIMIT: envNumber(process.env.HELIOS_HUMAN_TRANSCRIPT_LIMIT, 16),
  // Mensajes del resumen que ve el equipo en la nota privada y en el aviso.
  HELIOS_RECAP_MESSAGE_LIMIT: envNumber(process.env.HELIOS_RECAP_MESSAGE_LIMIT, 8),
  // Un handoff sin actividad más de estas horas vuelve solo a la IA: no se puede
  // depender de que alguien se acuerde de escribir /fin.
  HELIOS_HANDOFF_STALE_HOURS: envNumber(process.env.HELIOS_HANDOFF_STALE_HOURS, 5),
  HELIOS_HANDOFF_SWEEP_MS: envNumber(process.env.HELIOS_HANDOFF_SWEEP_MS, 10 * 60 * 1000),
  // --- Encuesta de satisfacción (CSAT) ---
  // APAGADO por defecto, y no es celo excesivo: un fallo aquí significa mandarle
  // una encuesta de satisfacción a un paciente que acaba de quejarse. Con el flag
  // apagado se sigue anotando en Supabase qué conversaciones serían aptas y qué
  // conversaciones quedan excluidas y por qué, pero NO se escribe ninguna
  // etiqueta en Chatwoot. Así se puede comprobar la decisión con datos reales
  // antes de dejar que toque el flujo de encuestas de la clínica.
  HELIOS_CSAT_ENABLED: envBool(process.env.HELIOS_CSAT_ENABLED, false),
  // --- Seguimiento de leads ---
  // APAGADO por defecto. Con el flag apagado se anota quien es lead, quien queda
  // descartado y con que texto EXACTO se le habria escrito, pero no le llega nada
  // a nadie. Un fallo aqui significa mandarle publicidad a un paciente que se fue
  // enfadado, o escribir a alguien fuera del plazo de WhatsApp.
  HELIOS_LEADS_ENABLED: envBool(process.env.HELIOS_LEADS_ENABLED, false),
  HELIOS_LEADS_SWEEP_MS: envNumber(process.env.HELIOS_LEADS_SWEEP_MS, 10 * 60 * 1000),
  TELEGRAM_BOT_TOKEN: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
  TELEGRAM_API_BASE_URL: (process.env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org').trim(),

  CHATWOOT_BASE_URL: parsed.data?.CHATWOOT_BASE_URL ?? 'https://app.chatwoot.com',
  CHATWOOT_ACCOUNT_ID: parsed.data?.CHATWOOT_ACCOUNT_ID ?? '',
  CHATWOOT_API_TOKEN: parsed.data?.CHATWOOT_API_TOKEN ?? '',
  CHATWOOT_HUMAN_TEAM_ID: parsed.data?.CHATWOOT_HUMAN_TEAM_ID ?? '',
  CHATWOOT_HUMAN_ASSIGNEE_ID: parsed.data?.CHATWOOT_HUMAN_ASSIGNEE_ID ?? '',



  // CALCOM_API_KEY, CALCOM_BASE_URL y HUBSPOT_ACCESS_TOKEN se quitaron el
  // 19-ago-2026: el Gateway NO llama a Cal.com ni a HubSpot. Lo hacen los MCP de
  // Hermes, con sus propias credenciales. Tres secretos declarados y sin usar son
  // superficie de fuga a cambio de nada. Se pueden borrar tambien de Coolify.
  CLINIC_ID: parsed.data?.CLINIC_ID ?? 'coi_demo',
  CLINIC_TIMEZONE: parsed.data?.CLINIC_TIMEZONE ?? 'Europe/Madrid',
  CLINIC_TONE: parsed.data?.CLINIC_TONE ?? 'es-ES'
};

/**
 * Avisos de arranque sobre la configuracion del Adapter.
 *
 * AVISA, NO ABORTA. Aqui no se puede negar el arranque: la instalacion actual usa
 * los nombres viejos y tumbarla al desplegar seria peor que el problema que se
 * quiere evitar. El Adapter SI aborta con su transporte porque ahi no hay ninguna
 * eleccion valida ambigua; aqui las dos son validas y una solo esta mal nombrada.
 */
function avisarSobreLaConfiguracionDelAdapter(): void {
  if (nombresViejosEnUso.length > 0) {
    console.warn(JSON.stringify({
      event: 'nombres_de_variable_obsoletos',
      // Sin valores: solo los nombres. Algunos de estos son claves de API.
      renombrar: nombresViejosEnUso,
      por_que: 'Estas variables apuntan al ADAPTER, no a Hermes. El nombre HERMES_* '
        + 'invita a ponerles la URL de Hermes y saltarse el Adapter entero.',
      accion: 'Duplicarlas con el prefijo ADAPTER_ en Coolify y borrar las viejas. '
        + 'Las dos formas funcionan mientras se hace el cambio.'
    }));
  }

  // EL ACCIDENTE QUE SE VIGILA: que la URL sea la de Hermes y no la del Adapter.
  // Hermes Agent vive en el puerto 8643 y su ruta es /v1/responses. Si aparece
  // cualquiera de las dos cosas aqui, el Gateway estaria hablando con Hermes
  // directamente: sin idempotencia, sin contrato, sin caja negra y sin registro de
  // tokens. Todo pareceria normal hasta que algo fallara sin dejar rastro.
  const url = config.HERMES_BASE_URL;
  const sospechas: string[] = [];
  if (/:8643(\/|$)/.test(url)) sospechas.push('el puerto 8643 es el de Hermes Agent');
  if (config.HERMES_ENDPOINT.includes('/v1/responses')) {
    sospechas.push('/v1/responses es la ruta de Hermes Agent, no la del Adapter');
  }
  if (sospechas.length > 0) {
    console.error(JSON.stringify({
      event: 'la_url_del_adapter_parece_ser_hermes',
      sospechas,
      consecuencia: 'El Gateway se saltaria el Adapter: sin idempotencia, sin '
        + 'validacion de contrato, sin contract_debug y sin coste por mensaje.',
      accion: 'Comprobar que ADAPTER_BASE_URL apunta al helios-hermes-adapter.'
    }));
  }
}

avisarSobreLaConfiguracionDelAdapter();

export type Config = typeof config;

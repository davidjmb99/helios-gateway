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

// Configuración de Hermes parseada de forma segura
const hermesEnabled = envBool(process.env.HERMES_ENABLED, true);
const hermesMock = envBool(process.env.HERMES_MOCK, false);
const hermesTimeoutMs = envNumber(process.env.HERMES_TIMEOUT_MS, 30000);

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

  CALCOM_API_KEY: z.string().optional().or(z.literal('')),
  CALCOM_BASE_URL: z.string().url().default('https://api.cal.com'),

  HUBSPOT_ACCESS_TOKEN: z.string().optional().or(z.literal('')),

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
  HERMES_BASE_URL: (process.env.HERMES_BASE_URL ?? '').trim(),
  HERMES_ENDPOINT: (process.env.HERMES_ENDPOINT ?? '/v1/chat/completions').trim(),
  HERMES_API_KEY: (process.env.HERMES_API_KEY ?? '').trim(),
  HERMES_MODEL: (process.env.HERMES_MODEL ?? 'default').trim(),
  HERMES_PROFILE: (process.env.HERMES_PROFILE ?? 'helios').trim(),
  HERMES_CWD: (process.env.HERMES_CWD ?? '').trim(),
  HERMES_SOUL_PATH: (process.env.HERMES_SOUL_PATH ?? '').trim(),
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

  CHATWOOT_BASE_URL: parsed.data?.CHATWOOT_BASE_URL ?? 'https://app.chatwoot.com',
  CHATWOOT_ACCOUNT_ID: parsed.data?.CHATWOOT_ACCOUNT_ID ?? '',
  CHATWOOT_API_TOKEN: parsed.data?.CHATWOOT_API_TOKEN ?? '',
  CHATWOOT_HUMAN_TEAM_ID: parsed.data?.CHATWOOT_HUMAN_TEAM_ID ?? '',
  CHATWOOT_HUMAN_ASSIGNEE_ID: parsed.data?.CHATWOOT_HUMAN_ASSIGNEE_ID ?? '',

  CALCOM_API_KEY: parsed.data?.CALCOM_API_KEY ?? '',
  CALCOM_BASE_URL: parsed.data?.CALCOM_BASE_URL ?? 'https://api.cal.com',

  HUBSPOT_ACCESS_TOKEN: parsed.data?.HUBSPOT_ACCESS_TOKEN ?? '',

  CLINIC_ID: parsed.data?.CLINIC_ID ?? 'coi_demo',
  CLINIC_TIMEZONE: parsed.data?.CLINIC_TIMEZONE ?? 'Europe/Madrid',
  CLINIC_TONE: parsed.data?.CLINIC_TONE ?? 'es-ES'
};

export type Config = typeof config;

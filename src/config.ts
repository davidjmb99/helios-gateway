import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  BUFFER_MS: z.coerce.number().default(5000),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Configuración de Hermes
  HERMES_ENABLED: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(true)),
  HERMES_MOCK: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),
  HERMES_BASE_URL: z.string().optional().or(z.literal('')),
  HERMES_ENDPOINT: z.string().default('/v1/chat/completions'),
  HERMES_API_KEY: z.string().optional().or(z.literal('')),
  HERMES_MODEL: z.string().default('default'),
  HERMES_PROFILE: z.string().default('helios'),
  HERMES_CWD: z.string().optional().or(z.literal('')),
  HERMES_SOUL_PATH: z.string().optional().or(z.literal('')),
  HERMES_TIMEOUT_MS: z.coerce.number().default(30000),

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
  console.error('❌ Error de validación de variables de entorno:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = z.infer<typeof envSchema>;

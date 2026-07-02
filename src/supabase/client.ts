import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas en la configuración.');
}

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

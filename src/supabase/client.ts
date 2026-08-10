import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas en la configuración.');
}

// `let` y no `const` para que exista un único punto de inyección: los bindings de
// un módulo ESM son vivos, así que sustituirlo aquí lo sustituye en todos los
// repositorios sin tocar ninguna llamada. Es lo que permite ejecutar el
// orquestador completo contra un doble en los tests, sin proxies ni sobrecoste
// en producción.
export let supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/**
 * SOLO PARA TESTS. Sustituye el cliente de Supabase por un doble en memoria.
 * En producción nadie llama a esta función.
 */
export function __setSupabaseClientForTests(client: unknown): void {
  supabase = client as typeof supabase;
}

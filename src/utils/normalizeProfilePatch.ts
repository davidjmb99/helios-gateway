/**
 * normalizeProfilePatch — Normaliza y combina un profile_patch entrante de Hermes
 * con el perfil existente del paciente en Supabase.
 *
 * Reglas:
 * - trim de cadenas; ignorar null, undefined, cadenas vacías
 * - first_name / last_name explícitos tienen prioridad sobre name
 * - Si solo llega name, dividir conservadoramente (primera palabra = first_name, resto = last_name)
 * - No inventar last_name si no existe
 * - No usar chatwoot_display_name como identidad verificada
 * - No borrar datos existentes con null/undefined/""
 * - email normalizado a lowercase y validado con regex
 * - phone proviene del webhook de Chatwoot o del perfil técnico existente
 * - hubspot_contact_id se mapea a crm_contact_id
 * - profile_complete se calcula server-side, no se confía ciegamente en Hermes
 */

// Nombres conocidos como "no verificados" provenientes de Chatwoot
const CHATWOOT_DEFAULT_NAMES = ['paciente de chatwoot', 'paciente', 'unknown', 'desconocido'];

export interface ExistingProfile {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  profile_complete?: boolean;
  crm_contact_id?: string | null;
}

export interface IncomingPatch {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  profile_complete?: boolean | null;
  hubspot_contact_id?: string | null;
}

export interface NormalizedProfile {
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  email: string | null;
  phone: string;
  profile_complete: boolean;
  crm_contact_id: string | null;
  has_changes: boolean;
}

/** Retorna la cadena trimmed si es un valor válido, o null si es vacía/nula */
function cleanStr(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Comprueba si un nombre proviene de Chatwoot y no debe usarse como identidad */
function isChatwootDefaultName(name: string | null | undefined): boolean {
  if (!name) return true;
  return CHATWOOT_DEFAULT_NAMES.includes(name.trim().toLowerCase());
}

/** Validación básica de email */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeProfilePatch(
  existing: ExistingProfile | null,
  patch: IncomingPatch | null | undefined,
  chatwootPhone: string
): NormalizedProfile {
  const ex = existing || {};

  // --- Resolver first_name y last_name ---
  let firstName = cleanStr(patch?.first_name);
  let lastName = cleanStr(patch?.last_name);

  // Si no vienen first_name / last_name explícitos pero viene name, dividir conservadoramente
  if (!firstName && !lastName && patch?.name) {
    const cleanName = cleanStr(patch.name);
    if (cleanName && !isChatwootDefaultName(cleanName)) {
      const parts = cleanName.split(/\s+/);
      firstName = parts[0] || null;
      lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
      // No inventar last_name si no existe
    }
  }

  // Usar valores existentes si el patch no aporta nuevos
  const finalFirstName = firstName || cleanStr(ex.first_name);
  const finalLastName = lastName || cleanStr(ex.last_name);

  // --- Resolver name compuesto ---
  let finalName: string | null = null;
  if (finalFirstName || finalLastName) {
    finalName = [finalFirstName, finalLastName].filter(Boolean).join(' ');
  } else {
    // Usar name existente si no era un default de Chatwoot
    const existingName = cleanStr(ex.name);
    if (existingName && !isChatwootDefaultName(existingName)) {
      finalName = existingName;
    }
  }

  // --- Resolver email ---
  let finalEmail = cleanStr(ex.email);
  const patchEmail = cleanStr(patch?.email);
  if (patchEmail) {
    const normalized = patchEmail.toLowerCase();
    if (isValidEmail(normalized)) {
      finalEmail = normalized;
    }
  } else if (finalEmail) {
    // Normalizar email existente también
    finalEmail = finalEmail.toLowerCase();
  }

  // --- Resolver phone ---
  // Phone viene del webhook Chatwoot o del perfil existente, no del patch de Hermes
  const finalPhone = chatwootPhone || cleanStr(ex.phone) || '';

  // --- Resolver crm_contact_id ---
  // hubspot_contact_id se mapea a crm_contact_id
  const patchCrmId = cleanStr(patch?.hubspot_contact_id);
  const finalCrmId = patchCrmId || cleanStr(ex.crm_contact_id);

  // --- Calcular profile_complete server-side ---
  // No confiar ciegamente en patch.profile_complete; el Gateway es la fuente de verdad
  const profileComplete = !!(
    finalFirstName &&
    finalLastName &&
    finalEmail &&
    finalPhone
  );

  // --- Determinar si hay cambios ---
  const hasChanges =
    finalFirstName !== cleanStr(ex.first_name) ||
    finalLastName !== cleanStr(ex.last_name) ||
    finalName !== cleanStr(ex.name) ||
    finalEmail !== cleanStr(ex.email) ||
    finalCrmId !== cleanStr(ex.crm_contact_id) ||
    profileComplete !== (ex.profile_complete === true);

  return {
    first_name: finalFirstName,
    last_name: finalLastName,
    name: finalName,
    email: finalEmail,
    phone: finalPhone,
    profile_complete: profileComplete,
    crm_contact_id: finalCrmId,
    has_changes: hasChanges
  };
}

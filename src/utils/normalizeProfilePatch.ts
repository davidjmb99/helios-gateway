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

/** Resuelve el alias de Chatwoot unificado para Dashboard y Payload */
export function resolveChatwootAlias(rawPayload: any, patientProfile?: any, conversationState?: any): string {
  // 1. sender.name / meta.sender.name del webhook
  const webhookName = rawPayload?.sender?.name || 
                      rawPayload?.meta?.sender?.name ||
                      rawPayload?.conversation?.meta?.sender?.name ||
                      rawPayload?.messages?.[0]?.sender?.name;
                      
  if (webhookName && !isChatwootDefaultName(webhookName)) {
    return webhookName;
  }
  
  // 2. nombre provisional persistido en tenant_id + contact_id
  if (patientProfile?.chatwoot_display_name && !isChatwootDefaultName(patientProfile.chatwoot_display_name)) {
    return patientProfile.chatwoot_display_name;
  }

  // 3. nombre provisional ya presente en estado o metadata
  if (conversationState?.meta?.sender?.name && !isChatwootDefaultName(conversationState.meta.sender.name)) {
    return conversationState.meta.sender.name;
  }
  
  // 4. Fallback
  return 'Contacto sin identificar';
}

/** Validación básica de email */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidOperationalPhone(phone: unknown): boolean {
  const normalized = String(phone ?? '').trim();
  if (!normalized || normalized.includes('*')) return false;
  return normalized.replace(/\D/g, '').length >= 8;
}

export function resolveOperationalPhone(
  statePhone: unknown,
  profilePhone: unknown,
  bufferedPhone: unknown
): string {
  return [statePhone, profilePhone, bufferedPhone]
    .map(value => String(value ?? '').trim())
    .find(isValidOperationalPhone) || '';
}

export function evaluatePersistedProfile(
  patientProfile: any,
  resolvedPhone: string,
  tenantId: string,
  contactId: string
) {
  const profileExists = Boolean(patientProfile)
    && String(patientProfile.tenant_id ?? '') === String(tenantId)
    && String(patientProfile.contact_id ?? '') === String(contactId);
  const firstName = profileExists ? cleanStr(patientProfile.first_name) : null;
  const lastName = profileExists ? cleanStr(patientProfile.last_name) : null;
  const email = profileExists ? cleanStr(patientProfile.email)?.toLowerCase() || null : null;
  // SABER QUIÉN ES ALGUIEN Y PODER RESERVARLE UNA CITA SON DOS COSAS DISTINTAS, y
  // hasta el 21 de agosto de 2026 eran la misma.
  //
  // LO PIDIO DAVID: «para España sí era necesario pedir todos los datos al principio,
  // pero en Venezuela eso es raro. Cuando alguien nuevo escriba, solo debe pedir nombre
  // y apellido; el email que lo pida solo cuando vaya a agendar una cita, ya que es
  // necesario para enviar la confirmación de la reserva».
  //
  // Y NO SE PODIA HACER SOLO EN EL PROMPT. identityComplete exigía el correo, así que
  // Helios habría pedido nombre y apellido, los habría guardado, y el Gateway habría
  // seguido diciéndole `identity_complete: false` con `missing: ['email']` en cada
  // turno. Habría vuelto a pedirlo: un bucle.
  //
  // Así que son dos banderas:
  //
  //   identityComplete .. sé QUIÉN es. Nombre, apellido y un teléfono usable. Con esto
  //                       ya se puede crear el contacto en el CRM, que es para lo que
  //                       hace falta la identidad.
  //   bookingReady ...... puedo RESERVARLE. Lo anterior más un correo válido, porque la
  //                       confirmación de Cal.com se manda por correo y sin él la cita
  //                       existe pero el paciente no recibe nada.
  //
  // Y PENSANDO EN INSTAGRAM, que es lo siguiente: por ahí no llega teléfono. Con esta
  // división, alguien de Instagram puede quedar identificado con nombre y apellido y
  // el teléfono se le pide cuando vaya a reservar, junto al correo. Hoy el teléfono
  // sigue siendo parte de identityComplete porque en WhatsApp llega solo; cuando entre
  // otro canal habrá que moverlo a bookingReady.
  const identityComplete = Boolean(
    firstName
    && lastName
    && isValidOperationalPhone(resolvedPhone)
  );
  const bookingReady = Boolean(
    identityComplete
    && email
    && isValidEmail(email)
  );
  const crmSynced = profileExists && Boolean(cleanStr(patientProfile.crm_contact_id));
  const profileComplete = profileExists
    && patientProfile.profile_complete === true
    // profile_complete sigue exigiendo TODO, correo incluido: es la bandera que dice
    // «este paciente está listo del todo», y se usa para no volver a preguntarle nada.
    && bookingReady
    && crmSynced;

  return {
    profileExists,
    identityComplete,
    bookingReady,
    crmSynced,
    profileComplete,
    firstName,
    lastName,
    email
  };
}

/**
 * Qué falta para saber QUIÉN es este paciente.
 *
 * EL CORREO YA NO SALE DE AQUÍ, y ese es el cambio. Antes se devolvía junto al nombre
 * y el apellido, y Helios lo pedía todo de golpe en el primer mensaje: en España es lo
 * normal, en Venezuela suena a interrogatorio.
 *
 * El correo hace falta para RESERVAR, no para identificar, y por eso ahora sale de
 * `deriveMissingBookingFields`. Helios pide nombre y apellido cuando alguien nuevo
 * escribe, y el correo justo cuando va a agendar, que es cuando el paciente entiende
 * para qué se le pide: para recibir la confirmación.
 */
export function deriveMissingIdentityFields(
  profileStatus: {
    identityComplete: boolean;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  },
  existingMissingFields: unknown = []
): string[] {
  if (profileStatus.identityComplete) return [];

  const missing: string[] = [];
  if (!cleanStr(profileStatus.firstName)) missing.push('first_name');
  if (!cleanStr(profileStatus.lastName)) missing.push('last_name');

  if (missing.length > 0) return missing;

  return Array.isArray(existingMissingFields)
    ? existingMissingFields.filter((field): field is string =>
        ['first_name', 'last_name'].includes(String(field))
      )
    : [];
}

/**
 * Qué falta para poder RESERVARLE una cita.
 *
 * Es lo de la identidad más el correo. Se calcula aparte para que Helios sepa pedir
 * cada cosa en su momento: el nombre cuando alguien se presenta, el correo cuando pide
 * hora. Sin el correo la reserva se crea en Cal.com pero el paciente no recibe la
 * confirmación, así que ahí sí es obligatorio.
 */
export function deriveMissingBookingFields(profileStatus: {
  bookingReady?: boolean;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string[] {
  if (profileStatus.bookingReady) return [];

  const missing: string[] = [];
  if (!cleanStr(profileStatus.firstName)) missing.push('first_name');
  if (!cleanStr(profileStatus.lastName)) missing.push('last_name');
  if (!profileStatus.email || !isValidEmail(profileStatus.email)) missing.push('email');
  return missing;
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
    finalPhone &&
    finalCrmId
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

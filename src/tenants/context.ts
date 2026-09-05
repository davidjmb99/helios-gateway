/**
 * De quién es cada mensaje.
 *
 * Este fichero decide, a partir de la cuenta de Chatwoot que viene en el webhook, a qué
 * clínica pertenece un mensaje y a qué Hermes hay que hablarle. Es la pieza que separa a
 * unas clínicas de otras: si se equivoca, un paciente de una clínica acaba atendido con
 * los datos de otra. Por eso, cuando duda, NO adivina — se niega.
 *
 * DE DÓNDE SALE EL MAPA, Y POR QUÉ HAY DOS SITIOS.
 *
 *   ARRANQUE   `CHATWOOT_TENANT_CONTEXTS_JSON`, la variable de entorno de siempre. El
 *              primer webhook que llegue ya se atiende, sin esperar a nadie.
 *   LUEGO      la tabla `helios_tenants`, refrescada en segundo plano cada minuto.
 *              Cuando trae clínicas, manda ella y la variable deja de mirarse.
 *   SI FALLA   se conserva lo último bueno que hubiera en memoria. La tabla puede
 *              caerse sin que deje de entrar un solo mensaje.
 *
 * LA LECTURA SIGUE SIENDO SÍNCRONA, Y ESO NO ES UN DETALLE. `resolveTenantContext` se
 * llama desde doce sitios, uno de ellos en el camino de CADA webhook. Volverla `async`
 * habría obligado a tocar los doce y a repensar el orden de todo lo que hay debajo. Por
 * eso lo que se mueve al fondo es el REFRESCO, no la lectura: la lectura sigue siendo
 * mirar un Map que ya está en memoria.
 *
 * SUPABASE NO SE IMPORTA ARRIBA, A PROPÓSITO. El cliente se carga con un `import()`
 * dinámico dentro del refresco. Así el camino del mensaje no arrastra esa dependencia, y
 * las pruebas que solo miran el mapa no necesitan una base de datos para arrancar.
 */

export interface TenantContext {
  account_id: string;
  tenant_id: string;
  clinic_id: string;
  hermes_profile: string;
}

export class TenantContextError extends Error {
  code: 'TENANT_NOT_CONFIGURED' | 'TENANT_CONTEXT_INVALID' | 'TENANT_CONTEXT_MISMATCH';
  account_id: string | null;

  constructor(
    code: TenantContextError['code'],
    message: string,
    accountId: string | null = null
  ) {
    super(message);
    this.name = 'TenantContextError';
    this.code = code;
    this.account_id = accountId;
  }
}

// =============================================================================
// EL MAPA EN MEMORIA
// =============================================================================

type FuenteDelMapa = 'entorno' | 'tabla';

let cachedRaw: string | null = null;
let cachedByAccount = new Map<string, TenantContext>();
let cachedByTenant = new Map<string, TenantContext>();

/**
 * Cuál de las dos fuentes está viva. Empieza en `entorno` y pasa a `tabla` la primera vez
 * que la tabla trae clínicas. NO vuelve atrás sola: si alguien vaciara la tabla, se sigue
 * con el último mapa bueno en vez de caer a una variable que puede estar desactualizada.
 */
let fuente: FuenteDelMapa = 'entorno';
let ultimoRefrescoOk: number | null = null;
let ultimoFalloDeRefresco: string | null = null;

/**
 * Para mirar desde fuera qué mapa está vivo sin tener que deducirlo. Sin esto, la pregunta
 * «¿está leyendo la tabla o la variable?» solo se puede responder cambiando un dato y
 * viendo si pasa algo, que es exactamente la clase de diagnóstico que no queremos.
 */
export function estadoDelMapa() {
  // EL MAPA DEL ENTORNO SE CARGA PEREZOSAMENTE, en la primera lectura de verdad. Asi que
  // si todavia no ha llegado ningun mensaje, esto diria «0 clinicas» en un sistema
  // perfectamente sano — y un cero ahi es exactamente la señal engañosa que este campo
  // venia a evitar. Se fuerza la carga, y si la variable esta rota se calla: el propio
  // estado ya lo cuenta con `clinicas: 0`.
  if (cachedByAccount.size === 0 && fuente === 'entorno') {
    try { loadTenantContexts(); } catch { /* sin mapa; el recuento lo dice */ }
  }
  return {
    fuente,
    clinicas: cachedByAccount.size,
    ultimo_refresco_ok: ultimoRefrescoOk ? new Date(ultimoRefrescoOk).toISOString() : null,
    ultimo_fallo: ultimoFalloDeRefresco
  };
}

function requiredString(value: unknown, field: keyof TenantContext, accountId: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new TenantContextError(
      'TENANT_CONTEXT_INVALID',
      `Tenant context ${accountId} is missing ${field}`,
      accountId
    );
  }
  return normalized;
}

// =============================================================================
// LA FUENTE VIEJA: LA VARIABLE DE ENTORNO
// =============================================================================
//
// Intacta respecto a como estaba, con una sola línea nueva: si la tabla ya manda, aquí no
// se hace nada. Sin ese cortocircuito, la variable pisaría el mapa bueno en cada lectura.

function loadTenantContexts(): void {
  if (fuente === 'tabla') return;

  const raw = String(process.env.CHATWOOT_TENANT_CONTEXTS_JSON ?? '').trim();
  if (raw === cachedRaw) return;

  if (!raw) {
    throw new TenantContextError(
      'TENANT_CONTEXT_INVALID',
      'CHATWOOT_TENANT_CONTEXTS_JSON is not configured'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TenantContextError(
      'TENANT_CONTEXT_INVALID',
      'CHATWOOT_TENANT_CONTEXTS_JSON is not valid JSON'
    );
  }

  const entries: Array<[string, any]> = Array.isArray(parsed)
    ? parsed.map((item: any) => [String(item?.account_id ?? ''), item])
    : Object.entries(parsed as Record<string, unknown>);

  const byAccount = new Map<string, TenantContext>();
  const byTenant = new Map<string, TenantContext>();

  for (const [key, value] of entries) {
    const accountId = requiredString(value?.account_id ?? key, 'account_id', key);
    const context: TenantContext = Object.freeze({
      account_id: accountId,
      tenant_id: requiredString(value?.tenant_id, 'tenant_id', accountId),
      clinic_id: requiredString(value?.clinic_id, 'clinic_id', accountId),
      hermes_profile: requiredString(value?.hermes_profile, 'hermes_profile', accountId)
    });

    if (byAccount.has(accountId)) {
      throw new TenantContextError(
        'TENANT_CONTEXT_INVALID',
        `Duplicate account_id in tenant context map: ${accountId}`,
        accountId
      );
    }
    if (byTenant.has(context.tenant_id)) {
      throw new TenantContextError(
        'TENANT_CONTEXT_INVALID',
        `Duplicate tenant_id in tenant context map: ${context.tenant_id}`,
        accountId
      );
    }

    byAccount.set(accountId, context);
    byTenant.set(context.tenant_id, context);
  }

  cachedRaw = raw;
  cachedByAccount = byAccount;
  cachedByTenant = byTenant;
}

// =============================================================================
// LA FUENTE NUEVA: LA TABLA
// =============================================================================

/**
 * Lee el mapa de `helios_tenants` y lo sustituye en memoria si vino bien.
 *
 * NO LANZA NUNCA. Se llama desde un temporizador, sin nadie esperándola: si lanzara, el
 * fallo acabaría en un rechazo de promesa sin capturar y no lo vería nadie. Lo que hace en
 * su lugar es dejar el mapa como estaba y anotar el motivo en `estadoDelMapa()`.
 *
 * TRES REGLAS DE SEGURIDAD, y las tres existen porque la alternativa es dejar clínicas sin
 * atender:
 *
 *  1. UNA TABLA VACÍA NO BORRA EL MAPA. Cero clínicas se trata como un fallo de lectura,
 *     no como «ya no hay clínicas». Un DELETE accidental, una migración a medias o una
 *     política de RLS mal puesta devuelven cero filas exactamente igual que una tabla que
 *     de verdad está vacía — y de esos tres casos, ninguno significa que haya que dejar de
 *     atender a todo el mundo.
 *
 *  2. UNA FILA MALA SOLO SE LLEVA A SU CLÍNICA. Se salta y se sigue con las demás. Esa
 *     clínica se queda sin mapa y sus mensajes se rechazan con `TENANT_NOT_CONFIGURED`,
 *     que es lo correcto cuando no se sabe de quién es un mensaje; las otras ni se enteran.
 *     Es justo lo contrario que la variable de entorno, donde una entrada mala tumbaba a
 *     todas a la vez.
 *
 *  3. EL MAPA SE CAMBIA DE GOLPE. Se construye entero aparte y se sustituye al final. Si
 *     se fuera modificando el vivo, habría instantes con el mapa a medias, y en esos
 *     instantes una clínica existente parecería no existir.
 */
export async function refrescarMapaDesdeTabla(): Promise<void> {
  try {
    const { supabase } = await import('../supabase/client.js');

    const resultado = await supabase
      .from('helios_tenants')
      .select('tenant_id, account_id, clinic_id, hermes_profile, mapa_activo');

    if (resultado.error) {
      throw Object.assign(new Error('MAPA_LECTURA_FALLIDA'), { cause: resultado.error });
    }

    const byAccount = new Map<string, TenantContext>();
    const byTenant = new Map<string, TenantContext>();
    const descartadas: Array<{ tenant_id: string; motivo: string }> = [];

    for (const fila of resultado.data || []) {
      const tenantId = String((fila as any).tenant_id ?? '').trim();
      const accountId = String((fila as any).account_id ?? '').trim();

      // SIN account_id NO ES UNA CLÍNICA DEL MAPA, y eso es normal, no un fallo. La tabla
      // guarda también filas que no son clínicas atendidas; se saltan en silencio.
      if (!accountId) continue;

      // `mapa_activo = false` es una baja deliberada: la clínica deja de atenderse y sus
      // datos y ajustes siguen intactos. Tampoco es un fallo.
      if ((fila as any).mapa_activo === false) continue;

      const clinicId = String((fila as any).clinic_id ?? '').trim();
      const perfil = String((fila as any).hermes_profile ?? '').trim();

      // AQUÍ SÍ HAY ALGO ROTO: la fila dice ser una clínica y le falta con qué atenderla.
      // Típicamente, un alta que se quedó a medias.
      if (!tenantId || !clinicId || !perfil) {
        descartadas.push({
          tenant_id: tenantId || '(sin tenant_id)',
          motivo: !tenantId ? 'sin tenant_id' : !clinicId ? 'sin clinic_id' : 'sin hermes_profile'
        });
        continue;
      }

      // La base ya impide los duplicados — `tenant_id` es la clave y `account_id` tiene
      // índice único —, así que llegar aquí significa que esa garantía no está puesta. Se
      // descarta la segunda en vez de pisar la primera: ante la duda, no atender es mejor
      // que atender a la clínica equivocada.
      if (byAccount.has(accountId) || byTenant.has(tenantId)) {
        descartadas.push({ tenant_id: tenantId, motivo: 'duplicada en la tabla' });
        continue;
      }

      const context: TenantContext = Object.freeze({
        account_id: accountId,
        tenant_id: tenantId,
        clinic_id: clinicId,
        hermes_profile: perfil
      });
      byAccount.set(accountId, context);
      byTenant.set(tenantId, context);
    }

    if (descartadas.length > 0) {
      console.warn(JSON.stringify({
        event: 'mapa_filas_descartadas',
        descartadas,
        atendidas: byAccount.size
      }));
    }

    if (byAccount.size === 0) {
      // Regla 1. Se anota y se deja el mapa como estaba.
      ultimoFalloDeRefresco = 'la tabla no devolvio ninguna clinica';
      console.warn(JSON.stringify({
        event: 'mapa_sin_clinicas',
        fuente_en_uso: fuente,
        clinicas_en_memoria: cachedByAccount.size
      }));
      return;
    }

    const primeraVez = fuente !== 'tabla';
    cachedByAccount = byAccount;
    cachedByTenant = byTenant;
    fuente = 'tabla';
    ultimoRefrescoOk = Date.now();
    ultimoFalloDeRefresco = null;

    if (primeraVez) {
      console.log(JSON.stringify({
        event: 'mapa_desde_tabla',
        clinicas: byAccount.size,
        nota: 'la variable de entorno deja de usarse'
      }));
    }
  } catch (error: any) {
    // Regla: nunca lanzar. El mapa que hubiera en memoria sigue sirviendo.
    ultimoFalloDeRefresco = String(error?.message ?? error);
    console.warn(JSON.stringify({
      event: 'mapa_refresco_fallido',
      motivo: ultimoFalloDeRefresco,
      fuente_en_uso: fuente,
      clinicas_en_memoria: cachedByAccount.size
    }));
  }
}

let temporizador: ReturnType<typeof setInterval> | null = null;

/**
 * Arranca el refresco de fondo. Se llama una vez al levantar el servidor.
 *
 * Refresca YA y luego cada minuto. Sin ese primer refresco inmediato, el primer minuto de
 * vida del proceso iría siempre por la variable de entorno, y un alta recién hecha
 * parecería no haber funcionado justo cuando alguien la está mirando.
 */
export function arrancarRefrescoDelMapa(intervaloMs = 60_000): void {
  if (temporizador) return;
  void refrescarMapaDesdeTabla();
  temporizador = setInterval(() => { void refrescarMapaDesdeTabla(); }, intervaloMs);
  // Que un temporizador de fondo no sea motivo para que el proceso no pueda terminar.
  (temporizador as any).unref?.();
}

export function pararRefrescoDelMapa(): void {
  if (temporizador) clearInterval(temporizador);
  temporizador = null;
}

/**
 * Devuelve el módulo a su estado de arranque. Solo para pruebas: el mapa vive en variables
 * de módulo, así que sin esto una prueba no puede comprobar la variable de entorno y la
 * tabla en el mismo fichero.
 */
export function reiniciarMapaParaPruebas(): void {
  pararRefrescoDelMapa();
  cachedRaw = null;
  cachedByAccount = new Map();
  cachedByTenant = new Map();
  fuente = 'entorno';
  ultimoRefrescoOk = null;
  ultimoFalloDeRefresco = null;
}

// =============================================================================
// LA LECTURA — SÍNCRONA, DESDE MEMORIA, IGUAL QUE SIEMPRE
// =============================================================================

export function resolveTenantContext(accountId: unknown): TenantContext {
  loadTenantContexts();
  const normalizedAccountId = String(accountId ?? '').trim();
  const context = cachedByAccount.get(normalizedAccountId);
  if (!context) {
    throw new TenantContextError(
      'TENANT_NOT_CONFIGURED',
      'Chatwoot account is not configured',
      normalizedAccountId || null
    );
  }
  return context;
}

export function resolveTenantContextByTenantId(tenantId: unknown): TenantContext {
  loadTenantContexts();
  const normalizedTenantId = String(tenantId ?? '').trim();
  const context = cachedByTenant.get(normalizedTenantId);
  if (!context) {
    throw new TenantContextError(
      'TENANT_NOT_CONFIGURED',
      'Tenant is not configured'
    );
  }
  return context;
}

export function validateWebhookTenantRoute(
  context: Pick<TenantContext, 'account_id' | 'tenant_id'>,
  routeTenantId: unknown
): void {
  const normalizedRouteTenantId = String(routeTenantId ?? '').trim();
  if (normalizedRouteTenantId && normalizedRouteTenantId !== context.tenant_id) {
    throw new TenantContextError(
      'TENANT_CONTEXT_MISMATCH',
      'Webhook tenant route does not match Chatwoot account mapping',
      context.account_id
    );
  }
}

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

let cachedRaw: string | null = null;
let cachedByAccount = new Map<string, TenantContext>();
let cachedByTenant = new Map<string, TenantContext>();

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

function loadTenantContexts(): void {
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

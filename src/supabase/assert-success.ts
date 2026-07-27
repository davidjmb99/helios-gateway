import crypto from 'crypto';

export type SupabaseErrorCode =
  | 'SUPABASE_TIMEOUT'
  | 'SUPABASE_AUTH'
  | 'SUPABASE_CONSTRAINT'
  | 'SUPABASE_NETWORK'
  | 'SUPABASE_SCHEMA'
  | 'SUPABASE_UNKNOWN';

export interface SupabaseOperationContext {
  tenant_id?: string | null;
  trace_id?: string | null;
  row_id?: string | number | null;
}

export class SupabaseOperationError extends Error {
  readonly code: SupabaseErrorCode;
  readonly operation: string;
  readonly tenant_fingerprint: string | null;
  readonly trace_fingerprint: string | null;
  readonly row_fingerprint: string | null;
  readonly original_code: string | null;

  constructor(
    code: SupabaseErrorCode,
    operation: string,
    originalError: any,
    context: SupabaseOperationContext = {}
  ) {
    super(`${code}: ${operation}`);
    this.name = 'SupabaseOperationError';
    this.code = code;
    this.operation = operation;
    this.tenant_fingerprint = fingerprint(context.tenant_id);
    this.trace_fingerprint = fingerprint(context.trace_id);
    this.row_fingerprint = fingerprint(context.row_id);
    this.original_code = originalError?.code ? String(originalError.code) : null;
  }
}

function fingerprint(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function classifySupabaseError(error: any): SupabaseErrorCode {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);

  if (code.includes('TIMEOUT') || message.includes('timeout') || status === 504) {
    return 'SUPABASE_TIMEOUT';
  }
  if (status === 401 || status === 403 || code === '42501' || message.includes('jwt')) {
    return 'SUPABASE_AUTH';
  }
  if (code.startsWith('23') || message.includes('constraint') || message.includes('duplicate key')) {
    return 'SUPABASE_CONSTRAINT';
  }
  if (
    status === 502 ||
    status === 503 ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('econn')
  ) {
    return 'SUPABASE_NETWORK';
  }
  if (
    code.startsWith('42') ||
    code.startsWith('PGRST') ||
    message.includes('schema cache') ||
    message.includes('column')
  ) {
    return 'SUPABASE_SCHEMA';
  }
  return 'SUPABASE_UNKNOWN';
}

export function assertSupabaseSuccess<T extends { error?: any }>(
  result: T,
  operationName: string,
  context: SupabaseOperationContext = {}
): T {
  if (!result?.error) return result;
  throw new SupabaseOperationError(
    classifySupabaseError(result.error),
    operationName,
    result.error,
    context
  );
}


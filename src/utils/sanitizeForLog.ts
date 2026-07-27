const REDACTED_KEYS = new Set([
  'authorization',
  'password',
  'secret',
  'token',
  'api_key',
  'email',
  'first_name',
  'last_name',
  'name',
  'patient_name',
  'text',
  'message',
  'body',
  'content',
  'reply',
  'reply_text',
  'message_for_client',
  'raw_payload'
]);

export function maskPhoneForLog(value: unknown): string {
  const phone = String(value ?? '').trim();
  if (!phone) return '';
  if (phone.length <= 5) return '*****';
  return `${phone.slice(0, 4)}*****${phone.slice(-4)}`;
}

export function sanitizeForLog(value: unknown, key = ''): any {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'phone' || normalizedKey === 'phone_number') {
    return maskPhoneForLog(value);
  }
  if (
    REDACTED_KEYS.has(normalizedKey) ||
    normalizedKey.endsWith('_token') ||
    normalizedKey.endsWith('_secret') ||
    normalizedKey.endsWith('_password')
  ) {
    return value === null || value === undefined || value === '' ? value : '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitizeForLog(childValue, childKey)
      ])
    );
  }
  return value;
}

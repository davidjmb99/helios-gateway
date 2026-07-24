import assert from 'node:assert/strict';

process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': {
    tenant_id: 'democoi1',
    clinic_id: 'coi_demo',
    hermes_profile: 'helios'
  },
  '3': {
    tenant_id: 'tenant_other',
    clinic_id: 'clinic_other',
    hermes_profile: 'profile_other'
  }
});

const { normalizeChatwootPayload } = await import('../src/chatwoot/normalizer.js');
const {
  resolveTenantContext,
  resolveTenantContextByTenantId,
  TenantContextError,
  validateWebhookTenantRoute
} = await import('../src/tenants/context.js');
const { sanitizeForLog } = await import('../src/utils/sanitizeForLog.js');

function webhook(accountId: number) {
  return {
    event: 'message_created',
    account: { id: accountId },
    message_type: 'incoming',
    id: `message-${accountId}`,
    content: 'Mensaje de prueba',
    created_at: '2026-07-24T00:00:00.000Z',
    sender: {
      id: `contact-${accountId}`,
      type: 'contact',
      name: 'Paciente',
      phone_number: '+00000000000'
    },
    conversation: {
      id: 'same-conversation',
      inbox_id: 'inbox-test'
    }
  };
}

const helios = normalizeChatwootPayload(webhook(2));
assert.equal(helios.account_id, '2');
assert.equal(helios.tenant_id, 'democoi1');
assert.equal(helios.clinic_id, 'coi_demo');
assert.equal(helios.hermes_profile, 'helios');
assert.notEqual(helios.tenant_id, helios.account_id);

assert.doesNotThrow(() => validateWebhookTenantRoute(helios, 'democoi1'));
assert.throws(
  () => validateWebhookTenantRoute(helios, '2'),
  (error: unknown) =>
    error instanceof TenantContextError &&
    error.code === 'TENANT_CONTEXT_MISMATCH'
);

const other = normalizeChatwootPayload(webhook(3));
assert.equal(other.account_id, '3');
assert.equal(other.tenant_id, 'tenant_other');
assert.equal(other.clinic_id, 'clinic_other');
assert.equal(other.hermes_profile, 'profile_other');
assert.notEqual(other.hermes_profile, helios.hermes_profile);

assert.deepEqual(resolveTenantContextByTenantId('democoi1'), resolveTenantContext('2'));

assert.throws(
  () => normalizeChatwootPayload(webhook(999)),
  (error: unknown) =>
    error instanceof TenantContextError &&
    error.code === 'TENANT_NOT_CONFIGURED'
);

const safeLog = JSON.stringify(sanitizeForLog({
  phone: '+00000000000',
  email: 'private-marker@example.invalid',
  message: {
    text: 'PRIVATE_MULTITENANT_MARKER',
    messages: [{ body: 'PRIVATE_MULTITENANT_MARKER' }]
  },
  authorization: 'Bearer secret-value'
}));
assert.doesNotMatch(
  safeLog,
  /PRIVATE_MULTITENANT_MARKER|private-marker@example\.invalid|\+00000000000|secret-value/
);

console.log('PASS: account_id resuelve un contexto tenant explícito sin fallback.');

import assert from 'node:assert/strict';
import { normalizeChatwootPayload } from '../src/chatwoot/normalizer.js';
import {
  deriveMissingIdentityFields,
  evaluatePersistedProfile,
  resolveChatwootAlias,
  resolveOperationalPhone
} from '../src/utils/normalizeProfilePatch.js';
import { maskPhoneForLog } from '../src/utils/sanitizeForLog.js';

process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': {
    tenant_id: 'democoi1',
    clinic_id: 'coi_demo',
    hermes_profile: 'helios'
  }
});

const operationalPhone = '+580000000000';
const identityWithoutCrm = {
  tenant_id: 'democoi1',
  contact_id: '8',
  profile_complete: true,
  crm_contact_id: null,
  first_name: 'Nombre',
  last_name: 'Apellido',
  email: 'person@example.invalid',
  phone: operationalPhone,
  chatwoot_display_name: 'Alias no verificado'
};

const noCrm = evaluatePersistedProfile(
  identityWithoutCrm,
  operationalPhone,
  'democoi1',
  '8'
);
assert.equal(noCrm.profileExists, true);
assert.equal(noCrm.identityComplete, true);
assert.equal(noCrm.crmSynced, false);
assert.equal(noCrm.profileComplete, false);

const complete = evaluatePersistedProfile(
  { ...identityWithoutCrm, crm_contact_id: 'crm-record' },
  operationalPhone,
  'democoi1',
  '8'
);
assert.equal(complete.identityComplete, true);
assert.equal(complete.crmSynced, true);
assert.equal(complete.profileComplete, true);

const absent = evaluatePersistedProfile(null, operationalPhone, 'democoi1', '8');
assert.equal(absent.profileExists, false);
assert.equal(absent.identityComplete, false);
assert.equal(absent.profileComplete, false);
assert.equal(absent.firstName, null);
assert.equal(absent.lastName, null);
assert.equal(absent.email, null);
assert.deepEqual(
  deriveMissingIdentityFields(absent),
  ['first_name', 'last_name', 'email'],
  'an absent profile requires all identity fields'
);

const technicalOnly = evaluatePersistedProfile(
  {
    tenant_id: 'democoi1',
    contact_id: '8',
    phone: operationalPhone,
    first_name: null,
    last_name: null,
    email: null,
    profile_complete: false,
    crm_contact_id: null
  },
  operationalPhone,
  'democoi1',
  '8'
);
assert.deepEqual(
  deriveMissingIdentityFields(technicalOnly),
  ['first_name', 'last_name', 'email'],
  'a technical phone-only profile requires all identity fields'
);

const firstNameOnly = evaluatePersistedProfile(
  {
    tenant_id: 'democoi1',
    contact_id: '8',
    phone: operationalPhone,
    first_name: 'Nombre',
    last_name: null,
    email: null,
    profile_complete: false,
    crm_contact_id: null
  },
  operationalPhone,
  'democoi1',
  '8'
);
assert.deepEqual(
  deriveMissingIdentityFields(firstNameOnly),
  ['last_name', 'email'],
  'a partial name requires last_name and email'
);

const invalidEmail = evaluatePersistedProfile(
  {
    tenant_id: 'democoi1',
    contact_id: '8',
    phone: operationalPhone,
    first_name: 'Nombre',
    last_name: 'Apellido',
    email: 'invalid-email',
    profile_complete: false,
    crm_contact_id: null
  },
  operationalPhone,
  'democoi1',
  '8'
);
assert.deepEqual(deriveMissingIdentityFields(invalidEmail), ['email']);
assert.deepEqual(
  deriveMissingIdentityFields(noCrm),
  [],
  'complete identity does not depend on CRM synchronization'
);
assert.deepEqual(
  deriveMissingIdentityFields(complete),
  [],
  'a CRM-backed complete profile has no missing identity fields'
);

const foreignTenant = evaluatePersistedProfile(
  { ...identityWithoutCrm, tenant_id: 'other-tenant', crm_contact_id: 'crm-record' },
  operationalPhone,
  'democoi1',
  '8'
);
assert.equal(foreignTenant.profileExists, false);
assert.equal(foreignTenant.identityComplete, false);
assert.equal(foreignTenant.profileComplete, false);

const alias = resolveChatwootAlias(
  { sender: { name: 'Otro alias' } },
  identityWithoutCrm,
  null
);
assert.equal(alias, 'Otro alias');
assert.equal(noCrm.firstName, 'Nombre', 'Chatwoot alias never replaces persisted first_name');
assert.equal(noCrm.lastName, 'Apellido', 'Chatwoot alias never replaces persisted last_name');

const resolvedFromProfile = resolveOperationalPhone('', operationalPhone, '');
assert.equal(resolvedFromProfile, operationalPhone);
const loggedPhone = maskPhoneForLog(resolvedFromProfile);
assert.notEqual(loggedPhone, operationalPhone);
assert.match(loggedPhone, /\*{5}/);
assert.equal(
  resolveOperationalPhone('+58*******00', operationalPhone, ''),
  operationalPhone,
  'a masked value is never selected as operational phone'
);

const outgoing = normalizeChatwootPayload({
  event: 'message_created',
  account: { id: 2 },
  message_type: 'outgoing',
  id: 588,
  content: 'Respuesta enviada',
  conversation: {
    id: 36,
    inbox_id: 7,
    contact_inbox: {
      contact_id: 8,
      source_id: operationalPhone
    }
  },
  sender: {
    id: 7,
    type: 'User',
    name: 'Agente'
  }
});
assert.equal(outgoing.should_process, false);
assert.equal(outgoing.direction, 'outgoing');
assert.equal(outgoing.contact_id, '8');
assert.equal(outgoing.sender_id, '7');
assert.equal(outgoing.sender_type, 'User');

const incomingWithoutConversationContact = normalizeChatwootPayload({
  event: 'message_created',
  account: { id: 2 },
  message_type: 'incoming',
  id: 589,
  content: 'Mensaje entrante',
  conversation: { id: 37, inbox_id: 7 },
  sender: { id: 9, type: 'Contact', phone_number: operationalPhone }
});
assert.equal(incomingWithoutConversationContact.contact_id, '9');
assert.equal(incomingWithoutConversationContact.sender_id, '9');

console.log('identity_normalization_test: PASS');

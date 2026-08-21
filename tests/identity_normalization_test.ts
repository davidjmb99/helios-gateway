import assert from 'node:assert/strict';
import { normalizeChatwootPayload } from '../src/chatwoot/normalizer.js';
import {
  deriveMissingIdentityFields,
  deriveMissingBookingFields,
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
// IDENTIFICAR Y PODER RESERVAR SON DOS COSAS DISTINTAS desde el 21-ago-2026.
//
// LO PIDIO DAVID: «para España si era necesario pedir todos los datos al principio,
// pero en Venezuela eso es raro. Cuando alguien nuevo escriba, solo debe pedir nombre y
// apellido; el email que lo pida solo cuando vaya a agendar».
//
// Y NO SE PODIA HACER SOLO EN EL PROMPT: identityComplete exigia el correo, asi que
// Helios habria pedido nombre y apellido, los habria guardado, y el Gateway habria
// seguido diciendole missing: ['email'] en cada turno. Habria vuelto a pedirlo.
assert.deepEqual(
  deriveMissingIdentityFields(absent),
  ['first_name', 'last_name'],
  'para IDENTIFICAR solo hacen falta nombre y apellido: el correo no identifica a nadie'
);
assert.deepEqual(
  deriveMissingBookingFields(absent),
  ['first_name', 'last_name', 'email'],
  'para RESERVAR si hace falta el correo: sin el, Cal.com crea la cita y el paciente no '
  + 'recibe la confirmacion'
);

// EL CASO QUE MOTIVA TODO: alguien que ya dio su nombre y apellido pero no el correo.
// Tiene que estar IDENTIFICADO -para poder crearle el contacto en el CRM- y NO
// reservable todavia.
const soloNombre = evaluatePersistedProfile(
  {
    tenant_id: 'democoi1',
    contact_id: '8',
    phone: operationalPhone,
    first_name: 'Maria',
    last_name: 'Lara',
    email: null,
    profile_complete: false,
    crm_contact_id: null
  },
  operationalPhone,
  'democoi1',
  '8'
);
assert.equal(
  soloNombre.identityComplete, true,
  'con nombre, apellido y telefono ya se sabe QUIEN es: eso es identidad completa'
);
assert.equal(
  soloNombre.bookingReady, false,
  'pero sin correo no se le puede reservar: la confirmacion no llegaria a ningun sitio'
);
assert.deepEqual(
  deriveMissingIdentityFields(soloNombre), [],
  'y NO se le vuelve a pedir el nombre: es el bucle que habria provocado el prompt solo'
);
assert.deepEqual(
  deriveMissingBookingFields(soloNombre), ['email'],
  'lo unico que le falta para agendar es el correo, y eso se le pide al agendar'
);
assert.equal(
  soloNombre.profileComplete, false,
  'profile_complete sigue exigiendo TODO: es la bandera de «no le preguntes nada mas»'
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
// Un perfil que solo tiene el telefono tecnico del canal: no identifica a nadie.
assert.deepEqual(
  deriveMissingIdentityFields(technicalOnly),
  ['first_name', 'last_name'],
  'con solo el telefono del canal falta lo que de verdad identifica: nombre y apellido'
);
assert.deepEqual(
  deriveMissingBookingFields(technicalOnly),
  ['first_name', 'last_name', 'email'],
  'y para reservar falta todo, correo incluido'
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
  ['last_name'],
  'con el nombre a medias solo falta el apellido para identificar'
);
assert.deepEqual(
  deriveMissingBookingFields(firstNameOnly),
  ['last_name', 'email'],
  'para reservar siguen faltando el apellido y el correo'
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
// Un correo mal escrito NO impide identificar a nadie: el nombre y el apellido están.
// Lo que impide es reservarle, porque la confirmación no llegaría a ninguna parte.
assert.deepEqual(
  deriveMissingIdentityFields(invalidEmail), [],
  'un correo invalido no borra la identidad: se sabe perfectamente quien es'
);
assert.equal(invalidEmail.identityComplete, true);
assert.equal(invalidEmail.bookingReady, false, 'pero con un correo invalido no se reserva');
assert.deepEqual(
  deriveMissingBookingFields(invalidEmail), ['email'],
  'y hay que pedirle uno bueno, pero solo cuando vaya a agendar'
);
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

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
// Y PARA RESERVAR, LO MISMO. AQUI SE EXIGIA UN CORREO, y la razon escrita era «sin el,
// Cal.com crea la cita y el paciente no recibe la confirmacion». Cal.com se fue el 27 de
// agosto y Google Calendar no manda ningun correo, asi que esta prueba llevaba cuatro dias
// defendiendo un motivo muerto.
//
// SE VIO CON UN PACIENTE DE VERDAD: Helios pidio el correo «para enviarle la confirmacion»
// y dos mensajes despues tuvo que explicar que no se envia ninguna.
assert.deepEqual(
  deriveMissingBookingFields(absent),
  ['first_name', 'last_name'],
  'para RESERVAR ya no hace falta el correo: no hay ninguna confirmacion que mandar'
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
  soloNombre.bookingReady, true,
  'Y SIN CORREO TAMBIEN SE LE PUEDE RESERVAR. Un dato que no se usa para nada no puede '
  + 'impedir que un paciente consiga una cita.'
);
assert.deepEqual(
  deriveMissingIdentityFields(soloNombre), [],
  'y NO se le vuelve a pedir el nombre: es el bucle que habria provocado el prompt solo'
);
assert.deepEqual(
  deriveMissingBookingFields(soloNombre), [],
  'no le falta nada para agendar'
);

// EL CORREO SE SIGUE GUARDANDO SI EL PACIENTE LO DA. No se ha borrado el campo: lo que se
// ha quitado es que BLOQUEE. Si alguien lo escribe, viaja al perfil y de ahi al CRM.
const conCorreo = evaluatePersistedProfile(
  {
    tenant_id: 'democoi1',
    contact_id: '9',
    phone: operationalPhone,
    first_name: 'Maria',
    last_name: 'Lara',
    email: 'maria@example.invalid',
    profile_complete: false,
    crm_contact_id: null
  },
  operationalPhone,
  'democoi1',
  '9'
);
assert.equal(conCorreo.email, 'maria@example.invalid', 'el correo se guarda si lo dan');
assert.equal(conCorreo.bookingReady, true);
assert.equal(
  soloNombre.profileComplete, false,
  'profile_complete sigue en false, pero ahora por el CRM: falta el crm_contact_id'
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
  ['first_name', 'last_name'],
  'y para reservar falta lo mismo: el correo ya no cuenta'
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
  ['last_name'],
  'para reservar solo falta el apellido'
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
// UN CORREO MAL ESCRITO YA NO IMPIDE NADA. Antes bloqueaba la reserva -«la confirmacion
// no llegaria a ninguna parte»- y hoy no hay confirmacion que mandar.
//
// ES EL CASO MAS FEO DEL COMPORTAMIENTO VIEJO: un paciente que escribe mal su correo se
// quedaba sin poder agendar, por culpa de un dato que no se iba a usar. Y sin entender
// por que, porque desde su lado ya lo habia dado.
assert.deepEqual(
  deriveMissingIdentityFields(invalidEmail), [],
  'un correo invalido no borra la identidad: se sabe perfectamente quien es'
);
assert.equal(invalidEmail.identityComplete, true);
assert.equal(
  invalidEmail.bookingReady, true,
  'y con un correo mal escrito TAMBIEN se reserva: no bloquea un dato que no se usa'
);
assert.deepEqual(
  deriveMissingBookingFields(invalidEmail), [],
  'no se le pide que lo corrija: no hay nada que mandarle a ese correo'
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

// --- Y QUE EL GATEWAY NO PIDA EL CORREO POR OTRO CAMINO ----------------------
//
// Las funciones de arriba pueden estar perfectas y no servir de nada: `callHermes`
// construye su PROPIA lista de campos que faltan, sin pasar por ellas, y ahi decia
// ["first_name", "last_name", "email"]. Esa linea era la que hacia que Helios pidiera el
// correo, y ninguna prueba la miraba.
//
// SE COMPROBO VOLVIENDO A METER 'email' AHI: la suite entera seguia en verde.
{
  const fs = await import('node:fs');
  const cliente = fs.readFileSync('src/hermes/client.ts', 'utf8');

  // EL `*?` NO ES ADORNO. Con `*` voraz, en
  //     const missing = isNew ? ["first_name", "last_name", "email"] : [];
  // el motor llega al final de la linea y retrocede hasta el ULTIMO corchete -el `[]` del
  // caso falso-, capturando una lista vacia. La comprobacion pasaba siempre.
  //
  // Se vio inyectando el fallo: se volvio a meter 'email' y la prueba siguio en verde.
  const listas = [...cliente.matchAll(/missing(?:_fields)?\s*[:=][^;\n]*?\[([^\]]*)\]/g)]
    .map(m => m[1]);
  assert.ok(listas.length >= 2, `se esperaban al menos dos listas y hay ${listas.length}`);

  for (const lista of listas) {
    assert.ok(
      !/email|correo/i.test(lista),
      `el gateway sigue pidiendo el correo: [${lista.trim()}]. Cal.com se fue y Google no `
      + 'manda ninguna confirmacion, asi que no hay motivo que darle al paciente.'
    );
  }

  // Y que el respaldo simulado no nombre a una clinica concreta. Es multiclinica: el
  // nombre de una sola ahi dentro es el mismo error que ya se corrigio en la rama de
  // produccion de este archivo.
  //
  // SIN LOS COMENTARIOS: dos de ellos citan ese nombre a proposito, para contar por que se
  // quito. Una comprobacion que no distingue codigo de comentario prohibe explicar el
  // fallo, que es justo lo que hay que dejar escrito.
  const soloCodigo = cliente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(linea => !linea.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    !/Centro Odontol[oó]gico Integral/i.test(soloCodigo),
    'hay el nombre de una clinica concreta escrito en el codigo de un producto multiclinica'
  );
}

console.log('identity_normalization_test: correo ya no bloquea OK');

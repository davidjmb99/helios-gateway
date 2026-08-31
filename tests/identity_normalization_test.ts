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
// Y PARA RESERVAR, ADEMAS EL CORREO. AQUI LA RAZON ESCRITA ERA «sin el, Cal.com crea la
// cita y el paciente no recibe la confirmacion», Y ESA RAZON YA NO EXISTE: Cal.com se fue
// el 27 de agosto y Google Calendar no manda ningun correo.
//
// EL DATO SI SIGUE HACIENDO FALTA -es para la ficha del CRM, lo confirmo David-. Lo que no
// se puede es volver a pedirlo diciendo que es para mandar una confirmacion: eso se probo
// con un paciente real y Helios tuvo que desdecirse dos mensajes despues.
//
// LA DIFERENCIA NO ES ACADEMICA: si manana se quita HubSpot, esta linea se cae con el, y
// quien la lea tiene que saber de que cuelga.
assert.deepEqual(
  deriveMissingBookingFields(absent),
  ['first_name', 'last_name', 'email'],
  'para RESERVAR ademas el correo, que es lo que lleva la ficha al CRM'
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
  'sin correo todavia falta un dato para su ficha, y hay que pedirselo'
);
assert.deepEqual(
  deriveMissingIdentityFields(soloNombre), [],
  'y NO se le vuelve a pedir el nombre: es el bucle que habria provocado el prompt solo'
);
assert.deepEqual(
  deriveMissingBookingFields(soloNombre), ['email'],
  'lo unico que le falta es el correo, y eso se le pide al agendar, no al saludar'
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
assert.equal(conCorreo.email, 'maria@example.invalid', 'el correo se guarda');
assert.equal(conCorreo.bookingReady, true, 'y con el ya no falta nada para reservar');
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
// UN CORREO MAL ESCRITO NO IDENTIFICA PEOR A NADIE: el nombre y el apellido estan.
// Lo que pasa es que la ficha del CRM se quedaria con un correo que no sirve.
//
// AQUI HAY UN CASO INCOMODO Y CONVIENE QUE ESTE ESCRITO: quien teclea mal su correo ve
// como Helios se lo vuelve a pedir, y desde su lado ya lo habia dado. Se acepta porque
// `create_booking` NO MIRA ESTA BANDERA -solo exige doctor, hora y nombre-, asi que Helios
// puede agendar igualmente y seguir. Es una senal de «falta preguntar», no un cerrojo.
assert.deepEqual(
  deriveMissingIdentityFields(invalidEmail), [],
  'un correo invalido no borra la identidad: se sabe perfectamente quien es'
);
assert.equal(invalidEmail.identityComplete, true);
assert.equal(
  invalidEmail.bookingReady, false,
  'pero con un correo invalido la ficha quedaria mal, asi que se le pide otro'
);
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

// --- Y QUE EL SALUDO NO PIDA EL CORREO -----------------------------------------
//
// EL CORREO SE PIDE AL AGENDAR, NO AL SALUDAR. Lo pidio David el 21 de agosto: «para
// Espana si era necesario pedir todos los datos al principio, pero en Venezuela eso es
// raro». Un paciente nuevo da su nombre; el correo llega cuando pide hora.
//
// Y LAS FUNCIONES DE ARRIBA NO BASTAN PARA GARANTIZARLO: `callHermes` construye su PROPIA
// lista de campos que faltan, sin pasar por ellas, y ahi decia ["first_name",
// "last_name", "email"]. ESA era la linea que hacia que Helios lo pidiera nada mas
// saludar, y ninguna prueba la miraba.
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
      `el saludo vuelve a pedir el correo: [${lista.trim()}]. Ese dato se pide al AGENDAR `
      + '-va en bookingReady-, no al presentarse: pedirlo todo de golpe suena a '
      + 'interrogatorio.'
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

console.log('identity_normalization_test: el correo se pide al agendar OK');

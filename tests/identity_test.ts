import { normalizeProfilePatch } from '../src/utils/normalizeProfilePatch.js';
import { HermesResponseSchema } from '../src/hermes/schema.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, title: string) {
  if (condition) {
    console.log(`✅ PASS: ${title}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${title}`);
    failed++;
  }
}

console.log('--- EJECUTANDO PRUEBAS OBLIGATORIAS DE IDENTIDAD Y DASHBOARD ---\n');

// 1. Pruebas de Schema Zod (A)
const rawHermesResponse = {
  route: 'appointment',
  intent: 'book_appointment',
  profile_patch: {
    first_name: 'David',
    last_name: 'Mercado',
    name: 'David Mercado',
    email: 'davidj@gmail.com',
    phone: '+584125207119',
    profile_complete: true,
    hubspot_contact_id: 'hs_12345'
  }
};

const parsed = HermesResponseSchema.safeParse(rawHermesResponse);
assert(parsed.success, 'A1. HermesResponseSchema parsea correctamente la respuesta de Hermes');
if (parsed.success) {
  assert(parsed.data.profile_patch?.first_name === 'David', 'A2. Zod conserva first_name');
  assert(parsed.data.profile_patch?.last_name === 'Mercado', 'A3. Zod conserva last_name');
  assert(parsed.data.profile_patch?.email === 'davidj@gmail.com', 'A4. Zod conserva email');
  assert(parsed.data.profile_patch?.hubspot_contact_id === 'hs_12345', 'A5. Zod conserva hubspot_contact_id');
}

// 2. Pruebas de Normalización de Perfil (D, E, F, G, H, K)
const norm1 = normalizeProfilePatch(null, {
  first_name: 'David',
  last_name: 'Mercado',
  email: 'DAVIDJ@GMAIL.COM',
  hubspot_contact_id: '123'
}, '+584125207119');

assert(norm1.first_name === 'David', 'D1. Normaliza first_name');
assert(norm1.last_name === 'Mercado', 'D2. Normaliza last_name');
assert(norm1.email === 'davidj@gmail.com', 'H. Email se guarda en lowercase');
assert(norm1.crm_contact_id === '123', 'C. hubspot_contact_id se mapea a crm_contact_id');
assert(norm1.profile_complete === true, 'D3. profile_complete se calcula en true cuando tiene todos los campos');

// E. Sent as profile_complete=true but missing last_name -> must be false
const norm2 = normalizeProfilePatch(null, {
  first_name: 'David',
  last_name: null,
  email: 'david@gmail.com',
  profile_complete: true
}, '+584125207119');
assert(norm2.profile_complete === false, 'E. profile_complete enviado como true pero sin apellido queda FALSE');

// F. chatwoot_display_name no se usa como identidad
const norm3 = normalizeProfilePatch(null, {
  name: 'Paciente de Chatwoot',
  email: null
}, '+584125207119');
assert(norm3.first_name === null, 'F1. Chatwoot default name no se convierte en first_name');
assert(norm3.profile_complete === false, 'F2. Chatwoot default name deja profile_complete en false');

// G. null o cadenas vacías no borran datos existentes
const existing = {
  first_name: 'David',
  last_name: 'Mercado',
  email: 'david@gmail.com',
  phone: '+584125207119',
  profile_complete: true,
  crm_contact_id: '123'
};
const norm4 = normalizeProfilePatch(existing, {
  first_name: '',
  email: null
}, '+584125207119');
assert(norm4.first_name === 'David', 'G1. String vacío en patch no borra first_name existente');
assert(norm4.email === 'david@gmail.com', 'G2. Null en patch no borra email existente');

// Single name splitting
const norm5 = normalizeProfilePatch(null, {
  name: 'Carlos Mendoza',
  email: 'carlos@test.com'
}, '+584123456');
assert(norm5.first_name === 'Carlos', 'Split1. Divide name en primera palabra');
assert(norm5.last_name === 'Mendoza', 'Split2. Divide name resto en last_name');

// Single name without surname
const norm6 = normalizeProfilePatch(null, {
  name: 'Carlos',
  email: 'carlos@test.com'
}, '+584123456');
assert(norm6.first_name === 'Carlos', 'Split3. Si sólo hay una palabra, se asigna a first_name');
assert(norm6.last_name === null, 'Split4. No inventa last_name si no existe');

console.log(`\nRESUMEN DE PRUEBAS: ${passed} PASS, ${failed} FAIL`);

if (failed > 0) {
  process.exit(1);
}

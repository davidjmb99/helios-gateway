/**
 * Vaciado de datos por clínica.
 *
 * Lo que se protege aquí es lo que separa una herramienta de un accidente: que
 * una clínica NO pueda tocar los datos de otra, que no se pueda borrar una tabla
 * que no esté en la lista blanca, que la confirmación sea de verdad, y que quede
 * rastro en una tabla que este mismo botón no puede borrar.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' }
});

const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const { purgarDatos, contarFilas, TABLAS_PURGABLES } = await import('../src/admin/data-purge.js');

function baseDeDatos() {
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  // Dos clínicas con datos, que es justo el escenario que hay que proteger.
  db.seed('helios_inbound_buffer', [
    { id: 1, tenant_id: 'democoi1', conversation_id: '1', body: 'de COI' },
    { id: 2, tenant_id: 'democoi1', conversation_id: '2', body: 'de COI' },
    { id: 3, tenant_id: 'fisio7', conversation_id: '9', body: 'DE OTRA CLINICA' }
  ]);
  db.seed('helios_conversation_state', [
    { tenant_id: 'democoi1', conversation_id: '1' },
    { tenant_id: 'fisio7', conversation_id: '9' }
  ]);
  db.seed('helios_chatwoot_outbox', [{ outbox_key: 'a', tenant_id: 'democoi1', batch_key: 'b1' }]);
  db.seed('helios_processing_batches', [{ batch_key: 'b1', tenant_id: 'democoi1' }]);
  db.seed('helios_data_purge_audit', []);
  db.seed('helios_tenants', [
    { tenant_id: 'democoi1', username: 'coi' },
    { tenant_id: 'fisio7', username: 'fisio' }
  ]);
  __setSupabaseClientForTests(db as any);
  return db;
}

// --- LO MÁS IMPORTANTE: no se cruzan las clínicas ---------------------------

let db = baseDeDatos();
let r = await purgarDatos({
  tenantId: 'democoi1',
  solicitadoPor: 'democoi1',
  tablas: ['helios_inbound_buffer', 'helios_conversation_state'],
  confirmacion: 'democoi1'
});

assert.equal(r.ok, true, 'la purga se ejecuta');
const buffer = db.table('helios_inbound_buffer');
assert.equal(buffer.length, 1, 'queda exactamente una fila');
assert.equal(
  buffer[0].tenant_id,
  'fisio7',
  'y ES LA DE LA OTRA CLINICA: no se tocó lo que no era suyo'
);
assert.equal(
  db.table('helios_conversation_state').filter((f: any) => f.tenant_id === 'fisio7').length,
  1,
  'la otra clínica conserva su estado'
);

// --- La confirmación tiene que coincidir ------------------------------------

db = baseDeDatos();
for (const intento of ['', 'si', 'DEMOCOI1', 'democoi', ' democoi1 x', 'fisio7']) {
  const salida = await purgarDatos({
    tenantId: 'democoi1', solicitadoPor: 'democoi1',
    tablas: ['helios_inbound_buffer'], confirmacion: intento
  });
  assert.equal(salida.ok, false, `«${intento}» no debe valer como confirmación`);
  assert.equal(salida.error, 'CONFIRMACION_NO_COINCIDE');
}
assert.equal(db.table('helios_inbound_buffer').length, 3, 'no se borró nada sin confirmar');

// Con espacios alrededor sí vale: es un descuido al copiar, no otra clínica.
assert.equal(
  (await purgarDatos({
    tenantId: 'democoi1', solicitadoPor: 'democoi1',
    tablas: ['helios_inbound_buffer'], confirmacion: '  democoi1  '
  })).ok,
  true
);

// --- Lista blanca: no se puede pedir cualquier tabla ------------------------

db = baseDeDatos();
for (const prohibida of ['helios_tenants', 'helios_data_purge_audit', 'usuarios', '']) {
  const salida = await purgarDatos({
    tenantId: 'democoi1', solicitadoPor: 'democoi1',
    tablas: [prohibida], confirmacion: 'democoi1'
  });
  assert.equal(salida.ok, false, `${prohibida} no puede purgarse`);
  assert.match(String(salida.error), /TABLA_NO_PERMITIDA|SIN_TABLAS/);
}
assert.equal(db.table('helios_tenants').length, 2, 'LA CONFIGURACIÓN DE LAS CLÍNICAS SIGUE INTACTA');

// Una tabla no permitida mezclada con una válida invalida la petición entera:
// no se ignora en silencio.
const mezclada = await purgarDatos({
  tenantId: 'democoi1', solicitadoPor: 'democoi1',
  tablas: ['helios_inbound_buffer', 'helios_tenants'], confirmacion: 'democoi1'
});
assert.equal(mezclada.ok, false);
assert.equal(db.table('helios_inbound_buffer').length, 3, 'y no se borró la parte válida');

// --- Dependencias por clave foránea -----------------------------------------
// Pedir los lotes sin el outbox reventaría a mitad del borrado.

db = baseDeDatos();
r = await purgarDatos({
  tenantId: 'democoi1', solicitadoPor: 'democoi1',
  tablas: ['helios_processing_batches'], confirmacion: 'democoi1'
});
assert.equal(r.ok, true);
assert.deepEqual(
  r.anadidas_por_dependencia,
  ['helios_chatwoot_outbox'],
  'el outbox se añade solo, y se avisa de que se añadió'
);
assert.equal(db.table('helios_chatwoot_outbox').length, 0);
assert.equal(db.table('helios_processing_batches').length, 0);

// --- El rastro se escribe, y no es borrable ---------------------------------

const auditoria = db.table('helios_data_purge_audit');
assert.equal(auditoria.length, 1, 'queda constancia del borrado');
assert.equal(auditoria[0].tenant_id, 'democoi1');
assert.equal(auditoria[0].requested_by, 'democoi1');
assert.equal(auditoria[0].confirmation_text, 'democoi1', 'se guarda qué se escribió para confirmar');
assert.ok(auditoria[0].rows_deleted >= 2);

assert.equal(
  TABLAS_PURGABLES.some(t => t.tabla === 'helios_data_purge_audit'),
  false,
  'la tabla de auditoría NO está en la lista blanca: el botón no puede borrar su propia prueba'
);
assert.equal(
  TABLAS_PURGABLES.some(t => t.tabla === 'helios_tenants'),
  false,
  'ni la configuración de las clínicas'
);

// --- Contar antes de borrar --------------------------------------------------

db = baseDeDatos();
const conteo = await contarFilas('democoi1');
const bufferConteo = conteo.find(c => c.tabla === 'helios_inbound_buffer');
assert.equal(bufferConteo?.filas, 2, 'cuenta solo las filas de esta clínica, no las de la otra');
assert.ok(conteo.every(c => c.etiqueta && c.grupo), 'todas las tablas tienen nombre legible y grupo');
assert.ok(
  conteo.find(c => c.tabla === 'helios_patient_profiles')?.advertencia,
  'los perfiles de paciente avisan de la consecuencia'
);

console.log('data_purge_test: PASS');

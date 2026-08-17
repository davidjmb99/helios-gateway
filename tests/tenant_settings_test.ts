/**
 * Ajustes por clínica: el tiempo de espera del buffer.
 *
 * Lo que se protege aquí, por orden de gravedad:
 *
 *  1. Que el buffer USE de verdad el valor de la clínica. Es lo único que
 *     demuestra que el ajuste no es decorativo, y se comprueba midiendo con qué
 *     espera se agenda el temporizador real.
 *  2. Que una clínica no le cambie el buffer a otra.
 *  3. Que un valor imposible -0, un millón, texto- no llegue nunca al
 *     temporizador, ni desde el panel ni escrito a mano en la base.
 *  4. Que si la base no contesta, se siga procesando con el valor de siempre. Un
 *     ajuste caído no puede dejar a un paciente sin respuesta.
 *  5. Que no se consulte la base en cada mensaje.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.BUFFER_MS = '5000';
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' },
  '7': { tenant_id: 'fisio7', clinic_id: 'fisio', hermes_profile: 'fisio' }
});

const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const settings = await import('../src/tenants/settings.js');

const DOS_CLINICAS = [
  { tenant_id: 'democoi1', username: 'coi' },
  { tenant_id: 'fisio7', username: 'fisio' }
];

function baseDeDatos(filas: any[] = DOS_CLINICAS) {
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  db.seed('helios_tenants', JSON.parse(JSON.stringify(filas)));
  db.seed('helios_inbound_buffer', []);
  __setSupabaseClientForTests(db as any);
  settings.__limpiarCacheAjustes();
  return db;
}

function fila(db: any, tenantId: string) {
  return db.table('helios_tenants').find((f: any) => f.tenant_id === tenantId);
}

// --- Sin elegir nada: se comporta como antes de esta función -----------------

let db = baseDeDatos();
let ajuste = await settings.leerAjustes('democoi1');
assert.equal(ajuste.buffer_ms, 5000, 'sin elegir se usa el valor del entorno');
assert.equal(ajuste.origen, 'defecto', 'y el panel dice que no lo ha elegido la clínica');
assert.deepEqual(ajuste.opciones, [5000, 8000, 10000, 15000]);
assert.equal(ajuste.por_defecto, 5000);

// --- Guardar se nota AL INSTANTE, no cuando caduque la caché -----------------

await settings.obtenerBufferMs('democoi1'); // deja la caché caliente, como al abrir el panel
const guardado = await settings.guardarBufferMs('democoi1', 10000);
assert.equal(guardado.ok, true);
assert.equal(
  await settings.obtenerBufferMs('democoi1'),
  10000,
  'si no se invalidara la caché, esto seguiría diciendo 5000 durante un minuto'
);
assert.equal(fila(db, 'democoi1').buffer_ms, 10000, 'y queda escrito en la base');
assert.equal((await settings.leerAjustes('democoi1')).origen, 'clinica');

// --- LO MÁS IMPORTANTE: no se cruzan las clínicas ----------------------------

assert.equal(await settings.obtenerBufferMs('fisio7'), 5000, 'la otra clínica no se ha enterado');
assert.equal(fila(db, 'fisio7').buffer_ms, undefined, 'y su fila sigue sin tocar');

// --- El rango es el freno ----------------------------------------------------

for (const malo of [0, 100, 2999, 30001, 999999, -5000, 'abc', null, undefined, '', NaN, {}, []]) {
  const salida = await settings.guardarBufferMs('democoi1', malo);
  assert.equal(salida.ok, false, `«${String(malo)}» no debe poder guardarse`);
  assert.equal(salida.error, 'BUFFER_FUERA_DE_RANGO');
}
assert.equal(await settings.obtenerBufferMs('democoi1'), 10000, 'y el valor bueno sigue en pie');

// Un valor válido que no está en el desplegable SÍ se acepta: lo que protege es
// el rango, no la lista de botones. Así se puede afinar sin tocar código.
assert.equal((await settings.guardarBufferMs('democoi1', 7000)).ok, true);
assert.equal(await settings.obtenerBufferMs('democoi1'), 7000);

// --- Basura escrita a mano en la columna -------------------------------------
// La migración pone un CHECK, pero el código no puede depender de que exista:
// la columna pudo editarse antes, o desde otro sitio.

for (const basura of [0, 999999, -1, 'diez segundos']) {
  baseDeDatos([{ tenant_id: 'democoi1', buffer_ms: basura }]);
  assert.equal(
    await settings.obtenerBufferMs('democoi1'),
    5000,
    `un ${String(basura)} en la base se ignora y se usa el valor de siempre`
  );
  assert.equal((await settings.leerAjustes('democoi1')).origen, 'defecto');
}

// --- Con la base caída se sigue trabajando -----------------------------------

const baseRota = {
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) })
    })
  })
};
__setSupabaseClientForTests(baseRota as any);
settings.__limpiarCacheAjustes();
const antesDeFallar = settings.settingsMetrics.fallos_de_lectura;
assert.equal(
  await settings.obtenerBufferMs('democoi1'),
  5000,
  'con la base caída se usa el valor de siempre en vez de lanzar'
);
assert.equal(settings.settingsMetrics.fallos_de_lectura, antesDeFallar + 1, 'y queda contado');

// --- No se consulta la base en cada mensaje ---------------------------------

db = baseDeDatos([{ tenant_id: 'democoi1', buffer_ms: 8000 }]);
let consultas = 0;
const fromOriginal = db.from.bind(db);
(db as any).from = (tabla: string) => {
  if (tabla === 'helios_tenants') consultas += 1;
  return fromOriginal(tabla);
};
for (let i = 0; i < 50; i++) await settings.obtenerBufferMs('democoi1');
assert.equal(consultas, 1, 'cincuenta mensajes, una sola consulta a la base');
assert.equal(settingsLecturasDesdeCache() >= 49, true);
function settingsLecturasDesdeCache() { return settings.settingsMetrics.lecturas_desde_cache; }

// --- Y AHORA LO QUE IMPORTA: que el buffer lo use de verdad -----------------
// Se mide con qué espera se agenda el temporizador real. Sin esto, todo lo
// anterior podría estar bien y el buffer seguir esperando siempre 5 segundos.

const { bufferService } = await import('../src/buffer/buffer-service.js');

const setTimeoutOriginal = global.setTimeout;
async function esperaConLaQueSeAgenda(tenantId: string): Promise<number | null> {
  let vista: number | null = null;
  (global as any).setTimeout = (fn: any, ms: number) => {
    vista = ms;
    return setTimeoutOriginal(() => {}, 0); // no se ejecuta el flush: solo medimos
  };
  try {
    await bufferService.addMessage({
      tenant_id: tenantId,
      conversation_id: '1',
      contact_id: 'c1',
      inbox_id: '1',
      message_id: 'm-' + tenantId,
      source_id: 's1',
      text: 'hola',
      direction: 'incoming',
      created_at: new Date().toISOString(),
      trace_id: 't-' + tenantId
    } as any);
  } finally {
    (global as any).setTimeout = setTimeoutOriginal;
  }
  return vista;
}

assert.equal(
  await esperaConLaQueSeAgenda('democoi1'),
  8000,
  'EL BUFFER AGENDA CON LA ESPERA DE LA CLÍNICA, no con la del entorno'
);

// La clínica que no ha elegido nada sigue con la de siempre, en la misma base.
db.seed('helios_tenants', [{ tenant_id: 'democoi1', buffer_ms: 8000 }, { tenant_id: 'fisio7' }]);
settings.__limpiarCacheAjustes();
assert.equal(await esperaConLaQueSeAgenda('fisio7'), 5000, 'y la que no eligió, con la del entorno');
assert.equal(await esperaConLaQueSeAgenda('democoi1'), 8000, 'las dos a la vez, cada una con la suya');

console.log('tenant_settings_test: PASS');

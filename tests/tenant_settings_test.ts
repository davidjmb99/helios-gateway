/**
 * Ajustes por clínica: la espera del buffer y las horas de vuelta a la IA.
 *
 * Lo que se protege aquí, por orden de gravedad:
 *
 *  1. Que el sistema USE de verdad el valor de la clínica. Es lo único que
 *     demuestra que el ajuste no es decorativo: para el buffer se mide con qué
 *     espera se agenda el temporizador REAL, y para la vuelta se comprueba que dos
 *     clínicas con umbrales distintos deciden distinto sobre la misma inactividad.
 *  2. Que una clínica no le cambie los ajustes a otra.
 *  3. Que un valor imposible no llegue nunca a producción, ni desde el panel ni
 *     escrito a mano en la base.
 *  4. Que si la base no contesta, se siga trabajando con los valores del entorno.
 *     Un ajuste caído no puede dejar a un paciente sin respuesta.
 *  5. Que no se consulte la base en cada mensaje.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.BUFFER_MS = '5000';
process.env.HELIOS_HANDOFF_STALE_HOURS = '5';
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' },
  '7': { tenant_id: 'fisio7', clinic_id: 'fisio', hermes_profile: 'fisio' }
});

const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const settings = await import('../src/tenants/settings.js');
const { decidirVuelta } = await import('../src/handoff/stale-policy.js');

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

// --- Sin elegir nada: se comporta como antes de que esto existiera -----------

let db = baseDeDatos();
let ajuste = await settings.leerAjustes('democoi1');
assert.equal(ajuste.buffer_ms, 5000, 'sin elegir se usa el valor del entorno');
assert.equal(ajuste.origen.buffer_ms, 'defecto', 'y el panel dice que no lo eligió la clínica');
assert.deepEqual(ajuste.buffer_opciones, [5000, 8000, 10000, 15000]);
assert.equal(ajuste.handoff_stale_hours, 5, 'y las horas de vuelta, igual');
assert.equal(ajuste.origen.handoff_stale_hours, 'defecto');
assert.deepEqual(ajuste.handoff_stale_opciones, [1, 2, 3, 5, 8]);

// --- Guardar se nota AL INSTANTE, no cuando caduque la caché -----------------

await settings.obtenerBufferMs('democoi1'); // deja la caché caliente, como al abrir el panel
let guardado = await settings.guardarAjustes('democoi1', { buffer_ms: 10000, handoff_stale_hours: 2 });
assert.equal(guardado.ok, true);
assert.deepEqual(guardado.cambios, { buffer_ms: 10000, handoff_stale_hours: 2 });
assert.equal(
  await settings.obtenerBufferMs('democoi1'),
  10000,
  'si no se invalidara la caché, esto seguiría diciendo 5000 durante un minuto'
);
assert.equal(await settings.obtenerHorasVuelta('democoi1'), 2);
assert.equal(fila(db, 'democoi1').buffer_ms, 10000, 'y queda escrito en la base');
assert.equal(fila(db, 'democoi1').handoff_stale_hours, 2);

ajuste = await settings.leerAjustes('democoi1');
assert.equal(ajuste.origen.buffer_ms, 'clinica');
assert.equal(ajuste.origen.handoff_stale_hours, 'clinica');

// --- LO MÁS IMPORTANTE: no se cruzan las clínicas ----------------------------

assert.equal(await settings.obtenerBufferMs('fisio7'), 5000, 'la otra clínica no se ha enterado');
assert.equal(await settings.obtenerHorasVuelta('fisio7'), 5);
assert.equal(fila(db, 'fisio7').buffer_ms, undefined, 'y su fila sigue sin tocar');
assert.equal(fila(db, 'fisio7').handoff_stale_hours, undefined);

// --- Y AHORA EL EFECTO: dos clínicas deciden distinto sobre lo mismo ---------
// Una conversación que lleva 3 horas sin actividad. Para COI, que eligió 2 horas,
// vuelve a la IA. Para la otra, que sigue con las 5 del entorno, no. Sin esto el
// ajuste podría guardarse perfecto y no cambiar nada del flujo.

const AHORA = new Date('2026-08-17T18:00:00Z');
const haceTresHoras = new Date(AHORA.getTime() - 3 * 3600_000).toISOString();

assert.equal(
  decidirVuelta({
    referencia: haceTresHoras,
    umbralHoras: await settings.obtenerHorasVuelta('democoi1'),
    ahora: AHORA
  }).volver,
  true,
  'COI eligió 2 horas: a las 3 horas la conversación VUELVE a la IA'
);
assert.equal(
  decidirVuelta({
    referencia: haceTresHoras,
    umbralHoras: await settings.obtenerHorasVuelta('fisio7'),
    ahora: AHORA
  }).volver,
  false,
  'la otra clínica sigue en 5 horas: la MISMA inactividad NO la devuelve'
);

// --- El umbral con el que consulta el barrido -------------------------------
// Tiene que ser el MÁS PERMISIVO de todas. Si el barrido preguntara por el umbral
// por defecto, a la clínica que eligió 2 horas no le volvería nada nunca.

assert.equal(
  await settings.umbralMinimoDeVuelta(),
  2,
  'el barrido consulta con el umbral más pequeño de todas las clínicas'
);
await settings.guardarAjustes('fisio7', { handoff_stale_hours: 1 });
assert.equal(await settings.umbralMinimoDeVuelta(), 1, 'y se ajusta cuando otra baja más');

// --- Los rangos son el freno -------------------------------------------------

for (const malo of [0, 100, 2999, 30001, 999999, -5000, 'abc', null, undefined, '', NaN, {}, []]) {
  const salida = await settings.guardarAjustes('democoi1', { buffer_ms: malo });
  assert.equal(salida.ok, false, `buffer «${String(malo)}» no debe poder guardarse`);
  assert.equal(salida.error, 'BUFFER_FUERA_DE_RANGO');
}
for (const malo of [0, -1, 49, 168, 'dos', null, undefined, '', NaN, Infinity]) {
  const salida = await settings.guardarAjustes('democoi1', { handoff_stale_hours: malo });
  assert.equal(salida.ok, false, `vuelta «${String(malo)}» no debe poder guardarse`);
  assert.equal(salida.error, 'HORAS_VUELTA_FUERA_DE_RANGO');
}
assert.equal(await settings.obtenerBufferMs('democoi1'), 10000, 'y los valores buenos siguen en pie');
assert.equal(await settings.obtenerHorasVuelta('democoi1'), 2);

// Si un campo viene mal, NO se guarda NINGUNO. Media petición aplicada dejaría la
// pantalla mostrando un estado que no es el que hay.
const mezclada = await settings.guardarAjustes('democoi1', { buffer_ms: 8000, handoff_stale_hours: 999 });
assert.equal(mezclada.ok, false);
assert.equal(await settings.obtenerBufferMs('democoi1'), 10000, 'el campo válido tampoco se aplicó');

// Una petición sin nada reconocible se rechaza en vez de responder «ok» sin hacer
// nada, que es la clase de silencio que hace perder una tarde.
assert.equal((await settings.guardarAjustes('democoi1', {})).error, 'SIN_CAMBIOS');
assert.equal((await settings.guardarAjustes('democoi1', { color: 'azul' })).error, 'SIN_CAMBIOS');

// Un valor válido fuera del desplegable sí se acepta: protege el rango, no la lista
// de botones. Así se puede afinar sin tocar código.
assert.equal((await settings.guardarAjustes('democoi1', { buffer_ms: 7000, handoff_stale_hours: 4 })).ok, true);
assert.equal(await settings.obtenerBufferMs('democoi1'), 7000);
assert.equal(await settings.obtenerHorasVuelta('democoi1'), 4);

// --- Basura escrita a mano en las columnas ----------------------------------
// Las migraciones ponen un CHECK, pero el código no puede depender de que exista:
// las columnas pudieron editarse antes, o desde otro sitio.

for (const basura of [0, 999999, -1, 'diez segundos']) {
  baseDeDatos([{ tenant_id: 'democoi1', buffer_ms: basura, handoff_stale_hours: basura }]);
  assert.equal(await settings.obtenerBufferMs('democoi1'), 5000, `buffer ${String(basura)} se ignora`);
  assert.equal(await settings.obtenerHorasVuelta('democoi1'), 5, `vuelta ${String(basura)} se ignora`);
  const leido = await settings.leerAjustes('democoi1');
  assert.equal(leido.origen.buffer_ms, 'defecto');
  assert.equal(leido.origen.handoff_stale_hours, 'defecto');
}

// --- Con la base caída se sigue trabajando ----------------------------------

const baseRota = { from: () => ({ select: async () => ({ data: null, error: { message: 'boom' } }) }) };
__setSupabaseClientForTests(baseRota as any);
settings.__limpiarCacheAjustes();
const antesDeFallar = settings.settingsMetrics.fallos_de_lectura;
assert.equal(await settings.obtenerBufferMs('democoi1'), 5000, 'con la base caída, el valor del entorno');
assert.equal(await settings.obtenerHorasVuelta('democoi1'), 5);
assert.equal(await settings.umbralMinimoDeVuelta(), 5, 'y el barrido sigue funcionando con el de siempre');
assert.equal(settings.settingsMetrics.fallos_de_lectura, antesDeFallar + 1, 'queda contado');

// --- No se consulta la base en cada mensaje ---------------------------------

db = baseDeDatos([{ tenant_id: 'democoi1', buffer_ms: 8000, handoff_stale_hours: 3 }]);
let consultas = 0;
const fromOriginal = db.from.bind(db);
(db as any).from = (tabla: string) => {
  if (tabla === 'helios_tenants') consultas += 1;
  return fromOriginal(tabla);
};
for (let i = 0; i < 50; i++) {
  await settings.obtenerBufferMs('democoi1');
  await settings.obtenerHorasVuelta('democoi1');
}
assert.equal(consultas, 1, 'cien lecturas, una sola consulta a la base');

// --- Y que el buffer USE de verdad ese valor --------------------------------
// Se mide con qué espera se agenda el temporizador real. Sin esto, todo lo anterior
// podría estar bien y el buffer seguir esperando siempre 5 segundos.

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

db.replace('helios_tenants', [{ tenant_id: 'democoi1', buffer_ms: 8000 }, { tenant_id: 'fisio7' }]);
settings.__limpiarCacheAjustes();
assert.equal(await esperaConLaQueSeAgenda('fisio7'), 5000, 'y la que no eligió, con la del entorno');
assert.equal(await esperaConLaQueSeAgenda('democoi1'), 8000, 'las dos a la vez, cada una con la suya');

console.log('tenant_settings_test: PASS');

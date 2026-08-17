/**
 * El BARRIDO que devuelve conversaciones a la IA, con umbral por clínica.
 *
 * Este barrido no tenía ninguna prueba. Y es el que decide quitarle una
 * conversación a una persona que la está atendiendo, así que es de los peores
 * sitios donde tener un fallo silencioso.
 *
 * Lo que se prueba aquí es lo que NO puede ver stale_policy_test: que el barrido
 * consulte con el umbral más permisivo de todas las clínicas y que después filtre
 * cada conversación con el de SU clínica. Se puede tener la decisión perfecta y el
 * barrido preguntando mal, y entonces a la clínica que baja el umbral no le vuelve
 * nada nunca.
 *
 * COMO SE MIDE: se observa a qué conversaciones el barrido escribe el estado, que
 * es lo primero que hace al devolver una. Así se distingue lo único que importa
 * aquí: si el barrido ELIGIO esa conversación o la dejó en paz. Lo que ocurra
 * después con Chatwoot es otra prueba.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.HELIOS_HANDOFF_ENABLED = 'true';
process.env.HELIOS_HANDOFF_STALE_HOURS = '5';
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' },
  '7': { tenant_id: 'fisio7', clinic_id: 'fisio', hermes_profile: 'fisio' }
});
process.env.CHATWOOT_BASE_URL = 'http://127.0.0.1:1';
process.env.CHATWOOT_API_ACCESS_TOKEN = 'fake';

const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const settings = await import('../src/tenants/settings.js');
const { runStaleHandoffSweep, staleHandoffMetrics } = await import('../src/services/handoff-stale-worker.js');

const hace = (horas: number) => new Date(Date.now() - horas * 3600_000).toISOString();

/**
 * Dos clínicas, una conversación cada una, las dos derivadas a una persona y las
 * dos con la MISMA inactividad: tres horas.
 */
function montarEscenario(ajustes: Array<Record<string, any>>) {
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  db.seed('helios_tenants', JSON.parse(JSON.stringify(ajustes)));
  db.seed('helios_conversation_state', [
    {
      tenant_id: 'democoi1', conversation_id: '100', contact_id: 'c1', inbox_id: '1',
      phone: '+34600000001', stage: 'human_active', handoff_id: 'h1',
      handoff_requested_at: hace(3), updated_at: hace(3)
    },
    {
      tenant_id: 'fisio7', conversation_id: '200', contact_id: 'c2', inbox_id: '1',
      phone: '+34600000002', stage: 'human_active', handoff_id: 'h2',
      handoff_requested_at: hace(3), updated_at: hace(3)
    }
  ]);
  db.seed('helios_inbound_buffer', [
    { id: 1, tenant_id: 'democoi1', conversation_id: '100', created_at: hace(3), body: 'hola' },
    { id: 2, tenant_id: 'fisio7', conversation_id: '200', created_at: hace(3), body: 'hola' }
  ]);
  db.seed('helios_gateway_logs', []);
  db.seed('helios_handoff_events', []);
  db.seed('helios_notification_outbox', []);
  __setSupabaseClientForTests(db as any);
  settings.__limpiarCacheAjustes();
  return db;
}

/** Conversaciones que el barrido llegó a tocar, sea con éxito o fallando al final. */
async function conversacionesIntentadas(db: any): Promise<string[]> {
  const tocadas = new Set<string>();
  const fromOriginal = db.from.bind(db);
  (db as any).from = (tabla: string) => {
    const query = fromOriginal(tabla);
    // returnConversationToBot empieza escribiendo el estado de la conversación.
    if (tabla === 'helios_conversation_state') {
      const upsertOriginal = query.upsert?.bind(query);
      if (upsertOriginal) {
        query.upsert = (payload: any, opciones: any) => {
          const filas = Array.isArray(payload) ? payload : [payload];
          for (const f of filas) if (f?.conversation_id) tocadas.add(String(f.conversation_id));
          return upsertOriginal(payload, opciones);
        };
      }
    }
    return query;
  };
  await runStaleHandoffSweep();
  return [...tocadas].sort();
}

// --- Las dos con el valor de siempre: a las 3 horas NO vuelve ninguna --------

let db = montarEscenario([{ tenant_id: 'democoi1' }, { tenant_id: 'fisio7' }]);
assert.deepEqual(
  await conversacionesIntentadas(db),
  [],
  'con el umbral por defecto de 5 horas, tres horas de inactividad no devuelven nada'
);

// --- COI baja a 2 horas: vuelve LA SUYA, y solo la suya ---------------------
// Es el caso que pidió el operador: "que si no quiero que el bot inicie a las 5
// horas de inactividad sino a las 2 horas o 1".

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 2 },
  { tenant_id: 'fisio7' }
]);
assert.deepEqual(
  await conversacionesIntentadas(db),
  ['100'],
  'COI en 2 horas: vuelve la 100 y NO se toca la 200 de la otra clínica'
);

// Si el barrido consultara con el umbral por defecto en vez del más permisivo,
// la 100 no habría entrado siquiera en la lista de candidatas. Este es el fallo
// concreto que la prueba anterior no podía ver.
assert.equal(await settings.umbralMinimoDeVuelta(), 2);

// --- Una hora: sigue siendo solo la de esa clínica --------------------------

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 1 },
  { tenant_id: 'fisio7' }
]);
assert.deepEqual(await conversacionesIntentadas(db), ['100'], 'con 1 hora, igual de aislado');

// --- Las dos bajan: vuelven las dos ----------------------------------------

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 2 },
  { tenant_id: 'fisio7', handoff_stale_hours: 1 }
]);
assert.deepEqual(await conversacionesIntentadas(db), ['100', '200'], 'las dos por debajo: vuelven las dos');

// --- Subir el umbral también surte efecto ----------------------------------
// No solo hacia abajo: una clínica que ponga 8 horas deja de recibir vueltas que
// con el valor por defecto sí tendría.

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 8 },
  { tenant_id: 'fisio7', handoff_stale_hours: 1 }
]);
assert.deepEqual(
  await conversacionesIntentadas(db),
  ['200'],
  'COI en 8 horas no vuelve a las 3; la otra en 1 hora sí'
);

// --- Con el handoff apagado no se toca nada --------------------------------

process.env.HELIOS_HANDOFF_ENABLED = 'false';
const { config: configRecargada } = await import('../src/config.js');
if (configRecargada.HELIOS_HANDOFF_ENABLED) {
  // La configuración se lee una vez al importar, así que este escenario solo se
  // puede comprobar si el módulo se cargó con el flag apagado. Se deja anotado en
  // vez de fingir que se probó.
  console.log('  (el flag apagado no se puede comprobar en este proceso: config ya cargada)');
}

assert.ok(staleHandoffMetrics.last_sweep_at, 'el barrido deja constancia de haber corrido');

console.log('stale_worker_test: PASS');

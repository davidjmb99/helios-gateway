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
 * HORARIOS PARA QUE ESTA PRUEBA NO DEPENDA DE LA HORA A LA QUE SE EJECUTE.
 *
 * Desde que el umbral se mide en HORAS DE ATENCION y no de reloj, una clinica sin
 * horario explicito hereda el de por defecto -de 10 a 20- y entonces el resultado
 * cambiaria segun la hora del dia en que se lance la suite: verde por la tarde,
 * roja por la noche. Una prueba que depende del reloj de quien la corre no protege
 * de nada.
 *
 * ABIERTA es practicamente 24/7, asi que las horas de atencion coinciden con las de
 * reloj y esta prueba sigue midiendo lo suyo: el umbral por clinica.
 * CASI_CERRADA abre un minuto al dia, asi que en tres horas de reloj hay como mucho
 * un minuto de atencion se lance cuando se lance.
 */
const ABIERTA = {
  sun: [['00:00', '23:59']], mon: [['00:00', '23:59']], tue: [['00:00', '23:59']],
  wed: [['00:00', '23:59']], thu: [['00:00', '23:59']], fri: [['00:00', '23:59']],
  sat: [['00:00', '23:59']]
};
const CASI_CERRADA = {
  sun: [['03:00', '03:01']], mon: [['03:00', '03:01']], tue: [['03:00', '03:01']],
  wed: [['03:00', '03:01']], thu: [['03:00', '03:01']], fri: [['03:00', '03:01']],
  sat: [['03:00', '03:01']]
};
const ZONA = 'America/Caracas';

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
    { id: 2, tenant_id: 'fisio7', conversation_id: '200', created_at: hace(3), body: 'hola' },
    // ALGUIEN DEL EQUIPO YA CONTESTO. Sin esto, desde el 21-ago estas conversaciones
    // caen en «sin atender» y NO se devuelven, por lo que pidio David: el reloj de
    // inactividad mide cuanto lleva parada una atencion que empezo. Estos escenarios
    // prueban el umbral por clinica, que es otra cosa, asi que la atencion tiene que
    // haber empezado.
    {
      id: 3, tenant_id: 'democoi1', conversation_id: '100', created_at: hace(3),
      body: 'Buenas, le atiendo yo', direction: 'outgoing', author: 'clinic_team'
    },
    {
      id: 4, tenant_id: 'fisio7', conversation_id: '200', created_at: hace(3),
      body: 'Buenas, le atiendo yo', direction: 'outgoing', author: 'clinic_team'
    }
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

let db = montarEscenario([
  { tenant_id: 'democoi1', clinic_hours: ABIERTA, clinic_timezone: ZONA },
  { tenant_id: 'fisio7', clinic_hours: ABIERTA, clinic_timezone: ZONA }
]);
assert.deepEqual(
  await conversacionesIntentadas(db),
  [],
  'con el umbral por defecto de 5 horas, tres horas de inactividad no devuelven nada'
);

// --- COI baja a 2 horas: vuelve LA SUYA, y solo la suya ---------------------
// Es el caso que pidió el operador: "que si no quiero que el bot inicie a las 5
// horas de inactividad sino a las 2 horas o 1".

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 2, clinic_hours: ABIERTA, clinic_timezone: ZONA },
  { tenant_id: 'fisio7', clinic_hours: ABIERTA, clinic_timezone: ZONA }
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
  { tenant_id: 'democoi1', handoff_stale_hours: 1, clinic_hours: ABIERTA, clinic_timezone: ZONA },
  { tenant_id: 'fisio7', clinic_hours: ABIERTA, clinic_timezone: ZONA }
]);
assert.deepEqual(await conversacionesIntentadas(db), ['100'], 'con 1 hora, igual de aislado');

// --- Las dos bajan: vuelven las dos ----------------------------------------

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 2, clinic_hours: ABIERTA, clinic_timezone: ZONA },
  { tenant_id: 'fisio7', handoff_stale_hours: 1, clinic_hours: ABIERTA, clinic_timezone: ZONA }
]);
assert.deepEqual(await conversacionesIntentadas(db), ['100', '200'], 'las dos por debajo: vuelven las dos');

// --- Subir el umbral también surte efecto ----------------------------------
// No solo hacia abajo: una clínica que ponga 8 horas deja de recibir vueltas que
// con el valor por defecto sí tendría.

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 8, clinic_hours: ABIERTA, clinic_timezone: ZONA },
  { tenant_id: 'fisio7', handoff_stale_hours: 1, clinic_hours: ABIERTA, clinic_timezone: ZONA }
]);
assert.deepEqual(
  await conversacionesIntentadas(db),
  ['200'],
  'COI en 8 horas no vuelve a las 3; la otra en 1 hora sí'
);

// --- CON LA CLINICA CERRADA, EL RELOJ NO CORRE -----------------------------
//
// EL CASO DE DAVID, 20-ago-2026: «imaginate que yo pida hablar con un humano ahorita
// [20:03, la clinica cierra a las 20:00]. Obviamente me va a tomar la conversacion a
// las 10am. Y con lo de inactividad, en 3 horas lo devuelve a modo IA. Entonces ese
// caso no lo va a tomar nadie.»
//
// Devolverla de madrugada no es un detalle de contabilidad: BORRA LA PETICION. Por la
// mañana no hay ninguna derivacion esperando y el paciente que pidio hablar con una
// persona nunca llega a nadie.
//
// Los datos son EXACTAMENTE los mismos que en el escenario que si devuelve la 100
// -tres horas de inactividad, umbral de dos-. Lo unico que cambia es el horario. Si
// el barrido no mirara el horario, aqui volveria a devolverla.

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 2, clinic_hours: CASI_CERRADA, clinic_timezone: ZONA },
  { tenant_id: 'fisio7', handoff_stale_hours: 2, clinic_hours: ABIERTA, clinic_timezone: ZONA }
]);
assert.deepEqual(
  await conversacionesIntentadas(db),
  ['200'],
  'la 100 esta con la clinica cerrada y su plazo no ha empezado; la 200, con la clinica '
  + 'abierta y los mismos datos, si vuelve. Si vuelven las dos, el barrido no mira el horario'
);

// --- UNA DERIVACION QUE NADIE HA TOCADO NO SE DEVUELVE ---------------------
//
// LO PIDIO DAVID el 21-ago-2026: «no la quita hasta que la atienda el humano; lo de
// inactividad es solo cuando ya la persona recibio respuesta humana».
//
// Los datos son LOS MISMOS que en el escenario que si devuelve la 100 -tres horas de
// inactividad, umbral de dos, horario abierto-. Lo unico que cambia es que aqui NADIE
// del equipo ha escrito. Antes de este cambio, la 100 volvia a la IA y la peticion del
// paciente desaparecia sin que nadie se enterase.

db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 2, clinic_hours: ABIERTA, clinic_timezone: ZONA },
  { tenant_id: 'fisio7', handoff_stale_hours: 2, clinic_hours: ABIERTA, clinic_timezone: ZONA }
]);
// Se quitan las respuestas del equipo: nadie ha atendido ninguna de las dos.
db.seed('helios_inbound_buffer', [
  { id: 1, tenant_id: 'democoi1', conversation_id: '100', created_at: hace(3), body: 'hola' },
  { id: 2, tenant_id: 'fisio7', conversation_id: '200', created_at: hace(3), body: 'hola' }
]);
assert.deepEqual(
  await conversacionesIntentadas(db),
  [],
  'sin que nadie las haya atendido, NINGUNA se devuelve a la IA: el paciente pidio una '
  + 'persona y sigue en su cola. Si aqui vuelve alguna, se esta borrando su peticion'
);

// Y CON UNA ATENDIDA Y OTRA NO, se distinguen. Este es el par que demuestra que la
// diferencia la hace la respuesta humana y no otra cosa del escenario.
db = montarEscenario([
  { tenant_id: 'democoi1', handoff_stale_hours: 2, clinic_hours: ABIERTA, clinic_timezone: ZONA },
  { tenant_id: 'fisio7', handoff_stale_hours: 2, clinic_hours: ABIERTA, clinic_timezone: ZONA }
]);
db.seed('helios_inbound_buffer', [
  { id: 1, tenant_id: 'democoi1', conversation_id: '100', created_at: hace(3), body: 'hola' },
  { id: 2, tenant_id: 'fisio7', conversation_id: '200', created_at: hace(3), body: 'hola' },
  // Solo la 100 recibio respuesta humana.
  {
    id: 3, tenant_id: 'democoi1', conversation_id: '100', created_at: hace(3),
    body: 'Buenas, le atiendo yo', direction: 'outgoing', author: 'clinic_team'
  }
]);
assert.deepEqual(
  await conversacionesIntentadas(db),
  ['100'],
  'la 100 fue atendida y luego se quedo parada tres horas: eso si es inactividad. La 200 '
  + 'nunca se atendio, asi que sigue esperando a una persona'
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

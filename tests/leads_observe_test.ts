/**
 * El modo observación NO puede quemar el lead.
 *
 * EL FALLO, con nombre y hora. David activó el seguimiento en Ajustes, dejó dos
 * conversaciones sin agendar a propósito para probarlo, y el mensaje nunca llegó. Lo
 * que había pasado es peor que un mensaje perdido:
 *
 *   conv 73  lead_followup_at = 2026-08-20 12:09:03.99+00
 *   conv 81  lead_followup_at = 2026-08-20 12:09:03.99+00
 *   conv 75  lead_followup_at = 2026-08-20 12:09:03.99+00
 *
 * El mismo timestamp al centisegundo: el barrido las procesó a la vez. Pero
 * `lead_followup_at` se escribía ANTES de comprobar el modo de la clínica y sin
 * condición, y el modo guardado era NULL, que cae a 'observe'. Así que se marcaron
 * como «seguimiento hecho» sin haber escrito a nadie — y como el barrido filtra por
 * `lead_followup_at IS NULL`, esas conversaciones no se vuelven a mirar NUNCA.
 *
 * El modo observación existe para «decidir y anotar sin tocar a ningún paciente».
 * Tocaba sus datos de la única forma que importa: consumía el lead sin entregarlo. Y
 * el día que se enciende el modo, los leads observados ya están gastados.
 *
 * ESTA PRUEBA NO EXISTIA porque no había NINGUNA del servicio de leads: solo de la
 * política pura, que es precisamente la parte que estaba bien.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' }
});
process.env.CHATWOOT_BASE_URL = 'http://127.0.0.1:1';
process.env.CHATWOOT_API_ACCESS_TOKEN = 'fake';

const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const settings = await import('../src/tenants/settings.js');
const { procesarLead } = await import('../src/leads/service.js');
const chatwoot = await import('../src/chatwoot/client.js');

/** Abierta todos los días, para que la ventana no dependa del día de la semana. */
const ABIERTA = {
  sun: [['00:00', '23:59']], mon: [['00:00', '23:59']], tue: [['00:00', '23:59']],
  wed: [['00:00', '23:59']], thu: [['00:00', '23:59']], fri: [['00:00', '23:59']],
  sat: [['00:00', '23:59']]
};

// RELOJ FIJO, y por eso se exportó procesarLead. Miércoles 26-ago-2026, 10:00 en
// Caracas. El interés fue 20 horas antes -martes a las 14:00-, así que la ventana está
// abierta: el mínimo son 12 horas, el máximo 23, tiene que caer en otro día local, y
// las 08:00 del miércoles es el primer instante que cumple las tres cosas. A las 10:00
// ya ha pasado y aún queda plazo.
const AHORA = new Date('2026-08-26T14:00:00Z');
const INTERES = new Date('2026-08-25T18:00:00Z');

function montar(modo: string | null) {
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  db.seed('helios_tenants', [{
    tenant_id: 'democoi1',
    ...(modo === null ? {} : { leads_mode: modo }),
    clinic_hours: ABIERTA,
    clinic_timezone: 'America/Caracas',
    followup_window: { desde: '08:00', hasta: '22:00' }
  }]);
  db.seed('helios_conversation_state', [fila()]);
  db.seed('helios_lead_followups', []);
  db.seed('helios_gateway_logs', []);
  db.seed('helios_patient_profiles', []);
  __setSupabaseClientForTests(db as any);
  settings.__limpiarCacheAjustes();
  return db;
}

function fila() {
  return {
    tenant_id: 'democoi1', conversation_id: '73', contact_id: 'c1',
    lead_interest: 'appointment', lead_interest_at: INTERES.toISOString(),
    lead_followup_at: null, lead_simulado_at: null, lead_blocked_reason: null,
    stage: 'bot_active'
  };
}

const estado = (db: any) =>
  (db.table('helios_conversation_state') as any[]).find(f => f.conversation_id === '73');

let enviados: string[] = [];
(chatwoot as any).chatwootClient.sendMessage = async (_cuenta: any, conv: any, texto: string) => {
  enviados.push(String(conv) + '|' + texto);
  return { data: { id: 999 } };
};

// --- CONTROL: con el modo en 'on' SI se envía y SI se marca -----------------
//
// Va primero a propósito. Si esto fallara significaría que la ventana no estaba
// abierta, y entonces la prueba de observación de abajo no estaría probando nada:
// pasaría porque no llega al código, no porque el código sea correcto.

{
  const db = montar('on');
  enviados = [];
  await procesarLead(fila(), AHORA);

  assert.equal(
    enviados.length, 1,
    'CONTROL: con el modo en «on» tiene que enviarse. Si no, la ventana no estaba abierta '
    + 'y la prueba de observación no vale para nada'
  );
  assert.ok(estado(db).lead_followup_at, 'al enviar de verdad SÍ se marca lead_followup_at');
}

// --- EL FALLO: en observación NO se puede marcar ----------------------------

{
  const db = montar('observe');
  enviados = [];
  await procesarLead(fila(), AHORA);

  assert.equal(enviados.length, 0, 'en observación no se escribe a ningún paciente');
  assert.equal(
    estado(db).lead_followup_at, null,
    'EL FALLO: en observación NO puede marcarse lead_followup_at. Si se marca, el barrido '
    + 'filtra por ese campo y esa conversación no se vuelve a mirar nunca: el lead queda '
    + 'quemado y al encender el modo no recibirá nada'
  );
  assert.ok(estado(db).lead_simulado_at, 'pero sí queda constancia de que se observó');
}

// --- Y SIN MODO GUARDADO, que es el caso real que falló --------------------
//
// leads_mode estaba en NULL en helios_tenants, así que caía al valor por defecto, que
// con HELIOS_LEADS_ENABLED apagado es 'observe'. David creía tenerlo activado.

{
  const db = montar(null);
  enviados = [];
  await procesarLead(fila(), AHORA);

  assert.equal(enviados.length, 0, 'sin modo guardado no se escribe a nadie');
  assert.equal(
    estado(db).lead_followup_at, null,
    'sin modo guardado tampoco puede quemarse el lead: es EXACTAMENTE lo que les pasó a '
    + 'las conversaciones 73, 81 y 75 el 20 de agosto'
  );
}

// --- La observación no se repite en cada barrido ---------------------------
//
// Sin esto, la misma conversación generaría una fila de registro cada diez minutos
// durante días, y un log lleno de ruido es un log que nadie lee.

{
  const db = montar('observe');
  await procesarLead(fila(), AHORA);
  const yaObservada = { ...fila(), lead_simulado_at: estado(db).lead_simulado_at };
  const antes = (db.table('helios_lead_followups') as any[]).length;
  await procesarLead(yaObservada, AHORA);
  assert.equal(
    (db.table('helios_lead_followups') as any[]).length, antes,
    'una conversación ya observada no se vuelve a anotar'
  );
}

console.log('leads_observe_test: OK');

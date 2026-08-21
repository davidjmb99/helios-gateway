/**
 * ¿Vuelve a haber seguimiento cuando el paciente vuelve semanas después?
 *
 * LA PREGUNTA QUE LO ORIGINA, de David: «tampoco puede ser nunca, porque ¿qué tal si a
 * la semana vuelve a escribir y deja algo a medias? ¿No se le hace el seguimiento?».
 *
 * No se le hacía. El 19 de agosto de 2026, SIETE conversaciones —71, 72, 74, 76, 77,
 * 78 y 80— quedaron con `lead_blocked_reason = 'booked'`, y el barrido filtra por ese
 * campo en NULL. Reservaron una cita en agosto y con eso quedaban excluidas de
 * cualquier seguimiento PARA SIEMPRE. En septiembre preguntan por un tratamiento, lo
 * dejan a medias, y no pasa nada.
 *
 * Lo que se protege, por orden de daño si falla:
 *  1. QUE `opted_out` NO SE LEVANTE JAMAS. Es lo único de esta lista que además es un
 *     asunto legal: alguien pidió que no se le escriba.
 *  2. Que `not_interested` y `complaint` tampoco. Una pregunta nueva no borra un no ni
 *     un enfado, y equivocarse hacia «no le escribo» es recuperable.
 *  3. Que `booked`, `human_handoff` y `technical_failure` SÍ se levanten: describen una
 *     situación que ya pasó, no la voluntad de nadie.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';

const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const { markLeadInterest } = await import('../src/leads/service.js');
const politica = await import('../src/leads/policy.js');

/** El turno que revela interés: Helios consultó disponibilidad y no se cerró nada. */
const CONSULTO_DISPONIBILIDAD = { type: 'availability_checked', status: 'success' };

function montar(motivoPrevio: string | null) {
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  db.seed('helios_conversation_state', [{
    tenant_id: 'democoi1', conversation_id: '77', contact_id: 'c1',
    // Reservó hace semanas y desde entonces está bloqueada.
    lead_interest: 'appointment',
    lead_interest_at: '2026-08-19T18:12:22Z',
    lead_followup_at: '2026-08-20T12:09:03Z',
    lead_simulado_at: '2026-08-20T12:09:03Z',
    lead_blocked_reason: motivoPrevio,
    stage: 'bot_active'
  }]);
  db.seed('helios_gateway_logs', []);
  __setSupabaseClientForTests(db as any);
  return db;
}

const fila = (db: any) =>
  (db.table('helios_conversation_state') as any[]).find(f => f.conversation_id === '77');

// --- La lista de motivos está partida como debe ------------------------------

{
  for (const motivo of ['booked', 'human_handoff', 'technical_failure']) {
    assert.equal(politica.unInteresNuevoLevanta(motivo), true, `${motivo} tiene que levantarse`);
  }
  for (const motivo of ['opted_out', 'not_interested', 'complaint']) {
    assert.equal(
      politica.unInteresNuevoLevanta(motivo), false,
      `${motivo} NO puede levantarse: es de la voluntad del paciente, no de la situación`
    );
  }
  assert.equal(politica.unInteresNuevoLevanta('inventado'), false);
  assert.equal(politica.unInteresNuevoLevanta(null), false);
}

// --- EL CASO DE DAVID: reservó en agosto, vuelve y deja algo a medias -------

{
  const db = montar('booked');
  await markLeadInterest({
    tenantId: 'democoi1', conversationId: '77', contactId: 'c1',
    traceId: 't1', operation: CONSULTO_DISPONIBILIDAD
  });

  const f = fila(db);
  assert.equal(
    f.lead_blocked_reason, null,
    'EL CASO DE DAVID: reservó en agosto y volvió semanas después dejando algo a medias. '
    + 'Si «booked» no se levanta, queda excluido de cualquier seguimiento de por vida'
  );
  assert.equal(f.lead_followup_at, null, 'y el seguimiento anterior no puede bloquear al nuevo');
  assert.equal(
    f.lead_simulado_at, null,
    'ni la observación anterior: esta es OTRA consulta y merece su propia decisión'
  );
  assert.equal(f.lead_interest, 'appointment');
  assert.notEqual(f.lead_interest_at, '2026-08-19T18:12:22Z', 'el reloj se reinicia con el interés nuevo');
}

{
  // Un handoff que terminó hace días no puede bloquear para siempre.
  const db = montar('human_handoff');
  await markLeadInterest({
    tenantId: 'democoi1', conversationId: '77', contactId: 'c1',
    traceId: 't2', operation: CONSULTO_DISPONIBILIDAD
  });
  assert.equal(fila(db).lead_blocked_reason, null, 'un handoff pasado no bloquea de por vida');
}

{
  // Un turno que falló técnicamente no es una decisión de nadie.
  const db = montar('technical_failure');
  await markLeadInterest({
    tenantId: 'democoi1', conversationId: '77', contactId: 'c1',
    traceId: 't3', operation: CONSULTO_DISPONIBILIDAD
  });
  assert.equal(fila(db).lead_blocked_reason, null, 'un fallo técnico de un turno no bloquea de por vida');
}

// --- LO QUE NO SE LEVANTA NI CON UN INTERES NUEVO --------------------------

{
  // ESTE ES EL QUE MAS IMPORTA. Pidió que no se le escriba.
  const db = montar('opted_out');
  await markLeadInterest({
    tenantId: 'democoi1', conversationId: '77', contactId: 'c1',
    traceId: 't4', operation: CONSULTO_DISPONIBILIDAD
  });
  assert.equal(
    fila(db).lead_blocked_reason, 'opted_out',
    'opted_out NO se levanta nunca: el paciente pidió que no se le escriba, y una consulta '
    + 'nueva no es permiso para venderle'
  );
}

{
  const db = montar('not_interested');
  await markLeadInterest({
    tenantId: 'democoi1', conversationId: '77', contactId: 'c1',
    traceId: 't5', operation: CONSULTO_DISPONIBILIDAD
  });
  assert.equal(fila(db).lead_blocked_reason, 'not_interested', 'un «no» no lo borra una pregunta');
}

{
  const db = montar('complaint');
  await markLeadInterest({
    tenantId: 'democoi1', conversationId: '77', contactId: 'c1',
    traceId: 't6', operation: CONSULTO_DISPONIBILIDAD
  });
  assert.equal(fila(db).lead_blocked_reason, 'complaint', 'a quien acabó enfadado no se le vende');
}

// --- Una operación que no revela interés no toca nada ----------------------

{
  const db = montar('booked');
  await markLeadInterest({
    tenantId: 'democoi1', conversationId: '77', contactId: 'c1',
    traceId: 't7',
    // Pedir los datos del paciente no es interés en una cita sin cerrar.
    operation: { type: 'identity_requested', status: 'success' }
  });
  assert.equal(
    fila(db).lead_blocked_reason, 'booked',
    'sin interés nuevo no se levanta nada: el desbloqueo va DENTRO de haber detectado interés'
  );
}

console.log('leads_desbloqueo_test: OK');

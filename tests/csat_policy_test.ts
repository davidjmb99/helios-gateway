/**
 * Política de la encuesta de satisfacción.
 *
 * Lo que se protege aquí no es un detalle de formato: es que no se le mande una
 * encuesta de «¿qué tal el servicio?» a un paciente que acaba de quejarse.
 */

import assert from 'node:assert/strict';

const {
  decideOnResolution,
  isEligibleOperation,
  mergeExclusionReason,
  isCsatExclusionReason,
  CSAT_EXCLUSION_REASONS
} = await import('../src/csat/policy.js');

// --- Qué vuelve encuestable una conversación --------------------------------

assert.equal(
  isEligibleOperation({ type: 'appointment_created', status: 'success' }),
  true,
  'una cita agendada con éxito es servicio prestado'
);
assert.equal(
  isEligibleOperation({ type: 'appointment_rescheduled', status: 'success' }),
  true,
  'reprogramar también cuenta'
);
assert.equal(
  isEligibleOperation({ type: 'APPOINTMENT_CREATED', status: 'SUCCESS' }),
  true,
  'sin distinguir mayúsculas'
);

// El status importa tanto como el tipo: encuestar por una cita que en realidad
// no se creó es peor que no encuestar.
assert.equal(isEligibleOperation({ type: 'appointment_created', status: 'pending' }), false);
assert.equal(isEligibleOperation({ type: 'appointment_created', status: 'failed' }), false);
assert.equal(isEligibleOperation({ type: 'appointment_created' }), false, 'sin status no se asume éxito');

// Nada más vuelve encuestable una conversación.
assert.equal(isEligibleOperation({ type: 'availability_checked', status: 'success' }), false);
assert.equal(isEligibleOperation({ type: 'identity_requested', status: 'success' }), false);
assert.equal(isEligibleOperation({ type: 'appointment_cancelled', status: 'success' }), false);
assert.equal(isEligibleOperation({ type: 'human_handoff', status: 'success' }), false);
assert.equal(isEligibleOperation(null), false);
assert.equal(isEligibleOperation(undefined), false);
assert.equal(isEligibleOperation({}), false);

// --- Gravedad de la exclusión ------------------------------------------------
// Se guarda el motivo MÁS específico, porque el recuento de exclusiones es la
// métrica de calidad que sustituye a la nota media de los casos malos.

assert.equal(mergeExclusionReason(null, 'human_handoff'), 'human_handoff', 'sin motivo previo, entra');
assert.equal(
  mergeExclusionReason('human_handoff', 'complaint'),
  'complaint',
  'una queja es más informativa que «hubo handoff»'
);
assert.equal(
  mergeExclusionReason('complaint', 'technical_failure'),
  'technical_failure',
  'el fallo técnico manda sobre todo lo demás'
);
assert.equal(
  mergeExclusionReason('complaint', 'human_handoff'),
  null,
  'NO se degrada un motivo específico a uno genérico'
);
assert.equal(
  mergeExclusionReason('technical_failure', 'complaint'),
  null,
  'ni se pierde el fallo técnico por una queja posterior'
);
assert.equal(
  mergeExclusionReason('complaint', 'complaint'),
  null,
  'el mismo motivo no gasta una escritura'
);
assert.equal(
  mergeExclusionReason('valor-corrupto-en-la-columna', 'human_handoff'),
  'human_handoff',
  'un valor que no reconocemos no bloquea la exclusión'
);

assert.equal(isCsatExclusionReason('complaint'), true);
assert.equal(isCsatExclusionReason('cualquier_cosa'), false);
assert.equal(isCsatExclusionReason(null), false);

// --- La decisión al resolver la conversación ---------------------------------

assert.deepEqual(
  decideOnResolution({ csat_eligible_at: '2026-08-12T10:00:00Z' }),
  { action: 'send', reason: 'eligible_and_clean' },
  'cita agendada y sin roces: se encuesta'
);

assert.deepEqual(
  decideOnResolution({}),
  { action: 'none', reason: 'not_eligible' },
  'sin cita no hay servicio que valorar'
);

// EL CASO QUE MOTIVA TODO ESTO. La exclusión gana aunque la cita se agendara
// antes: un paciente puede reservar y enfadarse después.
assert.deepEqual(
  decideOnResolution({
    csat_eligible_at: '2026-08-12T10:00:00Z',
    csat_excluded_reason: 'complaint'
  }),
  { action: 'exclude', reason: 'complaint' },
  'agendó y luego se quejó: NO se le pregunta qué tal el servicio'
);

for (const reason of CSAT_EXCLUSION_REASONS) {
  assert.deepEqual(
    decideOnResolution({ csat_eligible_at: '2026-08-12T10:00:00Z', csat_excluded_reason: reason }),
    { action: 'exclude', reason },
    `${reason} excluye incluso con cita agendada`
  );
}

// Una conversación se puede reabrir y volver a resolver. La encuesta va una vez.
assert.deepEqual(
  decideOnResolution({
    csat_eligible_at: '2026-08-12T10:00:00Z',
    csat_label_applied_at: '2026-08-12T11:00:00Z'
  }),
  { action: 'none', reason: 'already_applied' },
  'reabrir y volver a resolver no manda una segunda encuesta'
);
assert.deepEqual(
  decideOnResolution({
    csat_excluded_reason: 'complaint',
    csat_label_applied_at: '2026-08-12T11:00:00Z'
  }),
  { action: 'none', reason: 'already_applied' },
  'el sello de aplicado manda también sobre la exclusión'
);

// Las conversaciones anteriores a la migración tienen las tres columnas a NULL.
// El valor seguro es «no apta»: nunca una encuesta retroactiva.
assert.deepEqual(
  decideOnResolution({
    csat_eligible_at: null,
    csat_excluded_reason: null,
    csat_label_applied_at: null
  }),
  { action: 'none', reason: 'not_eligible' },
  'las conversaciones históricas no generan encuestas retroactivas'
);

console.log('csat_policy_test: PASS');

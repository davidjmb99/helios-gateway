/**
 * Seguimiento de leads.
 *
 * Lo que se protege aquí: que no se escriba a quien no toca, que no se escriba
 * dos veces, y sobre todo que no se escriba fuera del plazo de WhatsApp, que es
 * el fallo que no da error de programa sino que lo bloquea Meta.
 */

import assert from 'node:assert/strict';

const {
  detectLeadInterest,
  decidirSeguimiento,
  calcularMomentoDeEnvio,
  clinicaAbierta,
  momentoLocal,
  HORARIO_COI,
  VENTANA_POR_DEFECTO,
  LEAD_BLOCK_REASONS
} = await import('../src/leads/policy.js');
const { construirMensaje, pideQueNoLeEscriban } = await import('../src/leads/messages.js');

// Agosto: Madrid va en UTC+2.
const madrid = (dia: number, hora: number, minuto = 0) =>
  new Date(Date.UTC(2026, 7, dia, hora - 2, minuto));

// --- Quién es un lead --------------------------------------------------------

assert.equal(
  detectLeadInterest({ type: 'availability_checked', status: 'success' }),
  'appointment',
  'miró huecos y no reservó: es un lead'
);
assert.equal(
  detectLeadInterest({ type: 'appointment_cancelled', status: 'success' }),
  'cancelled',
  'canceló: se le puede ofrecer otra fecha'
);

// UN CLIENTE NO ES UN LEAD. Escribirle «¿te sigue interesando?» a quien ya tiene
// hora reservada no es insistente: es no habernos enterado.
assert.equal(
  detectLeadInterest({ type: 'appointment_created', status: 'success' }),
  null,
  'quien ya reservó NO recibe seguimiento'
);
assert.equal(
  detectLeadInterest({ type: 'appointment_rescheduled', status: 'success' }),
  null,
  'ni quien ya tiene su nueva fecha'
);
assert.equal(
  detectLeadInterest({ type: 'availability_checked', status: 'failed' }),
  null,
  'una operación fallida no demuestra interés'
);
assert.equal(detectLeadInterest(null), null);
assert.equal(detectLeadInterest({ type: 'identity_requested', status: 'success' }), null);

// --- El reloj de la clínica --------------------------------------------------

assert.equal(momentoLocal(madrid(10, 10, 30), 'Europe/Madrid').minuto, 10 * 60 + 30);
assert.equal(momentoLocal(madrid(10, 10), 'Europe/Madrid').dia, 1, '10 de agosto de 2026 es lunes');

assert.equal(clinicaAbierta(madrid(10, 12), 'Europe/Madrid', HORARIO_COI), true, 'lunes al mediodía');
assert.equal(clinicaAbierta(madrid(10, 9), 'Europe/Madrid', HORARIO_COI), false, 'antes de abrir');
assert.equal(clinicaAbierta(madrid(10, 20), 'Europe/Madrid', HORARIO_COI), false, 'a las 20:00 ya cerró');
assert.equal(clinicaAbierta(madrid(15, 14), 'Europe/Madrid', HORARIO_COI), true, 'sábado por la mañana');
assert.equal(clinicaAbierta(madrid(15, 16), 'Europe/Madrid', HORARIO_COI), false, 'sábado tarde, cerrado');
assert.equal(clinicaAbierta(madrid(16, 12), 'Europe/Madrid', HORARIO_COI), false, 'domingo, cerrado');
assert.equal(
  clinicaAbierta(madrid(11, 3), 'Europe/Madrid', HORARIO_COI),
  false,
  'a las 3 de la madrugada NO se escribe a nadie'
);

// --- El choque entre los dos relojes ----------------------------------------

// Consulta del lunes por la tarde: al día siguiente, dentro de horario y de plazo.
const tarde = calcularMomentoDeEnvio(madrid(10, 17), VENTANA_POR_DEFECTO);
assert.ok(tarde, 'una consulta de la tarde sí tiene hueco de respuesta');
assert.equal(
  clinicaAbierta(tarde as Date, 'Europe/Madrid', HORARIO_COI),
  true,
  'y cae en horario de clínica'
);
const horasDespues = ((tarde as Date).getTime() - madrid(10, 17).getTime()) / 3600_000;
assert.ok(horasDespues >= 12 && horasDespues <= 23, `dentro de la ventana (fueron ${horasDespues} h)`);

// EL CASO QUE OBLIGA A RENUNCIAR. Una consulta de las nueve de la mañana tiene su
// plazo a las nueve de la mañana siguiente, cuando la clínica lleva cerrada desde
// las 20:00 y aún no ha abierto. No hay ningún momento válido.
const manana = calcularMomentoDeEnvio(madrid(11, 9), VENTANA_POR_DEFECTO);
assert.equal(
  manana,
  null,
  'de madrugada o antes de abrir no se fuerza el envío: se renuncia'
);

// Sábado por la tarde: el plazo vence el domingo, que está cerrado todo el día.
assert.equal(
  calcularMomentoDeEnvio(madrid(15, 14), VENTANA_POR_DEFECTO),
  null,
  'el domingo cerrado deja sin seguimiento a los sábados por la tarde'
);

// --- La decisión completa ----------------------------------------------------

const leadListo = {
  lead_interest: 'appointment',
  lead_interest_at: madrid(10, 17).toISOString()
};

assert.equal(
  decidirSeguimiento(leadListo, madrid(10, 18)).action,
  'skip',
  'una hora después es demasiado pronto'
);
assert.equal(
  (decidirSeguimiento(leadListo, madrid(10, 18)) as any).reason,
  'too_soon'
);

const decision = decidirSeguimiento(leadListo, madrid(11, 12));
assert.equal(decision.action, 'send', 'al día siguiente en horario sí se escribe');
assert.equal((decision as any).interest, 'appointment');

// UN SOLO MENSAJE, NUNCA DOS.
assert.equal(
  decidirSeguimiento(
    { ...leadListo, lead_followup_at: madrid(11, 11).toISOString() },
    madrid(11, 12)
  ).action,
  'skip',
  'ya se le escribió: no se insiste'
);

// Todo lo que prohíbe escribir manda sobre el reloj.
for (const reason of LEAD_BLOCK_REASONS) {
  const salida = decidirSeguimiento({ ...leadListo, lead_blocked_reason: reason }, madrid(11, 12));
  assert.equal(salida.action, 'skip', `${reason} impide el seguimiento`);
  assert.equal((salida as any).reason, reason, 'y queda registrado POR QUÉ, para poder contarlo');
}

// Si la fila se atrasó y se pasó el plazo, ya no se puede escribir libre.
assert.equal(
  (decidirSeguimiento(leadListo, madrid(12, 12)) as any).reason,
  'no_window',
  'pasado el plazo de WhatsApp no se manda: haría falta plantilla de Meta'
);

assert.equal(decidirSeguimiento({}, madrid(11, 12)).action, 'skip', 'sin interés no hay nada que hacer');

// --- Los mensajes ------------------------------------------------------------

const textos = [
  construirMensaje('appointment', { nombre: 'David' }),
  construirMensaje('cancelled', { nombre: 'David', cuando: 'del jueves' }),
  construirMensaje('reschedule_pending', { nombre: 'David' }),
  construirMensaje('treatment', { nombre: 'David', tema: 'la ortodoncia' })
];

for (const texto of textos) {
  assert.match(texto, /^Hola David, /, 'todos saludan por el nombre');
  assert.equal(texto.includes('?'), true, 'todos acaban preguntando, sin empujar');
  // LA REGLA QUE MÁS IMPORTA: ni una palabra que cambie según el género. Fallar
  // aquí significa tratar a un paciente en el género que no es, con su nombre.
  assert.doesNotMatch(
    texto,
    /\b(interesad[oa]|dispuest[oa]|atendid[oa]|preocupad[oa]|seguro de|segura de)\b/i,
    `sin concordancia de género: ${texto}`
  );
  assert.ok(texto.length < 240, 'corto: es WhatsApp, no una carta');
}

assert.match(textos[3], /la ortodoncia/, 'menciona lo que preguntó de verdad');
assert.match(textos[1], /del jueves/, 'y cuándo era la cita que canceló');

// Sin nombre verificado el mensaje sigue siendo correcto.
assert.match(construirMensaje('appointment'), /^Hola, /);

// --- La salida fácil ---------------------------------------------------------

assert.equal(pideQueNoLeEscriban('no me interesa, gracias'), true);
assert.equal(pideQueNoLeEscriban('No quiero que me escribáis más'), true);
assert.equal(pideQueNoLeEscriban('dar de baja'), true);
assert.equal(pideQueNoLeEscriban('sí, me interesa'), false);
assert.equal(pideQueNoLeEscriban('quiero una cita'), false);
assert.equal(
  pideQueNoLeEscriban('no sé si el jueves me viene bien'),
  false,
  'dudar no es pedir que no le escriban'
);

console.log('leads_policy_test: PASS');

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
// La señal vive en el normalizador, junto a las otras que se sacan del texto del paciente.
const { detectSignals } = await import('../src/chatwoot/normalizer.js');

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
// ESCRIBIR NO ES ATENDER. La clínica abre a las 10:00, pero a las 8:00 ya es hora
// decente para mandar un mensaje. Las CITAS se siguen ofreciendo solo en horario
// de clínica, y de eso se encarga la disponibilidad de Cal.com.
assert.equal(clinicaAbierta(madrid(10, 8), 'Europe/Madrid', HORARIO_COI), true, 'a las 8:00 ya se puede escribir');
assert.equal(clinicaAbierta(madrid(10, 9), 'Europe/Madrid', HORARIO_COI), true, 'y a las 9:00 también');
assert.equal(clinicaAbierta(madrid(10, 7), 'Europe/Madrid', HORARIO_COI), false, 'a las 7:00 todavía no');
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

// LO QUE ARREGLA LA REGLA DE LAS 8:00. Una consulta de las nueve de la mañana
// vence a las nueve de la mañana siguiente. Con el horario de clínica no había ni
// un minuto válido y esa conversación se quedaba sin seguimiento; abriendo los
// mensajes a las 8:00, sí lo hay.
const manana = calcularMomentoDeEnvio(madrid(11, 9), VENTANA_POR_DEFECTO);
assert.ok(manana, 'una consulta de la mañana ya no se queda sin seguimiento');
assert.equal(
  momentoLocal(manana as Date, 'Europe/Madrid').minuto >= 8 * 60,
  true,
  'y el mensaje sale a partir de las 8:00, nunca de madrugada'
);
const horasManana = ((manana as Date).getTime() - madrid(11, 9).getTime()) / 3600_000;
assert.ok(horasManana <= 23, `y dentro del plazo de WhatsApp (${horasManana} h)`);

// SABADO POR LA TARDE: AHORA SI RECIBE SEGUIMIENTO, el domingo por la mañana.
//
// Esta asercion decia lo contrario hasta el 28-ago-2026, y daba por bueno un agujero: como
// escribir exigia que el dia fuera laborable, TODO LO QUE PASABA EN SABADO se quedaba sin
// seguimiento. El interes cumple las 12 horas ese mismo sabado -mismo dia, se salta-, el
// domingo entero quedaba descartado, y el plazo de 23 horas de WhatsApp vencia antes del
// lunes. Una sexta parte de la semana, y el sabado es dia fuerte en una clinica.
//
// La prueba estaba «bien»: describia el comportamiento real. Lo que estaba mal era el
// comportamiento, y escribirlo como si fuera lo esperado lo dejo ahi meses.
//
// David: «el bot si puede atender ese dia, por si alguien escribe, y hacer seguimiento
// tambien», con la condicion de que NO SE AGENDE en domingo -que lo garantiza el horario de
// cada doctor, y se comprueba en agenda_huecos_test-.
const elSabado = calcularMomentoDeEnvio(madrid(15, 14), VENTANA_POR_DEFECTO);
assert.ok(elSabado, 'un sabado por la tarde ya no se queda sin seguimiento');
const localSabado = momentoLocal(elSabado as Date, 'Europe/Madrid');
assert.equal(localSabado.dia, 0, 'le llega el domingo');
assert.ok(localSabado.minuto >= 8 * 60, 'y a partir de las 8:00, nunca de madrugada');
const horasSabado = ((elSabado as Date).getTime() - madrid(15, 14).getTime()) / 3600_000;
assert.ok(horasSabado <= 23, `dentro del plazo de WhatsApp (${horasSabado} h)`);

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


// --- PREGUNTAR UN PRECIO ES UN LEAD --------------------------------------
//
// Y hasta el 28-ago-2026 no lo era. El interes `treatment` estaba declarado arriba desde el
// principio -«pregunto por un tratamiento o un precio»- y NADA lo activaba. Una pieza a
// medio hacer, y justo la del caso mas comercial que hay.
//
// LO ENCONTRO DAVID PROBANDO: cancelo una cita y despues pregunto «¿Que precio tiene una
// limpieza?». Ese segundo mensaje no genero nada.

{
  const conPrecio = { asks_for_price: true };
  const sinNada = { asks_for_price: false };
  const nada = { type: 'none', status: 'not_started' };

  // Es lo que devuelve Hermes cuando solo contesta una duda: operacion `none`.
  assert.equal(detectLeadInterest(nada, conPrecio), 'treatment', 'preguntar un precio deja lead');
  assert.equal(detectLeadInterest(nada, sinNada), null, 'y saludar no deja nada');
  assert.equal(detectLeadInterest(nada, null), null, 'sin señales, como antes');
  assert.equal(detectLeadInterest(nada, undefined), null);

  // VA EL ULTIMO, porque es el mas debil. Quien pregunta el precio Y pide hora es un lead
  // de cita, no de precio: el seguimiento que se le escribe no dice lo mismo.
  assert.equal(
    detectLeadInterest({ type: 'availability_checked', status: 'success' }, conPrecio),
    'appointment',
    'si el turno dejo un interes de agenda, ese manda'
  );
  assert.equal(
    detectLeadInterest({ type: 'appointment_cancelled', status: 'success' }, conPrecio),
    'cancelled'
  );

  // Y UNA CITA CREADA SIGUE SIN DEJAR LEAD aunque haya preguntado el precio por el camino:
  // es un cliente, no un lead.
  assert.equal(
    detectLeadInterest({ type: 'appointment_created', status: 'success' }, conPrecio),
    null,
    'quien ya tiene cita no recibe un mensaje para venderle'
  );

  // UN TURNO QUE FALLO TAMPOCO, y esto importa mas de lo que parece: si Helios se cayo
  // mientras alguien preguntaba cuanto cuesta una limpieza, escribirle al dia siguiente
  // para venderle es lo ultimo que hay que hacer.
  assert.equal(
    detectLeadInterest({ type: 'none', status: 'failed' }, conPrecio),
    null,
    'un fallo tecnico no se convierte en oportunidad comercial'
  );
}

// --- Y QUE LA SEÑAL RECONOZCA UNA PREGUNTA DE PRECIO ---------------------

{
  const pregunta = (t: string) => detectSignals(t).asks_for_price;

  for (const si of [
    '¿Qué precio tiene una limpieza?',
    'cuanto cuesta una limpieza',
    '¿Cuánto cuesta sacarme una muela?',
    'cuánto vale un blanqueamiento',
    'cuanto sale la ortodoncia',
    'me pasas los precios?',
    'que tarifa tienen',
    'necesito un presupuesto',
    'cuál es el costo de un implante',
    'cuanto me sale la endodoncia'
  ]) {
    assert.equal(pregunta(si), true, `«${si}» pregunta un precio`);
  }

  // LO QUE NO. «Cuanto» suelto aparece en frases que no preguntan ningun precio, y «vale»
  // suelto es media conversacion en español. Mejor perder alguna pregunta que llamar lead
  // a un «vale, gracias».
  for (const no of [
    'hola buenos dias',
    'quiero una cita para mañana',
    'vale, gracias',
    'en cuanto pueda le escribo',
    'vengan cuanto antes',
    'me duele mucho la muela',
    'quiero hacerme una limpieza'
  ]) {
    assert.equal(pregunta(no), false, `«${no}» NO pregunta un precio`);
  }
}

console.log('leads_policy_test: PASS');

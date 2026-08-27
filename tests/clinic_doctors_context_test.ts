/**
 * Los doctores que le llegan a Helios en cada mensaje.
 *
 * ESTA PRUEBA EXISTE PARA IMPEDIR UNA COSA CONCRETA, y es lo contrario de lo que suele
 * comprobar una prueba: aquí lo importante NO es que el dato llegue, es que NO llegue el
 * horario de cada doctor.
 *
 * LO PIDIÓ DAVID ASÍ: «no quiero que le llegue una información a hermes de que ana y maría
 * trabajan horario corrido, pero ambas ya estén ocupadas, entonces hermes no consulte el
 * calendario y ofrezca horarios que ya están ocupados».
 *
 * Y tiene razón en el mecanismo, no solo en el riesgo. La forma de garantizar que Helios
 * siempre consulte la disponibilidad NO es una regla en el SOUL pidiéndoselo —una regla se
 * puede saltar, y las diez respuestas anteriores del historial pesan más que ella— sino
 * QUITARLE EL DATO CON EL QUE PODRÍA FINGIRLO. Sin horarios, para decir si alguien puede a
 * las dos no tiene más remedio que preguntar.
 *
 * Por eso el día que alguien añada `horario` aquí «porque hace falta», esta prueba se pone
 * roja y explica por qué no hace falta.
 */

import assert from 'node:assert/strict';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
const { doctoresDeTexto } = await import('../src/tenants/settings-schema.js');

/** La lista de COI, con la odontopediatra que solo viene cuatro días. */
const COI = `
Dra. Ana Martínez
  calendario: c-ana@group.calendar.google.com
  hace: valoración, higiene, blanqueamiento

Dra. Sofía Lemur
  calendario: c-sofia@group.calendar.google.com
  horario: L, J, V, S
  hace: valoración, odontopediatría

Dr. Roberto Vélez
  calendario: c-velez@group.calendar.google.com
  hace: valoración, cordal, endodoncia, urgencia*
`;

// --- LO QUE NO PUEDE VIAJAR ------------------------------------------------

{
  const d = doctoresDeTexto(COI);
  assert.equal(d.length, 3);

  const enviado = JSON.stringify(d);

  // 1. NINGÚN HORARIO. Ni el de Lemur, que es el único que tiene línea propia, ni el
  //    heredado de la clínica. Es lo único que le permitiría a Helios contestar «Ana
  //    trabaja hasta las 8, sí puede a las 2» sin haber preguntado a nadie.
  for (const doctor of d) {
    assert.equal((doctor as any).horario, undefined, 'el horario NO viaja');
  }
  assert.ok(!/horario/i.test(enviado), 'ni la palabra, en ninguna forma');
  assert.ok(!/\b(10:00|20:00|15:00)\b/.test(enviado), 'ni una hora suelta');
  assert.ok(!/\b(mon|tue|wed|thu|fri|sat|sun)\b/i.test(enviado), 'ni un día de la semana');

  // 2. NINGÚN ID DE CALENDARIO. Helios dice «Martínez» y el gateway resuelve cuál es. Un ID
  //    en el contexto es una cosa más que mantener sincronizada, y una cosa más que puede
  //    acabar escrita en un mensaje a un paciente.
  for (const doctor of d) {
    assert.equal((doctor as any).calendario, undefined);
  }
  assert.ok(!/group\.calendar\.google\.com/.test(enviado), 'ni un solo ID de calendario');
  assert.ok(!/@/.test(enviado), 'ni nada que se parezca a un correo');
}

// --- LO QUE SÍ TIENE QUE VIAJAR --------------------------------------------

{
  const d = doctoresDeTexto(COI);

  // EL NOMBRE COMPLETO Y EL APELLIDO SUELTO. El paciente dice «Ana» o dice «Martínez», y
  // para reconocer las dos formas hacen falta las dos.
  assert.equal(d[0].nombre, 'Dra. Ana Martínez');
  assert.equal(d[0].apellido, 'Martínez');
  assert.equal(d[2].apellido, 'Vélez');

  // QUÉ HACE CADA UNO, para poder contestar «las endodoncias las ve el Dr. Vélez» sin
  // consultar nada. Es información de la clínica y no cambia cada hora, así que no hay
  // ningún motivo para gastar una llamada al calendario en ella.
  assert.ok(d[2].hace.includes('endodoncia'));
  assert.ok(d[1].hace.includes('odontopediatría'));

  // CON SUS TILDES Y COMO LOS ESCRIBE LA CLÍNICA. Por dentro los servicios se aplanan para
  // emparejar -«odontopediatria» tiene que casar con «odontopediatría»-, pero esa forma
  // aplanada es para buscar, no para que Helios la diga en voz alta.
  assert.ok(
    d[1].hace.some(s => s.includes('í')),
    'los servicios viajan como los escribió la clínica, no aplanados'
  );

  // LA ESTRELLA DEL PREFERENTE NO VIAJA. Marca a quién se le ofrece antes, y de eso ya se
  // encarga el orden en que la herramienta devuelve los doctores. En el contexto solo sería
  // un carácter raro que Helios podría acabar escribiendo en un mensaje.
  assert.ok(d[2].hace.includes('urgencia'), 'el servicio sí');
  assert.ok(!d[2].hace.some(s => s.includes('*')), 'la estrella no');
}

// --- SIN DOCTORES, NADA ----------------------------------------------------

{
  // Una lista vacía en el contexto le diría a Helios «esta clínica no tiene doctores», que
  // es distinto de «todavía no me los han dicho». Por eso el orchestrator solo manda el
  // campo si hay alguno, y esto es lo que se lo permite comprobar.
  assert.deepEqual(doctoresDeTexto(null), []);
  assert.deepEqual(doctoresDeTexto(''), []);

  // Y UNA LISTA QUE NO SE ENTIENDE TAMPOCO VIAJA A MEDIAS. Es la misma regla que al
  // guardarla: media lista es peor que ninguna, porque la clínica cree que están los cuatro.
  assert.deepEqual(
    doctoresDeTexto('Dra. Ana\n  calendario: c1@g.com\n  horario: cuando pueda'),
    [],
    'si una línea no se entiende, no viaja ninguna'
  );
}

console.log('clinic_doctors_context_test: OK');

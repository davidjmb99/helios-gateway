/**
 * Qué huecos se ofrecen y con qué doctor.
 *
 * ES LA PIEZA QUE SUSTITUYE A CAL.COM TEAMS, así que hereda su responsabilidad: si esto se
 * equivoca, dos pacientes acaban en la misma silla a la misma hora, o alguien se presenta a
 * una cita que no existe.
 *
 * Lo que se protege, por orden de daño:
 *
 *  1. QUE NUNCA SE OFREZCA UN HUECO QUE NO SE PUEDE RESERVAR. Ni sobre algo ya ocupado, ni
 *     fuera del horario del doctor, ni comiéndose el margen entre citas. Ofrecer una hora
 *     que luego falla es peor que no ofrecerla: el paciente ya contaba con ella.
 *
 *  2. QUE VARIOS DOCTORES PUEDAN ATENDER A LA MISMA HORA. Es literalmente lo que David
 *     preguntó y lo que una sola cuenta de Cal.com no permite. Si esto falla, la agenda
 *     miente diciendo que no hay sitio cuando hay dos sillas libres.
 *
 *  3. QUE DOS CONSULTAS SEGUIDAS DEN LO MISMO. Sin eso, el paciente ve un doctor distinto
 *     cada vez que se refresca la lista.
 *
 *  4. Que un dato ilegible se trate como ocupado, no como libre.
 */

import assert from 'node:assert/strict';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
const { huecosDisponibles } = await import('../src/agenda/huecos.js');

const CARACAS = 'America/Caracas';

/** Una hora local de Caracas del martes 25 de agosto de 2026. Caracas es UTC-4 y sin cambio horario. */
const t = (hora: number, minuto = 0) => new Date(Date.UTC(2026, 7, 25, hora + 4, minuto));

const hhmm = (d: Date) =>
  new Intl.DateTimeFormat('es', { timeZone: CARACAS, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

const JORNADA = [{ desde: 10 * 60, hasta: 20 * 60 }];
const completo = { 0: [], 1: JORNADA, 2: JORNADA, 3: JORNADA, 4: JORNADA, 5: JORNADA, 6: [] } as any;

const doctor = (id: string, over: Record<string, any> = {}) => ({
  id, nombre: id.toUpperCase(), horario: completo, ocupado: [], ...over
});

const consulta = (over: Record<string, any> = {}) => huecosDisponibles({
  zona: CARACAS,
  desde: t(9), hasta: t(20), ahora: t(8),
  duracionMin: 60,
  doctores: [doctor('a')],
  ...over
} as any);

// --- 1. NUNCA UN HUECO QUE NO SE PUEDE RESERVAR ----------------------------

{
  // Lo que ya está ocupado no se ofrece.
  const r = consulta({
    doctores: [doctor('a', { ocupado: [{ desde: t(12), hasta: t(13) }] })],
    maximo: 20
  });
  const horas = r.map(h => hhmm(h.inicio));
  assert.ok(horas.includes('10:00'), 'las horas libres sí se ofrecen');
  assert.ok(
    !horas.includes('12:00'),
    'una hora ya ocupada NO se ofrece: seria mandar a dos pacientes a la misma silla'
  );
}

{
  // EL MARGEN CUENTA POR LOS DOS LADOS. Con una cita de 12 a 13 y 30 minutos de margen, ni
  // la de 11:00-12:00 ni la de 13:00-14:00 valen: se comerian el tiempo de limpiar la sala.
  const r = consulta({
    doctores: [doctor('a', { ocupado: [{ desde: t(12), hasta: t(13) }] })],
    margenMin: 30, maximo: 20
  });
  const horas = r.map(h => hhmm(h.inicio));
  assert.ok(!horas.includes('11:00'), 'el margen ANTES de una cita ocupada se respeta');
  assert.ok(!horas.includes('13:00'), 'y el margen DESPUES tambien');
  assert.ok(horas.includes('10:00'), 'pero lo que queda fuera del margen sigue libre');
}

{
  // Fuera del horario del doctor no se ofrece nada, aunque tenga el calendario vacío.
  const soloTardes = { 0: [], 1: [], 2: [{ desde: 15 * 60, hasta: 19 * 60 }], 3: [], 4: [], 5: [], 6: [] } as any;
  const r = consulta({ doctores: [doctor('a', { horario: soloTardes })], maximo: 20 });
  const horas = r.map(h => hhmm(h.inicio));
  assert.ok(!horas.includes('10:00'), 'no se ofrece fuera de su jornada');
  assert.ok(horas.includes('15:00'), 'y si dentro');
  assert.ok(
    !horas.includes('19:00'),
    'ni una cita que EMPIEZA dentro y acaba fuera: a las 19:00 termina a las 20:00 y el ' +
    'doctor cierra a las 19:00'
  );
}

{
  // UNA CITA TIENE QUE CABER EN UN SOLO TRAMO. Con jornada partida de 10 a 14 y de 16 a 20,
  // una cita de una hora a las 13:30 cruzaria la comida aunque las dos puntas parezcan
  // horario de trabajo.
  const partida = {
    0: [], 1: [], 2: [{ desde: 10 * 60, hasta: 14 * 60 }, { desde: 16 * 60, hasta: 20 * 60 }],
    3: [], 4: [], 5: [], 6: []
  } as any;
  const r = consulta({
    doctores: [doctor('a', { horario: partida })], pasoMin: 30, maximo: 40
  });
  const horas = r.map(h => hhmm(h.inicio));
  assert.ok(horas.includes('13:00'), '13:00 a 14:00 cabe entero en el tramo de mañana');
  assert.ok(!horas.includes('13:30'), 'pero 13:30 a 14:30 cruzaria la comida: no se ofrece');
  assert.ok(!horas.includes('14:00'), 'ni empezar en mitad del descanso');
  assert.ok(horas.includes('16:00'), 'y por la tarde se vuelve a abrir');
}

{
  // LA ANTELACION MINIMA manda sobre lo que pida el paciente. Y EL HUECO CAE EN HORA
  // REDONDA: sin alinear, esto ofrecia «las 12:05», que se lee como un error del sistema
  // aunque la hora sea correcta. Ninguna clinica cita a y cinco.
  const r = consulta({ ahora: t(10, 5), antelacionMin: 120, maximo: 20 });
  const primera = r[0] ? hhmm(r[0].inicio) : null;
  assert.equal(
    primera, '13:00',
    'desde las 10:05 con dos horas de antelacion: no antes de las 12:05, y redondeado ' +
    `hacia arriba a la hora en punto. Salio ${primera}`
  );

  // Con paso de media hora, las y media tambien valen.
  const cada30 = consulta({ ahora: t(10, 5), antelacionMin: 120, pasoMin: 30, maximo: 20 });
  assert.equal(hhmm(cada30[0].inicio), '12:30', 'con paso de 30, se alinea a la media');
}

// --- 2. VARIOS DOCTORES A LA MISMA HORA ------------------------------------
//
// ES LA PREGUNTA DE DAVID, literal: «tener varios doctores en una clinica trabajando, y
// puedan agendar en el mismo horario». Con una sola cuenta de Cal.com esto es imposible:
// una reserva en cualquier evento te marca ocupado en todos.

{
  // Dos doctores libres a las 10:00, y el primero se lleva la cita. El segundo SIGUE libre.
  const doctores = [doctor('a'), doctor('b')];
  const primera = huecosDisponibles({
    zona: CARACAS, desde: t(10), hasta: t(11), ahora: t(8), duracionMin: 60, doctores
  });
  assert.equal(primera.length, 1, 'a las 10:00 hay UN hueco de una hora');
  const elegido = primera[0].doctor_id;

  // Ahora ese doctor tiene la cita. El otro tiene que seguir pudiendo atender A LA MISMA HORA.
  const conUnaReserva = huecosDisponibles({
    zona: CARACAS, desde: t(10), hasta: t(11), ahora: t(8), duracionMin: 60,
    doctores: doctores.map(d =>
      d.id === elegido ? { ...d, ocupado: [{ desde: t(10), hasta: t(11) }] } : d
    )
  });
  assert.equal(
    conUnaReserva.length, 1,
    'con un doctor ya ocupado a esa hora, el OTRO sigue disponible: eso es exactamente lo ' +
    'que una sola cuenta de Cal.com no permite'
  );
  assert.notEqual(conUnaReserva[0].doctor_id, elegido, 'y es el otro doctor, no el ocupado');

  // Con los dos ocupados, no hay hueco. Y eso NO es un error: es que no hay sitio.
  const llenos = huecosDisponibles({
    zona: CARACAS, desde: t(10), hasta: t(11), ahora: t(8), duracionMin: 60,
    doctores: doctores.map(d => ({ ...d, ocupado: [{ desde: t(10), hasta: t(11) }] }))
  });
  assert.deepEqual(llenos, [], 'con todos ocupados no se inventa un hueco: se devuelve vacio');
}

{
  // EL REPARTO. Tres doctores libres y seis huecos: dos para cada uno, no seis para el
  // primero. Es el «load balancing» del round-robin.
  const r = consulta({
    doctores: [doctor('a'), doctor('b'), doctor('c')],
    desde: t(10), hasta: t(16), maximo: 6
  });
  assert.equal(r.length, 6);
  const porDoctor = new Map<string, number>();
  for (const h of r) porDoctor.set(h.doctor_id, (porDoctor.get(h.doctor_id) ?? 0) + 1);
  assert.equal(porDoctor.size, 3, 'los tres doctores entran en el reparto');
  for (const [id, n] of porDoctor) {
    assert.equal(n, 2, `${id} se lleva 2 de 6, no todos: el reparto equilibra la carga`);
  }
}

{
  // Y QUIEN YA VIENE CARGADO recibe menos, AUNQUE SU CARGA ESTE FUERA DE LA VENTANA que se
  // consulta. Este caso lo encontro la prueba: con la consulta puesta de 14:00 a 17:00, el
  // doctor que llevaba trabajando desde las 10:00 salia igual de descansado que el que
  // entraba a las 14:00, porque dentro de esa franja los dos tenian cero.
  //
  // Por eso la carga cuenta TODO lo que venga en `ocupado`, sin recortarlo a la ventana.
  const r = consulta({
    doctores: [
      doctor('a', { ocupado: [{ desde: t(10), hasta: t(14) }] }),
      doctor('b')
    ],
    desde: t(14), hasta: t(17), maximo: 3
  });
  assert.equal(r[0].doctor_id, 'b', 'el primer hueco es para quien viene menos cargado');
}

// --- 3. DOS CONSULTAS SEGUIDAS DAN LO MISMO --------------------------------

{
  const entrada = {
    doctores: [doctor('a'), doctor('b'), doctor('c')],
    desde: t(10), hasta: t(18), maximo: 8
  };
  const una = consulta(entrada);
  const otra = consulta(entrada);
  assert.deepEqual(
    una.map(h => [h.inicio.toISOString(), h.doctor_id]),
    otra.map(h => [h.inicio.toISOString(), h.doctor_id]),
    'el reparto es determinista: si no, el paciente ve un doctor distinto al refrescar'
  );
}

// --- 4. LO QUE NO SE ENTIENDE SE TRATA COMO OCUPADO ------------------------

{
  // Una franja con una fecha ilegible bloquea la hora en vez de dejarla pasar. El precio de
  // perder un hueco es una oportunidad; el de doblar una cita, dos pacientes en la silla.
  const r = consulta({
    doctores: [doctor('a', { ocupado: [{ desde: 'no soy una fecha' as any, hasta: t(11) }] })],
    desde: t(10), hasta: t(11), maximo: 5
  });
  assert.deepEqual(
    r, [],
    'una franja ilegible se trata como OCUPADO: ante la duda, no se ofrece'
  );
}

// --- LO QUE NO PUEDE REVENTAR ---------------------------------------------

{
  // Entradas imposibles devuelven una lista vacia, nunca una excepcion: un fallo aqui
  // dejaria al paciente sin respuesta en mitad de pedir una cita.
  assert.deepEqual(consulta({ doctores: [] }), [], 'sin doctores, sin huecos');
  assert.deepEqual(consulta({ duracionMin: 0 }), [], 'duracion cero');
  assert.deepEqual(consulta({ duracionMin: -30 }), [], 'duracion negativa');
  assert.deepEqual(consulta({ duracionMin: NaN as any }), [], 'duracion que no es un numero');
  assert.deepEqual(consulta({ desde: t(18), hasta: t(10) }), [], 'ventana del reves');
  assert.deepEqual(consulta({ hasta: 'ayer' as any }), [], 'una fecha que no se entiende');
  assert.deepEqual(
    consulta({ doctores: [doctor('a', { horario: null })] }), [],
    'un doctor sin horario no atiende: no se le inventa uno'
  );
  assert.deepEqual(
    consulta({ doctores: [doctor('a', { ocupado: null })] }).length > 0, true,
    'pero un doctor sin franjas ocupadas si atiende: null es «no tiene nada», no «esta roto»'
  );

  // Una ventana enorme no cuelga el proceso.
  const enorme = consulta({ desde: t(10), hasta: new Date(Date.UTC(2030, 0, 1)), maximo: 5 });
  assert.equal(enorme.length, 5, 'el tope de huecos corta antes de recorrer cuatro años');
}

// --- LOS HUECOS EMPIEZAN CUANDO ABRE LA CLINICA ---------------------------
//
// LO DESTAPO UNA PREGUNTA DE DAVID: «agendo una cita con Martinez a las 2 del sabado, y
// mañana otra persona pregunta por las 2 con Martinez, ¿que pasa?». Al ejecutar su caso
// salio bien -las 14:00 no se ofrecian- pero el primer hueco del dia era LAS 10:30, con la
// clinica abierta desde las 10:00.
//
// La causa: los huecos se alineaban a multiplos del paso desde MEDIANOCHE. Con paso de 45
// eso da 10:30; con 90, tambien. Se perdia el primer hueco del dia entero, todos los dias,
// y nadie lo habria notado hasta que una recepcionista preguntara por que nunca se llena
// la primera hora.

{
  // Paso de 90 minutos y apertura a las 10:00. Desde medianoche, 90 no cae en 10:00.
  const r = consulta({
    doctores: [doctor('a')], duracionMin: 60, margenMin: 30, desde: t(9), hasta: t(20), maximo: 10
  });
  const horas = r.map(h => hhmm(h.inicio));
  assert.equal(
    horas[0], '10:00',
    `el primer hueco es cuando ABRE la clinica, no cuando cuadra el paso desde medianoche. ` +
    `Salio ${horas[0]}`
  );
  assert.deepEqual(
    horas.slice(0, 4), ['10:00', '11:30', '13:00', '14:30'],
    'y a partir de ahi se cuenta desde la apertura: 10:00 + 90 minutos cada vez'
  );
}

{
  // EL PASO POR DEFECTO ES DURACION + MARGEN. Lo pidio David: «bajemos la duracion a 45
  // minutos, para que asi con los 15 minutos mas sean 1 hora». Lo que ocupa a un doctor no
  // son los 45 de la cita: son 45 mas los 15 de limpiar la sala y escribir la nota.
  const r = consulta({ duracionMin: 45, margenMin: 15, desde: t(9), hasta: t(15), maximo: 5 });
  assert.deepEqual(
    r.map(h => hhmm(h.inicio)), ['10:00', '11:00', '12:00', '13:00', '14:00'],
    'con 45 + 15 los huecos van cada hora en punto'
  );
  assert.deepEqual(
    r.map(h => hhmm(h.fin)), ['10:45', '11:45', '12:45', '13:45', '14:45'],
    'y cada cita dura 45: los 15 restantes son el margen, no cita'
  );

  // Si el paso fuera solo la duracion, saldrian pegados y el margen no separaria nada.
  const pegados = consulta({ duracionMin: 45, margenMin: 15, pasoMin: 45, desde: t(9), hasta: t(15), maximo: 3 });
  assert.deepEqual(
    pegados.map(h => hhmm(h.inicio)), ['10:00', '10:45', '11:30'],
    'con paso igual a la duracion los huecos van pegados: por eso NO es el defecto'
  );
}

{
  // EL CASO DE DAVID, ENTERO. Martinez trabaja los sabados de 10:00 a 15:00 y ya tiene una
  // cita de 14:00 a 15:00. Otro paciente pregunta por las 14:00.
  const sabado = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [{ desde: 10 * 60, hasta: 15 * 60 }] } as any;
  const sab = (h: number) => new Date(Date.UTC(2026, 7, 29, h + 4));   // sabado 29-ago-2026
  const viernes = new Date(Date.UTC(2026, 7, 28, 12));

  const soloElla = huecosDisponibles({
    zona: CARACAS, desde: sab(0), hasta: sab(23), ahora: viernes,
    duracionMin: 45, margenMin: 15,
    doctores: [{ id: 'martinez', nombre: 'Dra. Ana Martinez', horario: sabado, ocupado: [{ desde: sab(14), hasta: sab(15) }] }]
  });
  assert.deepEqual(
    soloElla.map(h => hhmm(h.inicio)), ['10:00', '11:00', '12:00', '13:00'],
    'con Martinez ocupada a las 14:00 se ofrece lo de antes, no esa hora'
  );

  // Y CON LOS CUATRO, esas 14:00 SI existen: las coge otro. Es exactamente lo que una
  // cuenta gratuita de Cal.com no permite, porque ahi una reserva te ocupa en todo.
  const conLosCuatro = huecosDisponibles({
    zona: CARACAS, desde: sab(13), hasta: sab(15), ahora: viernes,
    duracionMin: 45, margenMin: 15,
    doctores: ['martinez', 'ruiz', 'lemur', 'velez'].map((id, i) => ({
      id, nombre: id, horario: sabado,
      ocupado: i === 0 ? [{ desde: sab(14), hasta: sab(15) }] : []
    }))
  });
  const aLas14 = conLosCuatro.find(h => hhmm(h.inicio) === '14:00');
  assert.ok(aLas14, 'con cuatro doctores, las 14:00 del sabado SI estan disponibles');
  assert.notEqual(aLas14!.doctor_id, 'martinez', 'y con otro doctor, no con la que esta ocupada');
}

// --- LA PRIORIDAD MANDA SOBRE LA CARGA -------------------------------------
//
// LO PIDIO DAVID con la urgencia dental: «principalmente la ve Velez, pero si esta ocupado
// la puede tomar cualquier doctor».
//
// Es una PREFERENCIA, no una restriccion, y esa diferencia importa. Con una lista plana
// habria que elegir entre dos cosas malas: dejarle la urgencia solo a el -y perder la cita
// cuando este ocupado- o repartirla entre los cuatro por igual -y que una urgencia acabe
// con quien no es cirujano teniendo al cirujano libre-.

{
  const urgencia = (velezOcupado: boolean) => consulta({
    desde: t(10), hasta: t(13), duracionMin: 45, margenMin: 15, maximo: 3,
    doctores: [
      doctor('velez', { prioridad: 0, ocupado: velezOcupado ? [{ desde: t(10), hasta: t(12) }] : [] }),
      doctor('martinez', { prioridad: 1 }),
      doctor('ruiz', { prioridad: 1 })
    ]
  });

  // Con el preferente libre, se lo lleva TODO. Aunque venga mas cargado: para eso es el
  // preferente, y la carga no puede ganarle a «esto lo hace el cirujano».
  assert.deepEqual(
    urgencia(false).map(h => h.doctor_id), ['velez', 'velez', 'velez'],
    'con el preferente libre, la urgencia es suya'
  );

  // Y con el preferente ocupado, la cita NO SE PIERDE: la cogen los demas, y entre ellos se
  // reparte por carga como siempre.
  const sinVelez = urgencia(true).map(h => h.doctor_id);
  assert.ok(!sinVelez.includes('velez'), 'ocupado, no se le asigna nada');
  assert.equal(new Set(sinVelez).size, 2, 'y entre los otros dos se reparte, no se lo lleva uno');

  // SIN PRIORIDADES SE COMPORTA COMO ANTES. Quien no la declare va con 0, asi que todo lo
  // que ya funcionaba sigue igual.
  const sinPrioridad = consulta({
    desde: t(10), hasta: t(13), duracionMin: 45, margenMin: 15, maximo: 3,
    doctores: [doctor('a'), doctor('b'), doctor('c')]
  });
  assert.equal(
    new Set(sinPrioridad.map(h => h.doctor_id)).size, 3,
    'sin prioridades, reparto plano entre los tres'
  );
}

console.log('agenda_huecos_test: OK');

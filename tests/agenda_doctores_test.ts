/**
 * Los doctores, tal como los escribe quien da de alta una clínica.
 *
 * LA RESTRICCIÓN QUE MANDA AQUÍ LA PUSO DAVID: «que sea lo más sencillo y no meterme con
 * tanto código ni prompt». Así que este formato no se juzga solo por si funciona, sino por
 * si alguien lo puede rellenar sin ayuda. Cada atajo que se prueba aquí existe para quitar
 * trabajo a esa persona.
 *
 * Lo que se protege, por orden de daño:
 *
 *  1. QUE UNA LISTA A MEDIAS NO SE GUARDE. Si una línea no se entiende, no se guarda
 *     ninguna. Con la mitad guardada, la clínica cree que puso cuatro doctores y Helios
 *     sabe de dos, y nadie se entera hasta que un paciente pide cita con el que falta.
 *
 *  2. QUE DOS DOCTORES NO COMPARTAN CALENDARIO. Es un error de copiar y pegar un ID, y sin
 *     comprobarlo la agenda diría que hay dos sillas donde hay una.
 *
 *  3. QUE EL `*` ABRA EL SERVICIO Y LA AUSENCIA DE `*` LO CIERRE. Es la diferencia entre
 *     «la urgencia la ve Vélez pero si está ocupado cualquiera» y «los brackets solo el
 *     ortodoncista». Confundirlas manda una urgencia a quien no es cirujano, o pierde la
 *     cita teniendo a alguien libre.
 *
 *  4. Que un día que la clínica cierra no se invente para nadie.
 */

import assert from 'node:assert/strict';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
const { leerDoctores, doctoresPara, horarioDeDoctor } = await import('../src/agenda/doctores.js');

const JORNADA = [{ desde: 10 * 60, hasta: 20 * 60 }];
const SABADO = [{ desde: 10 * 60, hasta: 15 * 60 }];
/** El horario de COI: lunes a viernes de 10 a 20, sábados de 10 a 15, domingos cerrado. */
const CLINICA = { 0: [], 1: JORNADA, 2: JORNADA, 3: JORNADA, 4: JORNADA, 5: JORNADA, 6: SABADO } as any;

const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const diasDe = (h: any) => [0, 1, 2, 3, 4, 5, 6].filter(i => h[i].length > 0).map(i => DIAS[i]).join('');

/** La lista de COI de verdad, que es el caso que hay que hacer fácil. */
const COI = `
Dra. Ana Martínez
  calendario: c-ana@group.calendar.google.com
  hace: valoración, higiene, blanqueamiento, empaste, reconstrucción, exodoncia

Dr. Carlos Ruiz
  calendario: c-carlos@group.calendar.google.com
  hace: valoración, exodoncia, estudio de ortodoncia, brackets, invisalign

Dra. Sofía Lemur
  calendario: c-sofia@group.calendar.google.com
  horario: L, J, V, S
  hace: valoración, exodoncia, odontopediatría

Dr. Roberto Vélez
  calendario: c-roberto@group.calendar.google.com
  hace: valoración, exodoncia, cordal, implante, endodoncia, urgencia*
`;

// --- EL CASO DE COI, ENTERO ------------------------------------------------

{
  const d = leerDoctores(COI, CLINICA);
  assert.ok(d, 'la lista de COI se entiende tal como se escribiria a mano');
  assert.equal(d!.length, 4);

  // SIN LINEA DE HORARIO, EL DE LA CLINICA. Es el atajo que mas trabajo quita: lo normal es
  // que todos hagan el horario de la clinica, y escribirlo cuatro veces son cuatro sitios
  // donde equivocarse el dia que cambie.
  assert.equal(diasDe(d![0].horario), 'LMXJVS', 'Martinez hereda el horario de la clinica');
  assert.deepEqual(d![0].horario[6], SABADO, 'incluido el sabado, con su horario corto');
  assert.deepEqual(d![0].horario[0], [], 'y el domingo cerrado');

  // Y CON LINEA DE DIAS, esos dias PERO CON EL HORARIO DE LA CLINICA. Es el caso de la
  // odontopediatra: no viene todos los dias, pero cuando viene hace el horario normal.
  assert.equal(diasDe(d![2].horario), 'LJVS', 'Lemur trabaja lunes, jueves, viernes y sabado');
  assert.deepEqual(d![2].horario[1], JORNADA, 'y su lunes es el horario de la clinica');
  assert.deepEqual(d![2].horario[6], SABADO, 'y su sabado, el sabado de la clinica');
  assert.deepEqual(d![2].horario[2], [], 'el martes no viene');

  // EL APELLIDO SE SEPARA para poder reconocer al paciente que dice solo «Velez», que es lo
  // normal. Y se quita el tratamiento: «Dra.» no es parte del nombre.
  assert.deepEqual(d!.map(x => x.apellido), ['Martínez', 'Ruiz', 'Lemur', 'Vélez']);
}

// --- 3. EL `*` ABRE, SU AUSENCIA CIERRA ------------------------------------

{
  const d = leerDoctores(COI, CLINICA)!;
  const apellidos = (servicio: string) =>
    doctoresPara(d, servicio).map(x => `${x.apellido}(${x.prioridad})`);

  // LA URGENCIA: Velez primero, y los demas DETRAS, no fuera. Lo pidio David asi:
  // «principalmente la ve Velez, pero si esta ocupado la puede tomar cualquier doctor».
  const urgencia = apellidos('urgencia');
  assert.equal(urgencia[0], 'Vélez(0)', 'el preferente va primero');
  assert.equal(urgencia.length, 4, 'y los otros tres SIGUEN pudiendo: si no, se pierde la cita');
  assert.ok(
    urgencia.slice(1).every(x => x.endsWith('(2)')),
    'pero por detras, para que solo la cojan si el cirujano esta ocupado'
  );

  // LOS BRACKETS, SIN ESTRELLA: solo el ortodoncista, aunque los demas esten libres. Es una
  // decision clinica de la clinica, no una cuestion de disponibilidad.
  assert.deepEqual(apellidos('brackets'), ['Ruiz(1)'], 'sin estrella, no se abre a nadie mas');
  assert.deepEqual(apellidos('odontopediatría'), ['Lemur(1)']);
  assert.deepEqual(apellidos('cordal'), ['Vélez(1)'], 'la cirugia es suya y de nadie mas');

  // LA VALORACION la declaran los cuatro, asi que la hacen los cuatro, y en igualdad: ahi
  // el reparto por carga es el que decide.
  const valoracion = doctoresPara(d, 'valoración');
  assert.equal(valoracion.length, 4);
  assert.equal(new Set(valoracion.map(x => x.prioridad)).size, 1, 'los cuatro en igualdad');

  // SI NADIE DECLARA UN SERVICIO, LO HACEN TODOS. Una clinica a medio rellenar sigue
  // pudiendo dar citas en vez de quedarse sin agenda por un dato que falta.
  assert.equal(
    doctoresPara(d, 'un servicio que nadie ha puesto').length, 4,
    'lo que nadie declara lo puede hacer cualquiera: mejor eso que no dar cita'
  );
}

// --- 1 y 2. LO QUE NO SE GUARDA --------------------------------------------

{
  // UNA LINEA ILEGIBLE TIRA LA LISTA ENTERA.
  assert.equal(
    leerDoctores('Dra. Ana\n  calendario: c1@g.com\n  horario: los martes por la tarde quizas', CLINICA),
    null,
    'un horario que no se entiende NO se guarda a medias'
  );

  // UN DOCTOR SIN CALENDARIO no sirve: no se le puede consultar la agenda ni crear la cita.
  assert.equal(
    leerDoctores('Dra. Ana Martínez\n  hace: valoración', CLINICA), null,
    'sin calendario no hay doctor'
  );

  // 2. DOS CALENDARIOS IGUALES. Es un error de copiar y pegar, y sin esto la agenda diria
  // que hay dos sillas donde hay una: las citas de uno bloquearian al otro.
  assert.equal(
    leerDoctores(
      'Dra. Ana\n  calendario: mismo@g.com\nDr. Carlos\n  calendario: mismo@g.com', CLINICA
    ),
    null,
    'dos doctores no pueden compartir calendario'
  );

  // Un campo suelto sin doctor delante.
  assert.equal(leerDoctores('  calendario: c1@g.com', CLINICA), null);

  // Vacio, basura y topes.
  assert.equal(leerDoctores('', CLINICA), null);
  assert.equal(leerDoctores('   \n  \n', CLINICA), null);
  assert.equal(leerDoctores(null, CLINICA), null);
  const demasiados = Array.from({ length: 21 }, (_, i) => `Dr ${i}\n  calendario: c${i}@g.com`).join('\n');
  assert.equal(leerDoctores(demasiados, CLINICA), null, 'mas de 20 doctores no se guarda');
}

// --- 4. UN DIA QUE LA CLINICA CIERRA NO SE INVENTA -------------------------

{
  // La clinica cierra los domingos. Si alguien escribe «D» en el horario de un doctor, ese
  // dia se queda vacio en vez de sacarse un horario de la manga: el doctor no puede atender
  // con la clinica cerrada, y ofrecer una cita ahi es mandar al paciente a una puerta
  // cerrada.
  const soloDomingo = horarioDeDoctor('D', CLINICA);
  assert.equal(soloDomingo, null, 'un doctor que solo trabajara el domingo no tiene horario');

  const conDomingo = horarioDeDoctor('L, D', CLINICA);
  assert.ok(conDomingo);
  assert.deepEqual(conDomingo![0], [], 'el domingo se queda vacio');
  assert.deepEqual(conDomingo![1], JORNADA, 'y el lunes si');
}

// --- LAS FORMAS DE ESCRIBIR UN HORARIO -------------------------------------
//
// Se admiten varias porque quien rellena esto no tiene por que saber que miercoles es «X»,
// y descubrirlo despues de guardar mal el horario de un doctor es una semana de citas en el
// dia equivocado.

{
  const casos: Array<[string, string]> = [
    ['L, J, V, S', 'LJVS'],
    ['l, j, v, s', 'LJVS'],
    ['lunes, jueves, viernes, sabado', 'LJVS'],
    ['lunes, jueves, viernes, sábado', 'LJVS'],
    ['L-V', 'LMXJV'],
    ['M-J', 'MXJ'],
    ['X', 'X']
  ];
  for (const [escrito, esperado] of casos) {
    const h = horarioDeDoctor(escrito, CLINICA);
    assert.ok(h, `«${escrito}» tiene que entenderse`);
    assert.equal(diasDe(h!), esperado, `«${escrito}»`);
  }

  // Y UN HORARIO PROPIO DE VERDAD, cuando el doctor no hace el de la clinica.
  const propio = horarioDeDoctor('L-V 10:00-18:00, S 10:00-14:00', CLINICA);
  assert.ok(propio);
  assert.deepEqual(propio![1], [{ desde: 600, hasta: 1080 }], 'sus horas, no las de la clinica');
  assert.deepEqual(propio![6], [{ desde: 600, hasta: 840 }]);

  // Jornada partida: dos tramos el mismo dia.
  const partida = horarioDeDoctor('L 10:00-14:00, L 16:00-20:00', CLINICA);
  assert.ok(partida);
  assert.equal(partida![1].length, 2, 'dos tramos el mismo dia');

  // Lo que NO se entiende devuelve null en vez de adivinar.
  for (const malo of ['', 'cuando pueda', 'Z', 'L 25:00-30:00', 'L 18:00-10:00', 'L-Z']) {
    assert.equal(horarioDeDoctor(malo, CLINICA), null, `«${malo}» no se puede adivinar`);
  }
}

console.log('agenda_doctores_test: OK');

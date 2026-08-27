/**
 * Reconocer al doctor por como lo nombra el paciente.
 *
 * LO PIDIÓ DAVID ASÍ: «debe entender cuando le nombren solo Ana por ejemplo, o digan solo
 * el apellido… y si hay mas doctores con el mismo nombre, debe preguntar por el apellido».
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE «MAÑANA» NO PIDA CITA CON LA DRA. ANA. La palabra «mañana» contiene «ana», así
 *     que con búsqueda por subcadena la forma más normal de pedir hora en español acaba
 *     eligiendo doctora. No es un caso rebuscado: es el caso normal.
 *
 *  2. QUE CON DOS ANAS NO SE ELIJA UNA. Adivinar manda al paciente con la que no era, y eso
 *     no se descubre hasta que llega a la clínica. Se pregunta el apellido.
 *
 *  3. Que «Vélez» y «Velez» sean la misma persona, porque nadie escribe tildes en WhatsApp.
 *
 *  4. Que el tratamiento no cuente: «con la doctora, por favor» no nombra a nadie.
 */

import assert from 'node:assert/strict';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
const { doctorPorNombre, preguntaDeApellido } = await import('../src/agenda/nombres.js');
const { leerDoctores } = await import('../src/agenda/doctores.js');

const JORNADA = [{ desde: 600, hasta: 1200 }];
const CLINICA = { 0: [], 1: JORNADA, 2: JORNADA, 3: JORNADA, 4: JORNADA, 5: JORNADA, 6: JORNADA } as any;

const COI = leerDoctores(`
Dra. Ana Martínez
  calendario: c-ana@g.com
  hace: valoración

Dr. Carlos Ruiz
  calendario: c-carlos@g.com
  hace: brackets

Dra. Sofía Lemur
  calendario: c-sofia@g.com
  hace: odontopediatría

Dr. Roberto Vélez
  calendario: c-roberto@g.com
  hace: cordal
`, CLINICA)!;

const quien = (texto: string) => {
  const r = doctorPorNombre(COI, texto);
  return r.tipo === 'uno' ? r.doctor.apellido : r.tipo;
};

// --- 1. LO QUE NO PUEDE NOMBRAR A NADIE ------------------------------------

{
  // ESTE ES EL CASO QUE JUSTIFICA EL MÓDULO ENTERO. «mañana» contiene «ana».
  assert.equal(quien('quiero cita para mañana'), 'ninguno', '«mañana» NO es la Dra. Ana');
  assert.equal(quien('mañana por la tarde si puede ser'), 'ninguno');
  assert.equal(quien('hasta mañana'), 'ninguno');

  // Y el resto de trozos que aparecen dentro de palabras normales.
  assert.equal(quien('me duele la muela'), 'ninguno');
  assert.equal(quien('quiero información de precios'), 'ninguno');
  assert.equal(quien('¿cuánto cuesta una limpieza?'), 'ninguno');

  // 4. EL TRATAMIENTO NO IDENTIFICA. Está delante de casi todos: si contara, esto
  //    empataría a los cuatro y se acabaría preguntando el apellido de alguien a quien el
  //    paciente nunca nombró.
  assert.equal(quien('con la doctora, por favor'), 'ninguno');
  assert.equal(quien('quiero ver a un doctor'), 'ninguno');
  assert.equal(quien('dr'), 'ninguno');

  // Vacío y ruido.
  assert.equal(quien(''), 'ninguno');
  assert.equal(quien('   '), 'ninguno');
  assert.equal(doctorPorNombre(COI, null).tipo, 'ninguno');
  assert.equal(doctorPorNombre([], 'Martínez').tipo, 'ninguno');

  // Alguien que no trabaja allí.
  assert.equal(quien('con la Dra. Pérez'), 'ninguno');
}

// --- 3. LAS FORMAS EN QUE SE NOMBRA A ALGUIEN ------------------------------

{
  // Solo el nombre de pila, solo el apellido, o los dos.
  assert.equal(quien('con Sofía'), 'Lemur');
  assert.equal(quien('Lemur'), 'Lemur');
  assert.equal(quien('la Dra. Sofía Lemur'), 'Lemur');

  // SIN TILDES, porque nadie las escribe en WhatsApp.
  assert.equal(quien('velez'), 'Vélez');
  assert.equal(quien('con el doctor Velez'), 'Vélez');
  assert.equal(quien('SOFIA'), 'Lemur', 'ni en mayúsculas');

  // Dentro de una frase de verdad, que es como llegan.
  assert.equal(quien('hola buenas, quería una cita con el dr velez para la muela'), 'Vélez');
  assert.equal(quien('¿la doctora Martínez tiene hueco el jueves?'), 'Martínez');
  assert.equal(quien('me atendió Ruiz la última vez'), 'Ruiz');

  // Con puntuación pegada.
  assert.equal(quien('¿Martínez?'), 'Martínez');
  assert.equal(quien('con Vélez, gracias'), 'Vélez');
}

// --- 2. DOS QUE SE LLAMAN IGUAL: SE PREGUNTA, NO SE ADIVINA -----------------

{
  const DOS_ANAS = leerDoctores(`
Dra. Ana Martínez
  calendario: c1@g.com
  hace: valoración

Dra. Ana López
  calendario: c2@g.com
  hace: valoración

Dr. Roberto Vélez
  calendario: c3@g.com
  hace: cordal
`, CLINICA)!;

  // SOLO «ANA» EMPATA. Adivinar aquí manda al paciente con la que no era, y no se descubre
  // hasta que llega a la clínica.
  const soloAna = doctorPorNombre(DOS_ANAS, 'quiero cita con Ana');
  assert.equal(soloAna.tipo, 'varios', 'con dos Anas NO se elige');
  assert.equal((soloAna as any).doctores.length, 2);
  assert.deepEqual(
    (soloAna as any).doctores.map((d: any) => d.apellido),
    ['Martínez', 'López'],
    'y se devuelven las dos, para poder preguntar por cuál'
  );

  // LA FRASE PARA PREGUNTAR SOLO LLEVA LOS APELLIDOS. Repetir el nombre de pila que el
  // paciente acaba de decir le hace sentir que no se le ha entendido nada.
  const pregunta = preguntaDeApellido((soloAna as any).doctores);
  assert.equal(pregunta, 'Martínez o López');
  assert.ok(!pregunta.includes('Ana'), 'no se le repite lo que ya dijo');

  // CON EL APELLIDO, YA NO HAY EMPATE: dos palabras contra una.
  const conApellido = doctorPorNombre(DOS_ANAS, 'con Ana Martínez');
  assert.equal(conApellido.tipo, 'uno');
  assert.equal((conApellido as any).doctor.apellido, 'Martínez');

  // Y el apellido solo también basta.
  const soloApellido = doctorPorNombre(DOS_ANAS, 'López');
  assert.equal(soloApellido.tipo, 'uno');
  assert.equal((soloApellido as any).doctor.apellido, 'López');

  // El que no se llama Ana sigue reconociéndose sin ruido.
  assert.equal((doctorPorNombre(DOS_ANAS, 'Vélez') as any).doctor.apellido, 'Vélez');
}

{
  // TRES QUE COMPARTEN NOMBRE se preguntan igual, y la frase se lee bien.
  const TRES = leerDoctores(`
Dra. Ana Martínez
  calendario: c1@g.com
Dra. Ana López
  calendario: c2@g.com
Dra. Ana Ruiz
  calendario: c3@g.com
`, CLINICA)!;
  const r = doctorPorNombre(TRES, 'Ana');
  assert.equal(r.tipo, 'varios');
  assert.equal(preguntaDeApellido((r as any).doctores), 'Martínez, López o Ruiz');
}

console.log('agenda_nombres_test: OK');

/**
 * Uso del nombre en las respuestas.
 *
 * Los casos de arriba son LITERALES de la conversación de WhatsApp que trajo el
 * operador el 17 de agosto, la que le sonaba «muy robótica». Si esto pasa, ese
 * problema concreto está resuelto.
 *
 * Y lo que más se protege NO es que se quite el nombre, sino que NO SE ROMPA EL
 * MENSAJE. Un nombre de sobra es un problema de estilo; un mensaje mutilado es un
 * problema con un paciente delante.
 */

import assert from 'node:assert/strict';
import { ajustarUsoDelNombre } from '../src/chatwoot/name-style.js';

const con = (texto: string) => ajustarUsoDelNombre(texto, 'David').texto;

// --- Las frases reales de la conversación ------------------------------------

assert.equal(con('Entendido, David. Le paso de inmediato con una persona de nuestro equipo.'),
  'Entendido. Le paso de inmediato con una persona de nuestro equipo.');

assert.equal(con('Por supuesto, David. Le pongo en contacto con una persona de nuestro equipo.'),
  'Por supuesto. Le pongo en contacto con una persona de nuestro equipo.');

assert.equal(con('Tranquilo, David, no pasa nada. Son las 17:55 en Madrid.'),
  'Tranquilo, no pasa nada. Son las 17:55 en Madrid.');

assert.equal(con('¡Listo, David! Le he reservado su nueva cita para el sábado 15 de agosto.'),
  '¡Listo! Le he reservado su nueva cita para el sábado 15 de agosto.');

// --- El saludo SÍ se queda: es la «ocasión especial» ------------------------

let r = ajustarUsoDelNombre('Hola David, ¿en qué puedo ayudarte?', 'David');
assert.equal(r.texto, 'Hola David, ¿en qué puedo ayudarte?', 'el saludo no se toca');
assert.equal(r.conservado, 'saludo');
assert.equal(r.quitados, 0);

assert.equal(con('Buenos días David, su cita sigue confirmada.'),
  'Buenos días David, su cita sigue confirmada.');

// Saludo Y vocativos después: se queda el del saludo y caen los demás. Es
// exactamente el caso que hacía sonar la conversación a máquina.
r = ajustarUsoDelNombre(
  'Hola David, ¿en qué puedo ayudarte? Dime, David, y te ayudo. Gracias, David.',
  'David'
);
assert.equal(r.texto, 'Hola David, ¿en qué puedo ayudarte? Dime, y te ayudo. Gracias.');
assert.equal(r.quitados, 2);
assert.equal(r.conservado, 'saludo');

// --- Un nombre por mensaje como TOPE DURO -----------------------------------
// Aunque una fórmula no encaje en ningún patrón, no puede haber dos.

r = ajustarUsoDelNombre(
  'David, su cita es el lunes a las 10:00. Gracias por avisar, David, y hasta el lunes, David.',
  'David'
);
assert.equal((r.texto.match(/David/g) || []).length, 0, 'sin saludo, no queda ninguno');
// La frase arranca en mayúscula porque el vocativo que la abría se ha ido.
assert.ok(r.texto.startsWith('Su cita es el lunes a las 10:00.'), 'y el contenido sigue entero: ' + r.texto);
assert.ok(r.texto.includes('hasta el lunes'), 'no se pierde el final');

r = ajustarUsoDelNombre(
  'Hola David, su cita es el lunes a las 10:00. Gracias por avisar y hasta el lunes David.',
  'David'
);
assert.equal(
  (r.texto.match(/David/g) || []).length,
  1,
  'con saludo queda EXACTAMENTE uno: el del saludo'
);
assert.ok(r.texto.startsWith('Hola David,'));

// El tope duro tambien actua cuando ninguna formula encaja en un patron, y lo que
// queda sigue siendo una frase.
r = ajustarUsoDelNombre('David dice David que David viene.', 'David');
assert.ok((r.texto.match(/David/g) || []).length <= 1, 'nunca mas de uno: ' + r.texto);
assert.ok(r.texto.trim().length > 0, 'y nunca vacio');

// --- LO QUE NO SE PUEDE TOCAR -----------------------------------------------

// El nombre como parte de la frase. Quitarlo destrozaría el sentido, y además es
// justo lo que Helios dice al confirmar la identidad.
assert.equal(con('El nombre que tengo registrado es David.'),
  'El nombre que tengo registrado es David.');
assert.equal(con('¿Es David su nombre de pila?'), '¿Es David su nombre de pila?');
assert.equal(con('Me llamo David y soy el asistente.'), 'Me llamo David y soy el asistente.');
assert.equal(con('El señor David ya tiene cita.'), 'El señor David ya tiene cita.');

// Mensajes sin el nombre: intactos, byte a byte.
for (const intacto of [
  'Su cita es el sábado 15 a las 11:00.',
  '',
  'Ahora mismo estamos fuera del horario de atención.',
  'Le atenderán en breve.'
]) {
  assert.equal(con(intacto), intacto);
}

// --- Nombres que no se pueden distinguir con seguridad ----------------------
// Con dos letras, un nombre puede coincidir con cualquier cosa y romper la frase.

for (const corto of ['Al', 'Jo', 'D', '', '   ', null, undefined]) {
  const texto = 'Entendido, Al. Su cita es el lunes.';
  assert.equal(
    ajustarUsoDelNombre(texto, corto).texto,
    texto,
    `con «${String(corto)}» no se toca nada: el riesgo de romper la frase es mayor`
  );
}

// --- Nombres compuestos y acentos -------------------------------------------

assert.equal(ajustarUsoDelNombre('Entendido, Juan Carlos. Su cita es el lunes.', 'Juan Carlos').texto,
  'Entendido. Su cita es el lunes.');
assert.equal(ajustarUsoDelNombre('Entendido, María. Su cita es el lunes.', 'María').texto,
  'Entendido. Su cita es el lunes.');
assert.equal(ajustarUsoDelNombre('Hola María, ¿qué tal?', 'María').texto, 'Hola María, ¿qué tal?');

// El nombre no distingue mayúsculas: si el modelo escribe «david», también cuenta.
assert.equal(con('Entendido, david. Su cita sigue en pie.'), 'Entendido. Su cita sigue en pie.');

// --- LA RED DE SEGURIDAD ----------------------------------------------------
// Nada de lo de arriba puede producir un mensaje vacío ni recortado a la mitad.

const CASOS = [
  'Entendido, David.',
  'David.',
  'David, David, David.',
  '¡David!',
  'Hola David.',
  'Hola David, David, David.',
  ', David,',
  'David',
  '  David  ',
  '¿David?'
];
for (const caso of CASOS) {
  const salida = ajustarUsoDelNombre(caso, 'David');
  assert.ok(typeof salida.texto === 'string', 'siempre devuelve texto');
  assert.ok(
    salida.texto.trim().length > 0 || caso.trim().length === 0,
    `«${caso}» no puede quedar vacío, quedó «${salida.texto}»`
  );
  // LA COTA REAL: lo que falta tiene que explicarse por los nombres quitados.
  // Cada quita se lleva el nombre, su coma y algun espacio; nada mas. Asi se
  // distingue una limpieza legitima de un patron que se ha comido texto.
  const perdida = caso.length - salida.texto.length;
  assert.ok(
    perdida <= salida.quitados * ('David'.length + 4) + 8,
    `«${caso}» perdió ${perdida} caracteres quitando ${salida.quitados} nombres: «${salida.texto}»`
  );
}

// No se dejan comas huérfanas ni espacios dobles, que se ven en WhatsApp.
for (const entrada of [
  'Entendido, David. Su cita es el lunes.',
  'Tranquilo, David, no pasa nada.',
  'Hola David, dime David.',
  'Gracias, David'
]) {
  const salida = con(entrada);
  assert.ok(!/\s,/.test(salida), `coma suelta en «${salida}»`);
  assert.ok(!/,\s*[.!?]/.test(salida), `coma antes de punto en «${salida}»`);
  assert.ok(!/ {2,}/.test(salida), `espacio doble en «${salida}»`);
  assert.ok(!/^\p{Ll}/u.test(salida), `empieza en minúscula: «${salida}»`);
}

// Y la primera letra se recupera cuando el vocativo abría la frase.
assert.equal(con('David, le paso con una persona del equipo.'),
  'Le paso con una persona del equipo.');

// --- Se cuenta lo que se quita, para poder medir si esto sirve --------------
// El operador dijo que la solución anterior «nunca funcionó». Sin un número no se
// puede saber si esta sí.

r = ajustarUsoDelNombre('Entendido, David. Claro, David. Gracias, David.', 'David');
assert.equal(r.quitados, 3);
assert.equal(r.conservado, 'ninguno');
assert.equal(r.texto, 'Entendido. Claro. Gracias.');

console.log('name_style_test: PASS');

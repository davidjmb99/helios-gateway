/**
 * Las casillas de servicios, doctores y días cerrados.
 *
 * POR QUÉ EXISTEN. Los tres campos guardan texto con un formato, y el formato se enseñaba
 * en el `placeholder` —que desaparece al escribir la primera letra, o sea justo cuando
 * hace falta—. David escribió un profesional sin su línea `calendario:`, el guardado
 * entero se rechazó (bien rechazado: sin calendario no se le pueden dar citas) y no había
 * forma de recordar el modelo. Ahora cada dato tiene su casilla con su nombre encima.
 *
 * LO QUE ESTA PRUEBA PROTEGE NO ES QUE LAS CASILLAS FUNCIONEN: ES QUE ABRIR AJUSTES Y
 * GUARDAR NO DESTRUYA LO QUE UNA CLÍNICA YA TENÍA. COI tiene datos reales en esos tres
 * campos. El panel los lee, los reparte en casillas y los vuelve a escribir; si esa ida y
 * vuelta pierde algo, la configuración de una clínica en producción se corrompe en el
 * momento en que alguien abre la pantalla y le da a guardar.
 *
 * Y NO SE COMPARA EL TEXTO, SE COMPARA LO QUE ENTIENDE EL SERVIDOR. Dos textos con
 * distinta sangría o distinto orden de campos son distintos como cadenas e idénticos como
 * configuración. Lo que no puede cambiar es lo segundo, así que se pasa el original y el
 * de vuelta por el MISMO parser que usa Helios en producción.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.CLINIC_TIMEZONE = 'Europe/Madrid';

const { serviciosDeTexto, doctoresDeTexto, normalizarDoctores } =
  await import('../src/tenants/settings-schema.js');
const { leerCierres } = await import('../src/agenda/cierres.js');

// --- Sacar las dos funciones del panel y ejecutarlas de verdad ----------------
//
// Se extraen del HTML en vez de copiarlas aquí: una copia se queda vieja en cuanto alguien
// toca el panel, y entonces la prueba estaría protegiendo un código que ya no se ejecuta.

const panel = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const desde = panel.indexOf('function leerFichas(');
const hasta = panel.indexOf('// --- Pintar, editar');
assert.ok(desde > 0 && hasta > desde, 'no se encontraron leerFichas/escribirFichas en el panel');

const fuente = panel.slice(desde, hasta);
const fabrica = new Function(fuente + '\nreturn { leerFichas, escribirFichas };');
const { leerFichas, escribirFichas } = fabrica() as {
  leerFichas: (cual: string, texto: string) => any[];
  escribirFichas: (cual: string, filas: any[]) => string;
};

const ida = (cual: string, texto: string) => escribirFichas(cual, leerFichas(cual, texto));

// =============================================================================
// 1. LA IDA Y VUELTA NO CAMBIA LO QUE ENTIENDE EL SERVIDOR
// =============================================================================

const SERVICIOS = [
  'Limpieza dental: 40$',
  'Limpieza dental: 40$\nExodoncia simple: 60$',
  // Los otros nombres, que es la mitad que importa para reconocer al paciente.
  'Exodoncia simple: 60$ (sacar muela, extraccion, sacar diente)',
  // UN PRECIO CON PARÉNTESIS DENTRO. Partir por el primer paréntesis convertiría parte
  // del precio en un sinónimo, y el precio es lo que acaba en una discusión de mostrador.
  'Blanqueamiento: 150$ a 250$ (por sesion)',
  'Blanqueamiento: 150$ a 250$ (por sesion) (blanquear, aclarar)',
  'Ortodoncia: desde 800$ (brackets, aparato, frenos)\nValoracion: gratis\nUrgencia: 30$',
  ''
];

for (const texto of SERVICIOS) {
  assert.deepEqual(
    serviciosDeTexto(ida('servicios', texto)),
    serviciosDeTexto(texto),
    `los servicios cambian al pasar por las casillas:\n${texto}`
  );
}

const DOCTORES = [
  'Dra. Ana Martinez\n  calendario: c_a1@group.calendar.google.com\n  hace: valoracion, higiene',
  // Con horario propio, que es la excepción y por tanto lo que más se rompe.
  'Dra. Sofia Lemur\n  calendario: c_g7@group.calendar.google.com\n  horario: L, J, V, S\n  hace: odontopediatria',
  // Preferente con asterisco: sin él el servicio es SOLO de quien lo declara.
  'Dr. Roberto Velez\n  calendario: c_j1@group.calendar.google.com\n  hace: cordal, implante, urgencia*',
  // Varios, separados por una línea en blanco.
  'Dra. Ana Martinez\n  calendario: c_a1@group.calendar.google.com\n  hace: higiene\n\n'
    + 'Dr. Carlos Ruiz\n  calendario: c_d4@group.calendar.google.com\n  hace: brackets',
  // SIN SANGRAR Y EN OTRO ORDEN: es texto que ya podría estar guardado, escrito a mano.
  'Dr. Carlos Ruiz\nhace: brackets\ncalendario: c_d4@group.calendar.google.com',
  // Un doctor sin `hace`, que es válido: un servicio que no declara nadie lo hace cualquiera.
  'Dra. Ana Martinez\n  calendario: c_a1@group.calendar.google.com'
];

for (const texto of DOCTORES) {
  const vuelta = ida('doctores', texto);
  assert.deepEqual(
    doctoresDeTexto(vuelta), doctoresDeTexto(texto),
    `los doctores cambian al pasar por las casillas:\n${texto}\n---\n${vuelta}`
  );
  // Y SIGUE SIENDO GUARDABLE. Que el parser lo entienda igual no basta: si la vuelta
  // dejara de pasar el validador, el operador no podría guardar lo que ya tenía.
  assert.ok(
    normalizarDoctores(vuelta) !== null,
    `la vuelta ya no se puede guardar:\n${vuelta}`
  );
}

const CIERRES = [
  '25/12/2026   Navidad',
  '25/12/2026',
  '15/08/2026 - 22/08/2026   vacaciones',
  '25/12/2026   Navidad\n01/01/2027   Ano nuevo\n15/08/2026 - 22/08/2026   vacaciones',
  '25-12-2026   Navidad'
];

for (const texto of CIERRES) {
  assert.deepEqual(
    leerCierres(ida('cierres', texto)), leerCierres(texto),
    `los dias cerrados cambian al pasar por las casillas:\n${texto}`
  );
}

// =============================================================================
// 2. LO QUE NO SE ENTIENDE NO SE TIRA
// =============================================================================
//
// ES LA OTRA MITAD DE LA SEGURIDAD. Si una línea guardada no encaja en las casillas, la
// tentación es descartarla; eso sería BORRAR un dato de la clínica por el mero hecho de
// abrir la pantalla. Se deja entera en la primera casilla, donde se ve y se puede
// arreglar.

for (const [cual, raro] of [
  ['servicios', 'esto no lleva dos puntos'],
  ['cierres', 'el lunes que viene cerramos'],
  ['doctores', 'Un profesional sin nada mas']
] as const) {
  const filas = leerFichas(cual, raro);
  assert.equal(filas.length, 1, `«${raro}» tenia que dar una ficha`);
  assert.ok(
    JSON.stringify(filas[0]).includes(raro),
    `«${raro}» se perdio al repartirlo en casillas, y eso es borrar un dato de la clinica`
  );
}

// =============================================================================
// 3. UNA FICHA VACÍA NO ESCRIBE UNA LÍNEA VACÍA
// =============================================================================
//
// Al darle a «Añadir» aparece una ficha en blanco. Si eso escribiera una línea vacía en el
// texto, el validador la rechazaría y el operador vería «no se guardó nada» por haber
// pulsado un botón.

const EN_BLANCO = {
  servicios: { nombre: '', precio: '', tambien: '' },
  doctores: { nombre: '', calendario: '', horario: '', hace: '' },
  cierres: { desde: '', hasta: '', motivo: '' }
};
const UNA_LLENA = {
  servicios: { nombre: 'Limpieza', precio: '40$', tambien: '' },
  doctores: { nombre: 'Dra. Ana', calendario: 'c_a1@group.calendar.google.com', horario: '', hace: '' },
  cierres: { desde: '25/12/2026', hasta: '', motivo: 'Navidad' }
};

for (const cual of ['servicios', 'doctores', 'cierres'] as const) {
  assert.equal(
    escribirFichas(cual, [EN_BLANCO[cual]]), '',
    `una ficha en blanco escribio algo en ${cual}: pulsar «Añadir» no puede impedir guardar`
  );
  // Y NI SIQUIERA ACOMPAÑADA. Es el caso real: se añade una ficha, se rellena la de
  // arriba, y la de abajo se queda vacia porque el operador cambio de idea.
  assert.equal(
    escribirFichas(cual, [UNA_LLENA[cual], EN_BLANCO[cual]]),
    escribirFichas(cual, [UNA_LLENA[cual]]),
    `una ficha en blanco al final ensucia el texto en ${cual}`
  );
  // Y lo que queda tiene que seguir siendo guardable.
  const soloLlena = escribirFichas(cual, [UNA_LLENA[cual], EN_BLANCO[cual]]);
  if (cual === 'doctores') assert.ok(normalizarDoctores(soloLlena) !== null);
  if (cual === 'cierres') assert.ok(leerCierres(soloLlena) !== null);
  if (cual === 'servicios') assert.equal(serviciosDeTexto(soloLlena).length, 1);
}

// =============================================================================
// 4. Y QUE EL PANEL LAS USE DE VERDAD
// =============================================================================

assert.ok(
  /cargarFichas\('servicios'/.test(panel)
  && /cargarFichas\('doctores'/.test(panel)
  && /cargarFichas\('cierres'/.test(panel),
  'el panel no reparte los tres campos en casillas al abrir Ajustes'
);

// EL CUADRO CRUDO SIGUE EXISTIENDO. Es la valvula de escape: si algun dia las casillas no
// supieran representar algo guardado, se ve y se arregla a mano en vez de perderlo.
for (const id of ['clinica-servicios', 'clinica-doctores', 'clinica-cierres']) {
  assert.ok(
    new RegExp('id="' + id + '"[^>]*class="hidden').test(panel),
    `${id} tiene que seguir existiendo, oculto detras de «Ver como texto»`
  );
}
assert.ok(/function alternarTexto\(/.test(panel), 'falta el interruptor de ver como texto');

// Y EL CALENDARIO, DICHO COMO OBLIGATORIO EN SU CASILLA. Es el fallo que se vino a
// arreglar: sin esa etiqueta seguiria siendo un campo mas que se puede dejar vacio.
assert.ok(
  /ID de calendario de Google \(obligatorio\)/.test(panel),
  'la casilla del calendario tiene que decir que es obligatoria'
);

console.log('fichas_panel_test: OK');

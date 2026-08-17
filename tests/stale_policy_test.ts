/**
 * Cuándo vuelve a la IA una conversación en manos humanas.
 *
 * Esta decisión NO tenía ninguna prueba: el barrido toca Supabase y Chatwoot, así
 * que nadie la habia montado en un test. Y es la parte que puede estar mal, porque
 * es la que decide si se le quita una conversación a una persona que la está
 * atendiendo.
 *
 * Lo que se protege:
 *  1. Que el umbral se respete en los dos sentidos: que vuelva cuando toca y que
 *     NO vuelva antes.
 *  2. Que sin saber cuándo fue la última actividad no se devuelva nada. Adivinar
 *     aquí significa interrumpir a quien está atendiendo.
 *  3. Que el límite sea inclusivo, para que «2 horas» signifique 2 horas.
 *  4. Que un umbral imposible no llegue nunca a la decisión.
 */

import assert from 'node:assert/strict';
import {
  decidirVuelta,
  normalizarHorasVuelta,
  HORAS_VUELTA,
  MINIMO_HORAS_VUELTA,
  MAXIMO_HORAS_VUELTA
} from '../src/handoff/stale-policy.js';

const AHORA = new Date('2026-08-17T18:00:00Z');
const hace = (horas: number) => new Date(AHORA.getTime() - horas * 3600_000).toISOString();

// --- El umbral se respeta en los dos sentidos --------------------------------

let d = decidirVuelta({ referencia: hace(3), umbralHoras: 2, ahora: AHORA });
assert.equal(d.volver, true, 'tres horas inactiva con umbral de dos: vuelve');
assert.equal(d.motivo, 'inactividad');
assert.equal(d.horas_inactiva, 3);
assert.equal(d.umbral_horas, 2);

d = decidirVuelta({ referencia: hace(3), umbralHoras: 5, ahora: AHORA });
assert.equal(d.volver, false, 'las mismas tres horas con umbral de cinco: NO vuelve');
assert.equal(d.motivo, 'todavia_activa');
assert.equal(d.horas_inactiva, 3, 'y se sigue informando de cuánto lleva');

// LO QUE DE VERDAD IMPORTA: la misma conversación, dos clínicas con umbral
// distinto, resultados distintos. Si esto no se cumpliera, el ajuste seria
// decorativo aunque se guardara bien en la base.
for (const [umbral, esperado] of [[1, true], [2, true], [3, true], [5, false], [8, false]] as const) {
  assert.equal(
    decidirVuelta({ referencia: hace(3.5), umbralHoras: umbral, ahora: AHORA }).volver,
    esperado,
    `tres horas y media con umbral de ${umbral}: ${esperado ? 'vuelve' : 'no vuelve'}`
  );
}

// --- El límite es inclusivo --------------------------------------------------
// A las 2 horas EXACTAS con umbral de 2 tiene que volver. Si fuera exclusivo
// habria que esperar al siguiente barrido y «2 horas» pasaria a ser «2 y pico».

assert.equal(
  decidirVuelta({ referencia: hace(2), umbralHoras: 2, ahora: AHORA }).volver,
  true,
  'a las dos horas exactas con umbral de dos, vuelve'
);
assert.equal(
  decidirVuelta({ referencia: new Date(AHORA.getTime() - 2 * 3600_000 + 1000).toISOString(), umbralHoras: 2, ahora: AHORA }).volver,
  false,
  'un segundo antes de las dos horas, todavia no'
);

// --- Sin referencia no se devuelve nada -------------------------------------

for (const sinReferencia of [null, undefined, '', 'ayer por la tarde', 'no-es-una-fecha']) {
  const salida = decidirVuelta({ referencia: sinReferencia as any, umbralHoras: 1, ahora: AHORA });
  assert.equal(salida.volver, false, `«${String(sinReferencia)}» no puede provocar una vuelta`);
  assert.equal(salida.motivo, 'sin_referencia');
  assert.equal(salida.horas_inactiva, null, 'y no se inventa cuánto lleva inactiva');
}

// Una conversación con actividad EN EL FUTURO -reloj desajustado, fecha mal
// escrita- tampoco vuelve. Es lo prudente: no interrumpir.
assert.equal(
  decidirVuelta({ referencia: hace(-2), umbralHoras: 1, ahora: AHORA }).volver,
  false,
  'una referencia en el futuro no provoca vuelta'
);

// --- El rango del umbral -----------------------------------------------------

assert.deepEqual([...HORAS_VUELTA], [1, 2, 3, 5, 8], 'las opciones del panel');
assert.equal(MINIMO_HORAS_VUELTA, 1);
assert.equal(MAXIMO_HORAS_VUELTA, 48);

for (const malo of [0, -1, 0.4, 49, 168, 999, 'dos horas', null, undefined, '', NaN, {}, []]) {
  assert.equal(
    normalizarHorasVuelta(malo),
    null,
    `«${String(malo)}» no es un umbral aceptable`
  );
}
for (const bueno of [1, 2, 3, 5, 8, 24, 48]) {
  assert.equal(normalizarHorasVuelta(bueno), bueno);
}
// Un valor valido que no esta en el desplegable si se acepta: lo que protege es el
// rango, no la lista de botones.
assert.equal(normalizarHorasVuelta(4), 4);
assert.equal(normalizarHorasVuelta('6'), 6, 'lo que llega por HTTP es texto');
assert.equal(normalizarHorasVuelta(2.4), 2, 'se redondea, no se rechaza');

// NO EXISTE «nunca». Desactivar la vuelta convertiria un olvido en un paciente sin
// respuesta indefinidamente, que es el fallo que esta red de seguridad evita.
for (const intento of [Infinity, -Infinity, 'nunca', 'never', 0]) {
  assert.equal(normalizarHorasVuelta(intento), null, `«${String(intento)}» no puede desactivar la vuelta`);
}

console.log('stale_policy_test: PASS');

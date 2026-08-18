/**
 * Qué se hace con un lote parado, y sobre todo qué NO se deja de hacer.
 *
 * EL FALLO QUE ESTO CUBRE es real y tiene nombre y fecha: el 17 de agosto, la
 * conversación 69 de una paciente llamada Ligia llegó a cinco intentos y
 * desapareció. No se reintentó, no se derivó y no se le avisó. El worker buscaba
 * `attempt_count < 5` y a partir de ahí el lote dejaba de existir.
 *
 * Por eso el test más importante de este archivo no es que reintente bien: es que
 * al agotarse los intentos SIEMPRE salga 'rescatar' y nunca un silencio.
 */

import assert from 'node:assert/strict';
import {
  decidirAccion,
  normalizarIntentos,
  INTENTOS_RECOVERY,
  MINIMO_INTENTOS,
  MAXIMO_INTENTOS
} from '../src/services/recovery-policy.js';

// --- Lo que nunca puede volver a pasar ---------------------------------------

{
  // El caso de Ligia, literal: cinco intentos con límite cinco.
  const accion = decidirAccion({ intentos: 5, limite: 5 });
  assert.equal(accion, 'rescatar', 'agotar los intentos tiene que llamar a una persona');
}

{
  // Y por encima del límite también, que es como quedaron los lotes viejos.
  for (const intentos of [5, 6, 9, 40]) {
    assert.equal(
      decidirAccion({ intentos, limite: 5 }),
      'rescatar',
      `con ${intentos} intentos y límite 5 hay que rescatar`
    );
  }
}

{
  // No existe ninguna combinación que devuelva un silencio. O se reintenta, o se
  // rescata, o ya se rescató. Esta es la propiedad de fondo.
  for (let limite = MINIMO_INTENTOS; limite <= MAXIMO_INTENTOS; limite++) {
    for (let intentos = 0; intentos <= MAXIMO_INTENTOS + 3; intentos++) {
      const accion = decidirAccion({ intentos, limite });
      assert.ok(
        accion === 'reintentar' || accion === 'rescatar',
        `intentos=${intentos} limite=${limite} no puede quedar sin acción`
      );
    }
  }
}

// --- El límite es inclusivo, o el panel mentiría -----------------------------

{
  // Con límite 3: el tercer intento es el último. Cuatro es imposible.
  assert.equal(decidirAccion({ intentos: 0, limite: 3 }), 'reintentar');
  assert.equal(decidirAccion({ intentos: 2, limite: 3 }), 'reintentar');
  assert.equal(decidirAccion({ intentos: 3, limite: 3 }), 'rescatar');
}

{
  // Límite 1 = «si falla, deriva enseguida». Es una postura válida.
  assert.equal(decidirAccion({ intentos: 0, limite: 1 }), 'reintentar');
  assert.equal(decidirAccion({ intentos: 1, limite: 1 }), 'rescatar');
}

// --- No se rescata dos veces -------------------------------------------------

{
  const accion = decidirAccion({ intentos: 9, limite: 5, yaRescatado: '2026-08-18T20:00:00Z' });
  assert.equal(accion, 'ignorar', 'un lote ya derivado no se vuelve a derivar');
}

{
  // Y la marca gana incluso cuando todavía quedaría margen.
  assert.equal(
    decidirAccion({ intentos: 1, limite: 5, yaRescatado: '2026-08-18T20:00:00Z' }),
    'ignorar'
  );
}

// --- Datos corruptos: la opción barata ---------------------------------------

{
  // Un contador ilegible se trata como cero. Reintentar es recuperable; rescatar
  // molesta a una persona de la clínica por un dato roto.
  for (const basura of [null, undefined, '', 'muchos', NaN, -3, {}]) {
    assert.equal(
      decidirAccion({ intentos: basura, limite: 5 }),
      'reintentar',
      `intentos=${JSON.stringify(basura)} debe reintentar, no molestar a nadie`
    );
  }
}

{
  // Un límite imposible se ACOTA, no se obedece. Obedecer un 0 dejaría la
  // conversación sin procesar nunca, y obedecer un 9999 la reintentaría eterna.
  // Con límite 0 se comporta como límite 1: un intento y a una persona.
  assert.equal(decidirAccion({ intentos: 0, limite: 0 }), 'reintentar');
  assert.equal(decidirAccion({ intentos: 1, limite: 0 }), 'rescatar');
  // Y con límite 9999 se comporta como el techo, no como 9999.
  assert.equal(decidirAccion({ intentos: MAXIMO_INTENTOS - 1, limite: 9999 }), 'reintentar');
  assert.equal(decidirAccion({ intentos: MAXIMO_INTENTOS, limite: 9999 }), 'rescatar');
}

// --- El validador del panel --------------------------------------------------

{
  for (const opcion of INTENTOS_RECOVERY) {
    assert.equal(normalizarIntentos(opcion), opcion, `${opcion} es una opción ofrecida`);
  }
  assert.equal(normalizarIntentos('3'), 3, 'del formulario llega texto');
  assert.equal(normalizarIntentos(3.4), 3, 'se redondea');
}

{
  for (const malo of [0, -1, 13, 100, 'tres', '', null, undefined, {}]) {
    assert.equal(
      normalizarIntentos(malo),
      null,
      `${JSON.stringify(malo)} no puede guardarse`
    );
  }
}

console.log('recovery_policy_test: OK');

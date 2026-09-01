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
  opcionesDeIntentos,
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

  // LA LISTA OFRECIDA Y EL RANGO ADMITIDO SON DOS COSAS DISTINTAS, y confundirlas rompe
  // clínicas en silencio. El 1 y el 8 se dejaron de OFRECER el 1 de septiembre, pero se
  // siguen ADMITIENDO: si una clínica los tuviera guardados y dejaran de validar, su ajuste
  // se caería al valor por defecto sin que nadie lo pidiera ni nada lo avisara.
  assert.deepEqual([...INTENTOS_RECOVERY], [3, 5], 'lo que se ofrece en el panel');
  for (const yaNoOfrecido of [1, 2, 4, 8, 12]) {
    assert.equal(
      normalizarIntentos(yaNoOfrecido), yaNoOfrecido,
      `${yaNoOfrecido} ya no se ofrece, pero un valor guardado tiene que seguir valiendo`
    );
  }

  // Y NINGUNA OPCIÓN OFRECIDA PUEDE SER 1. Con la reapertura de ejecuciones encendida
  // (HEL-104), el intento que vuelve a llamar a Hermes de verdad es el SEGUNDO: con el
  // límite en 1 esa segunda oportunidad no se usaría nunca, y el ajuste prometería una
  // recuperación que no puede ocurrir.
  assert.ok(
    INTENTOS_RECOVERY.every(n => n >= 3),
    'ofrecer 1 o 2 deja sin efecto la reapertura del Adapter'
  );
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

// --- Los botones que ve cada clinica -----------------------------------------
//
// EL PANEL SOLO PINTA LO QUE LE LLEGA AQUI. Si una clinica tiene guardado un valor que se
// dejo de ofrecer, y no se le anade, ve los botones SIN NINGUNO MARCADO: no sabe en que
// esta, y el primer clic se lo cambia creyendo que solo estaba mirando.
//
// Es un fallo silencioso y de los caros: no da error, no se ve en los logs, y quien lo
// sufre es la clinica que menos toca sus ajustes.

{
  // Lo normal: el valor esta en la lista y no se anade nada.
  assert.deepEqual(opcionesDeIntentos(3), [3, 5]);
  assert.deepEqual(opcionesDeIntentos(5), [3, 5]);

  // Un valor retirado SI se anade, y en su sitio.
  assert.deepEqual(opcionesDeIntentos(1), [1, 3, 5], 'una clinica con 1 tiene que ver su 1');
  assert.deepEqual(opcionesDeIntentos(8), [3, 5, 8], 'y una con 8, su 8, al final');
  assert.deepEqual(opcionesDeIntentos(4), [3, 4, 5], 'y uno intermedio, en medio');

  // Un valor imposible NO se anade: pintar un boton de «0 intentos» ofreceria algo que el
  // validador rechaza, y el clic fallaria sin explicacion.
  for (const imposible of [0, -1, 13, 'tres', null, undefined, {}]) {
    assert.deepEqual(
      opcionesDeIntentos(imposible), [3, 5],
      `${JSON.stringify(imposible)} no se puede guardar, asi que no se ofrece`
    );
  }

  // Y NUNCA SE REPITE UN BOTON. Con el valor ya en la lista, anadirlo daria dos botones
  // iguales y los dos marcados.
  for (const n of [1, 3, 4, 5, 8, 12]) {
    const opciones = opcionesDeIntentos(n);
    assert.equal(
      new Set(opciones).size, opciones.length,
      `${n} genera un boton repetido`
    );
  }
}

console.log('recovery_policy_test: OK');

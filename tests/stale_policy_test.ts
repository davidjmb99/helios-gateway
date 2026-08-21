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

// --- EL RELOJ SE PARA CUANDO LA CLINICA CIERRA ------------------------------
//
// EL CASO QUE PLANTEO DAVID el 20-ago-2026, y que hasta hoy perdia la derivacion:
//
//   «Imaginate que yo pida hablar con un humano ahorita [20:03, cierra a las 20:00].
//   Obviamente me va a tomar la conversacion a las 10am. Y con lo de inactividad, en
//   3 horas lo devuelve a modo IA. Entonces ese caso no lo va a tomar nadie.»
//
// Con el reloj de pared, esa derivacion volvia a la IA a las 23:03 de la noche y por
// la mañana no habia ninguna peticion esperando: el paciente pidio hablar con una
// persona y nadie llego a enterarse. El umbral significa «cuanto tiempo le doy al
// equipo para responder», y ese tiempo solo existe cuando hay alguien.

{
  const ZONA = 'America/Caracas';
  // Lunes a viernes 10:00-20:00, sabado 10:00-15:00, domingo cerrado.
  const HORARIO: Record<number, Array<{ desde: number; hasta: number }>> = {
    0: [],
    1: [{ desde: 600, hasta: 1200 }],
    2: [{ desde: 600, hasta: 1200 }],
    3: [{ desde: 600, hasta: 1200 }],
    4: [{ desde: 600, hasta: 1200 }],
    5: [{ desde: 600, hasta: 1200 }],
    6: [{ desde: 600, hasta: 900 }]
  };
  // Venezuela no tiene horario de verano: UTC-4 todo el año.
  const ccs = (iso: string) => new Date(`${iso}-04:00`);

  const decidir = (referencia: string, ahora: string, umbralHoras = 3) =>
    decidirVuelta({
      referencia: ccs(referencia).toISOString(),
      umbralHoras,
      ahora: ccs(ahora),
      zona: ZONA,
      horario: HORARIO
    });

  // 1. EL CASO DE DAVID. Derivacion el jueves a las 20:03, ya cerrado.
  {
    // Tres horas de reloj despues: la clinica lleva cerrada las tres. NO vuelve.
    const d = decidir('2026-08-20T20:03:00', '2026-08-20T23:03:00');
    assert.equal(d.volver, false, 'a las 23:03 no habia nadie: devolverla borra la peticion');
    assert.equal(d.motivo, 'esperando_horario');
    assert.equal(d.horas_de_atencion, 0, 'el reloj no puede haber arrancado con la clinica cerrada');
  }
  {
    // A las 09:59 del viernes sigue sin arrancar.
    const d = decidir('2026-08-20T20:03:00', '2026-08-21T09:59:00');
    assert.equal(d.volver, false, 'trece horas de reloj, cero de atencion');
    assert.equal(d.horas_de_atencion, 0);
  }
  {
    // A las 12:59 del viernes lleva 2h59 de atencion: todavia no.
    const d = decidir('2026-08-20T20:03:00', '2026-08-21T12:59:00');
    assert.equal(d.volver, false);
    assert.equal(d.motivo, 'todavia_activa', 'el reloj ya corre, solo que aun no llega');
    assert.ok(d.horas_de_atencion !== null && d.horas_de_atencion > 2.9 && d.horas_de_atencion < 3,
      `esperaba algo menos de 3h de atencion y salio ${d.horas_de_atencion}`);
  }
  {
    // A las 13:00 del viernes son 3 horas de atencion exactas. AHORA si.
    const d = decidir('2026-08-20T20:03:00', '2026-08-21T13:00:00');
    assert.equal(d.volver, true, 'el equipo ha tenido tres horas reales de trabajo para verla');
    assert.equal(d.motivo, 'inactividad');
    assert.equal(d.horas_de_atencion, 3);
  }

  // 2. DENTRO DE HORARIO NO CAMBIA NADA. Lo de siempre tiene que seguir igual.
  {
    const d = decidir('2026-08-20T11:00:00', '2026-08-20T14:00:00');
    assert.equal(d.volver, true, 'tres horas dentro de horario son tres horas y punto');
    assert.equal(d.horas_de_atencion, 3);
  }
  {
    const d = decidir('2026-08-20T11:00:00', '2026-08-20T13:30:00');
    assert.equal(d.volver, false, 'dos horas y media no llegan al umbral');
  }

  // 3. EL HUECO DEL FIN DE SEMANA. Sabado por la noche -> el reloj espera al lunes.
  {
    // Sabado 22-ago 16:00 (cerro a las 15:00). El domingo cierra entero.
    const d = decidir('2026-08-22T16:00:00', '2026-08-24T09:00:00');
    assert.equal(d.volver, false, 'el domingo no cuenta: no hay nadie a quien darle horas');
    assert.equal(d.horas_de_atencion, 0);
  }
  {
    const d = decidir('2026-08-22T16:00:00', '2026-08-24T13:00:00');
    assert.equal(d.volver, true, 'el lunes a las 13:00 el equipo ya ha tenido sus tres horas');
  }

  // 4. UN UMBRAL MAS LARGO CRUZA VARIOS DIAS SIN PERDERSE.
  {
    // 8 horas de atencion desde el viernes a las 18:00: quedan 2h el viernes, el
    // sabado da 5h (10:00-15:00), y la octava cae el lunes a las 11:00.
    const d = decidir('2026-08-21T18:00:00', '2026-08-24T10:59:00', 8);
    assert.equal(d.volver, false, `a las 10:59 del lunes van 7h59 -> ${d.horas_de_atencion}`);
    const e = decidir('2026-08-21T18:00:00', '2026-08-24T11:00:00', 8);
    assert.equal(e.volver, true, `a las 11:00 del lunes son 8h exactas -> ${e.horas_de_atencion}`);
  }

  // 5. EL TOPE DE SIETE DIAS. Sin el, unas vacaciones dejarian la conversacion en
  //    manos humanas para siempre, que es EL FALLO que hizo construir este barrido.
  {
    const cerrada: Record<number, Array<{ desde: number; hasta: number }>> =
      { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [{ desde: 600, hasta: 1200 }], 6: [] };
    // Solo abre los viernes. Derivacion un viernes a las 20:30, ya cerrado, y a
    // partir de ahi el horario se queda sin viernes utiles porque miramos antes.
    const conTope = (ahora: string) => decidirVuelta({
      referencia: ccs('2026-08-21T20:30:00').toISOString(),
      umbralHoras: 48,
      ahora: ccs(ahora),
      zona: ZONA,
      horario: cerrada
    });
    assert.equal(conTope('2026-08-27T20:00:00').volver, false, 'a los seis dias todavia no');
    const saltado = conTope('2026-08-28T21:00:00');
    assert.equal(saltado.volver, true, 'a los siete dias vuelve pase lo que pase');
    assert.equal(saltado.motivo, 'techo_de_reloj', 'y se distingue de una vuelta normal');
  }

  // 6. UN HORARIO ROTO NO PUEDE DEJAR A NADIE EN EL LIMBO. Sin una sola franja, el
  //    reloj de atencion no avanzaria nunca: se vuelve al reloj de pared.
  {
    const vacio: Record<number, Array<{ desde: number; hasta: number }>> =
      { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    const d = decidirVuelta({
      referencia: ccs('2026-08-20T20:03:00').toISOString(),
      umbralHoras: 3,
      ahora: ccs('2026-08-20T23:03:00'),
      zona: ZONA,
      horario: vacio
    });
    assert.equal(d.volver, true, 'un horario sin franjas es un horario roto, no una clinica que nunca abre');
    assert.equal(d.horas_de_atencion, null, 'y se dice que se conto por reloj de pared');
  }

  // 7. SIN HORARIO NI ZONA, EL COMPORTAMIENTO DE SIEMPRE. Las clinicas que no lo
  //    tengan configurado no pueden quedarse sin red.
  {
    const d = decidirVuelta({
      referencia: ccs('2026-08-20T20:03:00').toISOString(),
      umbralHoras: 3,
      ahora: ccs('2026-08-20T23:03:00')
    });
    assert.equal(d.volver, true);
    assert.equal(d.horas_de_atencion, null);
  }
}

console.log('stale_policy_test: reloj de atencion OK');

// --- UNA DERIVACION SIN ATENDER NO SE DEVUELVE: SE AVISA -------------------
//
// LO PIDIO DAVID el 21-ago-2026: «si la persona dice que si quiere un humano, pues
// entonces pasa la conversacion a humano, y no la quita hasta que la atienda el
// humano. Lo de inactividad es solo cuando ya la persona recibio respuesta humana».
//
// Es correcto: el reloj de inactividad mide cuanto lleva PARADA una atencion que
// empezo. Si no empezo, no hay nada que haya caducado, y devolverla borra la peticion
// del paciente.
//
// PERO ESO QUITA LA RED CONTRA EL OLVIDO, que es el motivo por el que existe este
// barrido. Asi que la red cambia de forma: en vez de QUITARLE la conversacion al
// equipo, se le AVISA, y la conversacion sigue en manos humanas.

{
  const ZONA = 'America/Caracas';
  const HORARIO: Record<number, Array<{ desde: number; hasta: number }>> = {
    0: [], 6: [{ desde: 600, hasta: 900 }],
    1: [{ desde: 600, hasta: 1200 }], 2: [{ desde: 600, hasta: 1200 }],
    3: [{ desde: 600, hasta: 1200 }], 4: [{ desde: 600, hasta: 1200 }],
    5: [{ desde: 600, hasta: 1200 }]
  };
  const ccs = (iso: string) => new Date(`${iso}-04:00`);

  const decidir = (extra: Record<string, any>) => decidirVuelta({
    referencia: ccs('2026-08-20T20:03:00').toISOString(),
    umbralHoras: 3,
    zona: ZONA,
    horario: HORARIO,
    ...extra
  } as any);

  // 1. NADIE LA HA TOCADO. Por muchas horas que pasen, NO se devuelve.
  {
    const d = decidir({
      ahora: ccs('2026-08-21T18:00:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: null
    });
    assert.equal(d.volver, false, 'sin atender NO se devuelve, pasen las horas que pasen');
    assert.equal(d.motivo, 'sin_atender');
  }
  {
    // Ni a los tres dias. Antes de este cambio, esto volvia a la IA y la peticion
    // del paciente desaparecia sin que nadie se enterase.
    const d = decidir({
      ahora: ccs('2026-08-24T12:00:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: null
    });
    assert.equal(d.volver, false, 'ni a los tres dias: la peticion del paciente sigue viva');
  }

  // 2. EL AVISO llega al cumplirse el umbral, en horas de ATENCION.
  {
    // Derivacion el jueves a las 20:03, cerrado. El viernes a las 12:59 llevan 2h59
    // de atencion sin tocarla: todavia no.
    const d = decidir({
      ahora: ccs('2026-08-21T12:59:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: null
    });
    assert.equal(d.avisar_sin_atender, false, `a las 2h59 de atencion aun no -> ${d.horas_sin_atender}`);
  }
  {
    const d = decidir({
      ahora: ccs('2026-08-21T13:00:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: null
    });
    assert.equal(d.avisar_sin_atender, true, 'a las 3h de atencion sin tocarla, se avisa');
    assert.equal(d.horas_sin_atender, 3);
    assert.equal(d.volver, false, 'y AVISAR no es DEVOLVER: la conversacion sigue siendo suya');
  }
  {
    // Las horas de la madrugada no cuentan, igual que en el reloj de inactividad: no
    // se puede reprochar a nadie no haber atendido con la clinica cerrada.
    const d = decidir({
      ahora: ccs('2026-08-21T09:00:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: null
    });
    assert.equal(d.horas_sin_atender, 0, 'trece horas de reloj, cero de atencion');
    assert.equal(d.avisar_sin_atender, false);
  }

  // 3. EL AVISO NO SE REPITE. El barrido corre cada pocos minutos: si se repitiera,
  //    el equipo recibiria el mismo aviso decenas de veces y dejaria de leerlos.
  {
    const d = decidir({
      ahora: ccs('2026-08-21T14:00:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: null,
      avisoSinAtenderAt: ccs('2026-08-21T13:00:00').toISOString()
    });
    assert.equal(d.avisar_sin_atender, false, 'ya avisado: no se repite');
    assert.equal(d.motivo, 'sin_atender', 'pero sigue sin atender y sigue sin devolverse');
  }
  {
    // Un aviso ANTERIOR a esta derivacion es de otro episodio y no silencia el nuevo.
    const d = decidir({
      ahora: ccs('2026-08-21T14:00:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: null,
      avisoSinAtenderAt: ccs('2026-08-15T10:00:00').toISOString()
    });
    assert.equal(d.avisar_sin_atender, true, 'un aviso de un handoff viejo no silencia el de ahora');
  }

  // 4. EN CUANTO ESCRIBE UN HUMANO, arranca el reloj de siempre.
  {
    const d = decidir({
      ahora: ccs('2026-08-21T13:00:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: ccs('2026-08-21T10:30:00').toISOString(),
      referencia: ccs('2026-08-21T10:30:00').toISOString()
    });
    assert.equal(d.motivo, 'todavia_activa', 'ya atendida: vuelve a mandar el reloj de inactividad');
    assert.equal(d.avisar_sin_atender, false, 'y no se avisa de algo que ya se atendio');
  }
  {
    // Atendida a las 10:30 y sin nada mas desde entonces: a las 13:30 son tres horas
    // de atencion paradas, y AHORA si se devuelve.
    const d = decidir({
      ahora: ccs('2026-08-21T13:30:00'),
      handoffPedidoAt: ccs('2026-08-20T20:03:00').toISOString(),
      primerHumanoAt: ccs('2026-08-21T10:30:00').toISOString(),
      referencia: ccs('2026-08-21T10:30:00').toISOString()
    });
    assert.equal(d.volver, true, 'atendida y luego parada tres horas: eso si es inactividad');
    assert.equal(d.motivo, 'inactividad');
  }

  // 5. SIN FECHA DE DERIVACION no se puede razonar sobre la atencion, y entonces se
  //    conserva el comportamiento anterior. Es el lado seguro PARA EL PACIENTE:
  //    devolver significa que Helios le vuelve a hablar; no devolver, silencio.
  {
    const d = decidir({
      ahora: ccs('2026-08-21T13:30:00'),
      handoffPedidoAt: null,
      primerHumanoAt: null,
      referencia: ccs('2026-08-21T10:30:00').toISOString()
    });
    assert.equal(d.volver, true, 'sin fecha de derivacion se mantiene el reloj de siempre');
  }
}

console.log('stale_policy_test: derivacion sin atender OK');

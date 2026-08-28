/**
 * «Las 2 de la tarde» convertido en un instante.
 *
 * ES LA DIRECCIÓN DIFÍCIL, y por eso tiene pruebas propias. `huecos.ts` la evita entera:
 * allí solo se convierte instante -> hora local, que es exacta siempre. Aquí hay que hacer
 * lo contrario, y eso no tiene solución única.
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE UNA HORA SIN HUSO SEA HORA DE LA CLÍNICA, NO DEL SERVIDOR. El contenedor corre en
 *     UTC. `new Date('2026-09-07T14:00')` da las 14:00 UTC, que en Caracas son las 10 de la
 *     mañana: una cita CUATRO HORAS antes de la pedida, sin error y sin aviso. Es el fallo
 *     más caro de este archivo y el que más fácil se cuela.
 *
 *  2. QUE EL CAMBIO DE HORA NO MUEVA UNA CITA. La madrugada en que el reloj salta, una
 *     conversión de una sola pasada usa el desfase del día anterior y deja la cita movida
 *     sesenta minutos.
 *
 *  3. QUE UNA HORA QUE NO EXISTE SE RECHACE. La noche en que el reloj adelanta se salta de
 *     las 2:00 a las 3:00: «las 2:30» no ocurre. Devolver el instante más parecido sería
 *     citar a una hora que el paciente no pidió.
 */

import assert from 'node:assert/strict';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
const { leerMomento, hoyEn, esPrimerMensajeDelDia } = await import('../src/agenda/reloj.js');

const CARACAS = 'America/Caracas';   // UTC-4 todo el año, sin cambio de hora
const MADRID = 'Europe/Madrid';      // UTC+1 en invierno, UTC+2 en verano

// --- 1. SIN HUSO ES HORA DE LA CLÍNICA ------------------------------------

{
  // Caracas está en UTC-4, así que las 14:00 de allí son las 18:00 UTC.
  assert.equal(
    leerMomento('2026-09-07T14:00', CARACAS)!.toISOString(),
    '2026-09-07T18:00:00.000Z',
    'las 2 de la tarde en Caracas'
  );

  // Y ESTO ES LO QUE NO PUEDE PASAR. Si se interpretara como UTC -que es lo que hace
  // `new Date()` en el contenedor- saldrían las 14:00Z, o sea las 10 de la mañana allí.
  assert.notEqual(
    leerMomento('2026-09-07T14:00', CARACAS)!.toISOString(),
    '2026-09-07T14:00:00.000Z',
    'NO se interpreta en la hora del servidor'
  );

  // La misma hora escrita, en otra clínica, es otro instante. Es justo lo que hace falta
  // cuando haya una cuenta en Venezuela y otra en España.
  assert.equal(
    leerMomento('2026-09-07T14:00', MADRID)!.toISOString(),
    '2026-09-07T12:00:00.000Z',
    'las 2 de la tarde en Madrid, en verano'
  );

  // Las tres formas que puede mandar un modelo.
  const esperado = '2026-09-07T18:00:00.000Z';
  assert.equal(leerMomento('2026-09-07T14:00', CARACAS)!.toISOString(), esperado);
  assert.equal(leerMomento('2026-09-07 14:00', CARACAS)!.toISOString(), esperado, 'con espacio');
  assert.equal(leerMomento('2026-09-07T14:00:00', CARACAS)!.toISOString(), esperado, 'con segundos');
}

{
  // CON HUSO YA ES UN INSTANTE y la zona de la clínica sobra. Si el modelo se molesta en
  // poner el desfase, se le cree: reinterpretarlo movería la cita.
  assert.equal(
    leerMomento('2026-09-07T14:00:00-04:00', CARACAS)!.toISOString(),
    '2026-09-07T18:00:00.000Z'
  );
  assert.equal(
    leerMomento('2026-09-07T18:00:00Z', CARACAS)!.toISOString(),
    '2026-09-07T18:00:00.000Z'
  );
  // Y con huso, la zona de la clínica NO cambia el resultado.
  assert.equal(
    leerMomento('2026-09-07T18:00:00Z', MADRID)!.toISOString(),
    leerMomento('2026-09-07T18:00:00Z', CARACAS)!.toISOString()
  );
}

// --- 2. EL CAMBIO DE HORA ---------------------------------------------------

{
  // En 2026 España atrasa el reloj el domingo 25 de octubre: a las 3:00 vuelven a ser las
  // 2:00. Antes del cambio es UTC+2, después UTC+1.
  assert.equal(
    leerMomento('2026-10-24T14:00', MADRID)!.toISOString(),
    '2026-10-24T12:00:00.000Z',
    'el sábado anterior, todavía en verano'
  );
  assert.equal(
    leerMomento('2026-10-26T14:00', MADRID)!.toISOString(),
    '2026-10-26T13:00:00.000Z',
    'el lunes siguiente, ya en invierno'
  );

  // LA MISMA HORA ESCRITA, DOS DÍAS DESPUÉS, ES UN INSTANTE DISTINTO. Una conversión de
  // una sola pasada da lo mismo las dos veces, y las citas del lunes salen una hora movidas.
  assert.notEqual(
    leerMomento('2026-10-24T14:00', MADRID)!.getTime(),
    leerMomento('2026-10-26T14:00', MADRID)!.getTime() - 2 * 864e5
  );

  // Y la vuelta cuadra: la hora local del instante es la que se pidió.
  for (const dia of ['2026-10-24', '2026-10-25', '2026-10-26', '2026-03-28', '2026-03-30']) {
    const f = leerMomento(`${dia}T14:00`, MADRID);
    assert.ok(f, `${dia} a las 14:00 tiene que existir`);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: MADRID, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(f!);
    assert.equal(local, '14:00', `${dia}: el reloj de Madrid tiene que marcar las 14:00`);
  }
}

// --- 3. UNA HORA QUE NO EXISTE SE RECHAZA ---------------------------------

{
  // En 2026 España adelanta el reloj el domingo 29 de marzo: de las 2:00 se salta a las
  // 3:00. Las 2:30 de esa madrugada NO EXISTEN.
  assert.equal(
    leerMomento('2026-03-29T02:30', MADRID),
    null,
    'una hora que el reloj se salta no se convierte en la más parecida'
  );

  // Pero la de antes y la de después sí.
  assert.ok(leerMomento('2026-03-29T01:30', MADRID));
  assert.ok(leerMomento('2026-03-29T03:30', MADRID));

  // En Caracas no hay cambio de hora, así que esa madrugada es normal.
  assert.ok(leerMomento('2026-03-29T02:30', CARACAS));
}

// --- LO QUE NO SE ENTIENDE DEVUELVE NULL, NO UNA FECHA CUALQUIERA ---------

{
  for (const malo of [
    '', '   ', 'mañana', 'mañana a las 2', '14:00', '2026-09-07',
    '07/09/2026 14:00', '2026-13-01T14:00', '2026-09-07T25:00', '2026-09-07T14:70',
    '2026-02-30T14:00', null, undefined, 42, {}
  ]) {
    assert.equal(leerMomento(malo as any, CARACAS), null, `«${String(malo)}» no es una fecha`);
  }

  // «2026-02-30» merece una línea: pasa cualquier filtro de rangos y JavaScript lo
  // convertiría alegremente en el 2 de marzo. Es el mismo fallo que se rechaza en los días
  // cerrados, y aquí sería una cita en un día que el paciente no pidió.
  assert.equal(leerMomento('2026-02-30T14:00', CARACAS), null);
}

// --- EL DÍA DE HOY, EN LA CLÍNICA -----------------------------------------

{
  // Las 2 de la madrugada UTC del día 8 son todavía el día 7 en Caracas. Sin esto, un
  // mensaje de madrugada preguntaría por los cierres del día equivocado.
  const madrugada = new Date('2026-09-08T02:00:00Z');
  assert.equal(hoyEn(CARACAS, madrugada), '2026-09-07', 'en Caracas todavía es día 7');
  assert.equal(hoyEn(MADRID, madrugada), '2026-09-08', 'en Madrid ya es día 8');
}


// --- EL PRIMER MENSAJE DEL DIA -------------------------------------------
//
// PARA QUE HELIOS SALUDE CUANDO TOCA Y NO EN CADA MENSAJE. Un «buenos dias» en el primero
// es cercano; en el cuarto seguido es un robot que no se ha enterado de que la conversacion
// ya estaba abierta. Y no saludar nunca es seco: David escribio «hola, buenos dias» y
// Helios arranco con «Le confirmo, Juan: ...».
//
// LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
//
//  1. QUE EL DIA SEA EL DE LA CLINICA Y NO EL DEL SERVIDOR. El contenedor corre en UTC: a
//     las 22:30 de Caracas alli ya es el dia siguiente. Media tarde de conversaciones
//     contaria como primer mensaje del dia, y a nadie le saludan a media conversacion.
//
//  2. Que una conversacion que empieza cuente como primer mensaje: es lo que es.
//
//  3. Que un dato ilegible no deje a alguien sin saludo. Saludar de mas es una torpeza
//     pequeña; no saludar a quien acaba de llegar es antipatico.

{
  const CARACAS = 'America/Caracas';

  // Las 02:00 UTC del dia 8 son todavia el dia 7 en Caracas. Un mensaje a esa hora
  // continua la tarde anterior: NO es el primer mensaje del dia de nadie.
  const ahora = new Date('2026-09-08T02:00:00Z');
  assert.equal(
    esPrimerMensajeDelDia('2026-09-07T23:00:00Z', CARACAS, ahora),
    false,
    'en Caracas los dos instantes son el mismo dia, aunque en UTC no lo sean'
  );

  // Y LA MISMA PAREJA DE FECHAS, OTRA CLINICA, OTRA RESPUESTA. Estas dos caen en el mismo
  // dia en Caracas -las 16:00 y las 22:00 del dia 7- y en dias distintos en Madrid -las
  // 22:00 del 7 y las 04:00 del 8-. Es la razon de que la zona no se pueda dar por hecha.
  //
  // La primera version de esta prueba usaba otro par que caia igual en las dos zonas, asi
  // que comprobaba una diferencia que no existia: la asercion estaba mal, no el codigo.
  assert.equal(
    esPrimerMensajeDelDia('2026-09-07T20:00:00Z', CARACAS, ahora),
    false,
    'en Caracas los dos son del dia 7'
  );
  assert.equal(
    esPrimerMensajeDelDia('2026-09-07T20:00:00Z', 'Europe/Madrid', ahora),
    true,
    'y en Madrid, uno del 7 y otro del 8'
  );

  // Ayer por la tarde, en hora de la clinica: si es el primero de hoy.
  assert.equal(
    esPrimerMensajeDelDia('2026-09-06T20:00:00Z', CARACAS, ahora),
    true,
    'la conversacion se quedo parada ayer'
  );

  // Hace cinco minutos: claramente no.
  assert.equal(esPrimerMensajeDelDia('2026-09-08T01:55:00Z', CARACAS, ahora), false);

  // 2 y 3. SIN DATO, SE SALUDA.
  assert.equal(esPrimerMensajeDelDia(null, CARACAS, ahora), true, 'conversacion nueva');
  assert.equal(esPrimerMensajeDelDia('', CARACAS, ahora), true);
  assert.equal(esPrimerMensajeDelDia('  ', CARACAS, ahora), true);
  assert.equal(esPrimerMensajeDelDia('cuando sea', CARACAS, ahora), true, 'fecha ilegible');
  assert.equal(esPrimerMensajeDelDia(undefined, CARACAS, ahora), true);

  // Una fecha en el futuro es un reloj mal puesto. No se saluda: la conversacion estaba
  // viva hace nada, y saludar ahi seria lo raro.
  assert.equal(
    esPrimerMensajeDelDia('2027-01-01T00:00:00Z', CARACAS, ahora),
    false,
    'un reloj mal puesto no convierte una conversacion viva en una nueva'
  );
}

console.log('agenda_reloj_test: OK');

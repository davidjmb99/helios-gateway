/**
 * Cuándo fue la última vez que se habló, dicho como un hecho en el payload.
 *
 * EL FALLO, Y ES EL TERCERO DEL MISMO TIPO EN UN DÍA. Un paciente de COI pidió cita un
 * viernes y volvió el sábado con «hola, buenos días». Helios contestó «¿le gustaría
 * agendar su limpieza? ¿qué día y a qué hora le queda mejor?» — bien, porque vuelve a
 * ofrecer y no arrastra la hora de entonces— pero SIN DECIR CUÁNDO FUE. Lo que se buscaba
 * era «el viernes me preguntó por una limpieza».
 *
 * Y NO ERA QUE IGNORASE LA REGLA: es que no podía saberlo. En el payload solo viaja el
 * mensaje actual. Sabía que había un tema pendiente; no sabía que era del viernes.
 *
 * Mismo patrón que `today` y que el espejo del trato: se le pedía deducir algo que no
 * tenía delante. Y las dos veces anteriores se arregló igual —dándole el hecho—.
 *
 * LO QUE MÁS IMPORTA DE ESTA PRUEBA: que el campo NO aparezca cuando el tema es de hoy.
 * Su ausencia es la señal de «misma conversación, continúa con naturalidad». Si apareciera
 * siempre, Helios diría «hoy me preguntaste por una limpieza» a los dos minutos de haberlo
 * hablado, y eso es peor que el fallo original: pasaría en cada mensaje en vez de una vez.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.CLINIC_TIMEZONE = 'America/Caracas';

const { ultimaActividadEn } = await import('../src/agenda/reloj.js');

const CARACAS = 'America/Caracas';
// Sábado 5 de septiembre de 2026, 00:14 en Caracas = 04:14 UTC. Es el momento exacto del
// mensaje que fallo.
const AHORA = new Date('2026-09-05T04:14:00Z');

// =============================================================================
// 1. SI FUE HOY, NO HAY CAMPO — Y ESTO ES LO QUE MÁS IMPORTA
// =============================================================================
//
// La ausencia del campo es la señal. Con campo, Helios nombra cuándo fue y vuelve a
// ofrecer; sin campo, continúa la conversación sin ceremonia. Si saliera siempre, diría
// «hoy me preguntaste» a los dos minutos, y eso sería un fallo peor: constante en vez de
// diario.

assert.equal(
  ultimaActividadEn('2026-09-05T04:05:00Z', CARACAS, AHORA), null,
  'nueve minutos antes es HOY: sin campo, se continua la conversacion'
);
assert.equal(
  ultimaActividadEn('2026-09-05T01:00:00Z', CARACAS, AHORA), null,
  'tres horas antes, el mismo dia de Caracas: tampoco'
);

// EL CASO DE LA MEDIANOCHE, QUE LO ENCONTRO ESTA PRUEBA Y NO SE HABIA PENSADO.
//
// 23:50 del viernes y 00:14 del sabado son DOS DIAS DE CALENDARIO y VEINTICUATRO MINUTOS.
// Con solo la fecha, la funcion decia «ayer» — y no es que suene raro: la regla del SOUL
// haria que Helios volviera a OFRECER en medio de la misma conversacion, como si el
// paciente hubiera podido cambiar de idea mientras cruzaba la medianoche.
//
// Por eso hace falta que haya pasado tiempo de VERDAD, no solo el reloj.
assert.equal(
  ultimaActividadEn('2026-09-05T03:50:00Z', CARACAS, AHORA), null,
  'veinticuatro minutos NO son «ayer» aunque haya cambiado el dia'
);
assert.equal(
  ultimaActividadEn('2026-09-05T01:14:00Z', CARACAS, AHORA), null,
  'tres horas tampoco, aunque cruce la medianoche'
);
// Pero el caso que SI importa -escribir de noche y volver por la mañana- sigue contando.
assert.deepEqual(
  ultimaActividadEn('2026-09-04T23:00:00Z', CARACAS, new Date('2026-09-05T14:00:00Z')),
  { ultima_actividad: '2026-09-04', ultima_actividad_label: 'ayer' },
  'las 19:00 del viernes y las 10:00 del sabado si son «ayer»'
);

// =============================================================================
// 2. EL CASO EXACTO QUE FALLÓ
// =============================================================================
//
// Viernes 4 por la tarde -17:21 en Caracas = 21:21 UTC-, y el paciente vuelve el sábado a
// las 00:14. Han pasado SIETE HORAS, pero son dos días de calendario distintos.

assert.deepEqual(
  ultimaActividadEn('2026-09-04T21:21:00Z', CARACAS, AHORA),
  { ultima_actividad: '2026-09-04', ultima_actividad_label: 'ayer' }
);

// =============================================================================
// 3. LOS DÍAS SE CUENTAN POR FECHA, NO POR HORAS
// =============================================================================
//
// De las 23:00 de ayer a la 01:00 de hoy hay DOS horas y es «ayer». De la 01:00 de ayer a
// las 23:00 de hoy hay CUARENTA Y SEIS y sigue siendo «ayer». Contando horas saldrían
// etiquetas distintas para lo mismo, y el paciente piensa en días.

{
  const casiMedianoche = new Date('2026-09-05T03:10:00Z');   // 23:10 del viernes 4 en Caracas
  assert.equal(
    ultimaActividadEn('2026-09-05T02:00:00Z', CARACAS, casiMedianoche), null,
    'una hora antes, el mismo dia: sin campo'
  );

  // 01:00 del viernes 4 -> 23:10 del sabado 5. Son CUARENTA Y SEIS horas, pero un solo
  // dia de diferencia en el calendario. La etiqueta la manda la FECHA: «ayer».
  const casiMedianocheDelSabado = new Date('2026-09-06T03:10:00Z');
  assert.deepEqual(
    ultimaActividadEn('2026-09-04T05:00:00Z', CARACAS, casiMedianocheDelSabado),
    { ultima_actividad: '2026-09-04', ultima_actividad_label: 'ayer' }
  );
}

// =============================================================================
// 4. DE DOS A SEIS DÍAS, EL NOMBRE DEL DÍA
// =============================================================================

for (const [cuando, etiqueta] of [
  ['2026-09-03T15:00:00Z', 'el jueves'],
  ['2026-09-02T15:00:00Z', 'el miércoles'],
  ['2026-09-01T15:00:00Z', 'el martes'],
  ['2026-08-31T15:00:00Z', 'el lunes'],
  ['2026-08-30T15:00:00Z', 'el domingo']
] as const) {
  const r = ultimaActividadEn(cuando, CARACAS, AHORA)!;
  assert.ok(r, `${cuando} tenia que dar etiqueta`);
  assert.equal(r.ultima_actividad_label, etiqueta, `${cuando} -> ${etiqueta}`);
}

// =============================================================================
// 5. A LOS SIETE DÍAS, LA FECHA — Y HAY UN MOTIVO
// =============================================================================
//
// A los siete días exactos el nombre del día es EL MISMO QUE HOY: estando en sábado,
// «el sábado» no sitúa nada. Por eso a partir de ahí se dice la fecha.

{
  const sieteDias = ultimaActividadEn('2026-08-29T15:00:00Z', CARACAS, AHORA)!;
  assert.equal(sieteDias.ultima_actividad_label, 'el 29 de agosto');
  assert.equal(sieteDias.ultima_actividad, '2026-08-29');

  const haceUnMes = ultimaActividadEn('2026-08-05T15:00:00Z', CARACAS, AHORA)!;
  assert.equal(haceUnMes.ultima_actividad_label, 'el 5 de agosto');
}

// =============================================================================
// 6. LA ZONA DE LA CLÍNICA, NO LA DEL SERVIDOR
// =============================================================================
//
// Es el mismo borde que con `today`, y aquí decide entre «ayer» y no decir nada.

{
  // 03:30 UTC del 5. En Caracas son las 23:30 del 4; en Madrid, las 05:30 del 5.
  const instante = new Date('2026-09-05T03:30:00Z');
  const actividad = '2026-09-04T14:00:00Z';   // 10:00 en Caracas, 16:00 en Madrid, dia 4

  assert.equal(
    ultimaActividadEn(actividad, CARACAS, instante), null,
    'en Caracas todavia es el dia 4: MISMO dia, sin campo'
  );
  assert.deepEqual(
    ultimaActividadEn(actividad, 'Europe/Madrid', instante),
    { ultima_actividad: '2026-09-04', ultima_actividad_label: 'ayer' },
    'en Madrid ya es el 5: fue AYER'
  );
}

// =============================================================================
// 7. LO QUE NO SE SABE NO SE INVENTA
// =============================================================================

for (const basura of ['', '   ', null, undefined, 'la semana pasada', 'null', {}, []]) {
  assert.equal(
    ultimaActividadEn(basura, CARACAS, AHORA), null,
    `«${JSON.stringify(basura)}» no es una fecha y no puede dar etiqueta`
  );
}

// UNA FECHA EN EL FUTURO ES UN RELOJ MAL PUESTO EN ALGUN SITIO. No se dice «ayer» ni
// nada: sin campo, y la conversacion sigue con naturalidad.
assert.equal(
  ultimaActividadEn('2026-09-10T15:00:00Z', CARACAS, AHORA), null,
  'una fecha futura no puede producir una etiqueta de pasado'
);

// =============================================================================
// 8. Y QUE VIAJE DE VERDAD EN EL PAYLOAD
// =============================================================================
//
// Puede estar perfecto y no servir de nada si no llega. Es el mismo fallo que el horario
// y el tono, que se guardaban y nunca viajaban.

{
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  const inicio = fuente.indexOf('      state: {');
  assert.ok(inicio > 0, 'se encontro el bloque state del payload');
  const bloque = fuente.slice(inicio, fuente.indexOf('\n      },', inicio));

  // ANCLADO AL PRINCIPIO DE LÍNEA: sin `^\s*` esto pasa en verde con la línea comentada.
  // Ya ocurrió una vez hoy.
  assert.ok(
    /^\s*\.\.\.\(ultimaActividadEn\(/m.test(bloque),
    'el payload no lleva la ultima actividad: Helios no podra decir cuando fue'
  );

  // CON LA ZONA DE LA CLÍNICA. Con la del servidor, «ayer» se equivocaría cada noche.
  assert.ok(
    /ultimaActividadEn\([^)]*contextoDeClinica\.zona/.test(bloque),
    'la ultima actividad tiene que calcularse en la zona de ESTA clinica'
  );

  // Y SE ESPARCE, NO SE ASIGNA. `...(x ?? {})` hace que el campo DESAPAREZCA cuando el
  // tema es de hoy, y esa ausencia es la señal. Un `ultima_actividad: null` viajaría
  // siempre y el modelo tendría que interpretarlo.
  assert.ok(
    !/^\s*ultima_actividad:/m.test(bloque),
    'no se asigna el campo suelto: tiene que desaparecer cuando el tema es de hoy'
  );
}

console.log('ultima_actividad_test: OK');

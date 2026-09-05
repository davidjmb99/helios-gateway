/**
 * Qué hora es y si la clínica está abierta, como hechos en el payload.
 *
 * EL FALLO, Y ES EL CUARTO DEL MISMO TIPO. Sábado 5-sep-2026, 15:07. Un paciente escribe
 * «hola, buenos días» a COI y Helios contesta:
 *
 *     «¡Hola, David, buenos días! ¿Listo para agendar su limpieza?
 *      Hoy sábado atendemos de 10:00am a 3:00pm. ¿A qué hora le gustaría venir?»
 *
 * A las 15:07 esa franja ENTERA ya había pasado. Y «buenos días» a las tres de la tarde.
 *
 * CON LO QUE TENÍA DELANTE, LA RESPUESTA ERA CORRECTA. En `clinic_context` viajaba `today`
 * —qué día es— y `clinic_hours` —a qué hora abre los sábados—, y nunca la hora. Sabiendo
 * solo eso, «hoy sábado atendemos de 10:00 a 15:00» es justo lo que hay que decir.
 *
 * Mismo patrón que `today`, que el espejo del trato y que `ultima_actividad`: pedirle
 * deducir algo que no tiene. Y se arregla igual: dándole el hecho.
 *
 * LO QUE ESTA PRUEBA NO PUEDE DEJAR PASAR es un `open_now` inventado. Un «false» de más
 * cierra una clínica que está atendiendo, y eso es peor que el fallo original: el original
 * ofrecía de más, y este dejaría de ofrecer del todo.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';

const { momentoDeLaClinica } = await import('../src/handoff/disponibilidad.js');

const CARACAS = 'America/Caracas';

// 10:00=600, 15:00=900, 18:00=1080. Domingo es 0, sábado 6 — el orden de `momentoLocal`.
const SEMANA_DE_COI = {
  0: [],                                  // domingo cerrado
  1: [{ desde: 600, hasta: 1080 }],
  2: [{ desde: 600, hasta: 1080 }],
  3: [{ desde: 600, hasta: 1080 }],
  4: [{ desde: 600, hasta: 1080 }],
  5: [{ desde: 600, hasta: 1080 }],
  6: [{ desde: 600, hasta: 900 }]         // sábado 10:00 a 15:00
};

// =============================================================================
// 1. EL CASO EXACTO QUE FALLÓ
// =============================================================================
//
// Sábado 5-sep-2026, 15:07 en Caracas = 19:07 UTC. Siete minutos después de cerrar.

{
  const m = momentoDeLaClinica({
    ahora: new Date('2026-09-05T19:07:00Z'),
    zona: CARACAS,
    horario: SEMANA_DE_COI as any
  });

  assert.equal(m.now, '3:07pm', 'la hora tiene que viajar: sin ella dijo «buenos dias» a las tres');
  assert.equal(m.open_now, false, 'a las 15:07 un sabado de 10 a 15 la clinica esta CERRADA');

  // Y CON ALGO QUE OFRECER EN SU LUGAR. Sin esto, el modelo sabe que hoy no puede y se
  // queda sin nada que proponer, que deja la conversacion en un callejon.
  assert.equal(m.next_open_label, 'el lunes 7 a las 10:00am');

  // EL DIA CON SU NUMERO, no «el lunes» a secas ni «pasado mañana»: si la conversacion
  // cruza la medianoche, «pasado mañana» se vuelve mentira y «el lunes 7» no.
  assert.match(m.next_open_label!, /lunes 7/);

  // Y NADA DE `closes_at` ESTANDO CERRADA: decir «cerramos a las 3» a las 15:07 es
  // exactamente el error que se esta arreglando, dicho de otra forma.
  assert.equal(m.closes_at, undefined);
}

// =============================================================================
// 2. ABIERTA: HASTA CUÁNDO
// =============================================================================
//
// El mismo sábado a las 14:00. Queda una hora, y esa hora sí se puede ofrecer.

{
  const m = momentoDeLaClinica({
    ahora: new Date('2026-09-05T18:00:00Z'),
    zona: CARACAS,
    horario: SEMANA_DE_COI as any
  });

  assert.equal(m.now, '2:00pm');
  assert.equal(m.open_now, true);
  assert.equal(m.closes_at, '3:00pm', 'abierta, tiene que decir hasta cuando');
  assert.equal(m.next_open_label, undefined, 'estando abierta no se habla de la proxima apertura');
}

// =============================================================================
// 3. ANTES DE ABRIR NO ES LO MISMO QUE HABER CERRADO
// =============================================================================
//
// A las 09:00 del sábado la clínica también está cerrada, pero abre hoy. Si sólo viajara
// `open_now: false`, el modelo mandaría al paciente al lunes teniendo el día entero por
// delante — que es el fallo de hoy en espejo, ofreciendo de menos.

{
  const m = momentoDeLaClinica({
    ahora: new Date('2026-09-05T13:00:00Z'),
    zona: CARACAS,
    horario: SEMANA_DE_COI as any
  });

  assert.equal(m.now, '9:00am');
  assert.equal(m.open_now, false);
  assert.equal(m.next_open_label, 'el sábado 5 a las 10:00am', 'abre HOY, dentro de una hora');
}

// =============================================================================
// 4. SIN HORARIO CONFIRMADO NO SE DICE SI ESTÁ ABIERTA
// =============================================================================
//
// Misma regla que `clinic_hours`, que se omite si la clínica no lo configuró. Aquí importa
// más: `open_now` es un binario y se lee como un hecho comprobado. Un «false» salido del
// horario por defecto cerraría una clínica que está atendiendo.
//
// LA HORA SÍ VIAJA IGUAL: no depende de ningún ajuste, y «buenos días» a las tres de la
// tarde está mal aunque no se sepa a qué hora abren.

{
  const m = momentoDeLaClinica({
    ahora: new Date('2026-09-05T19:07:00Z'),
    zona: CARACAS,
    horario: null
  });

  assert.equal(m.now, '3:07pm', 'la hora no depende del horario de la clinica');
  assert.equal(m.open_now, undefined, 'sin horario confirmado no se afirma si esta abierta');
  assert.equal(m.closes_at, undefined);
  assert.equal(m.next_open_label, undefined);
}

// =============================================================================
// 5. LA PARADA PARA COMER: SE QUEDA CORTO, NUNCA SE PASA
// =============================================================================
//
// Una clínica de 9 a 13 y de 15 a 19, a las 12:50. `closes_at` dice «1:00pm», que es el
// fin del tramo en curso, no «7:00pm».
//
// ES DELIBERADO. Quedarse corto solo pierde una oferta —si el paciente pide las 16:00, la
// agenda se la dará igual—; pasarse promete una hora que no existe, que es el fallo que
// estamos arreglando. Entre los dos errores, este es el que no hace daño.

{
  const CON_SIESTA = {
    0: [], 1: [], 2: [], 3: [], 4: [], 5: [],
    6: [{ desde: 540, hasta: 780 }, { desde: 900, hasta: 1140 }]
  };
  const m = momentoDeLaClinica({
    ahora: new Date('2026-09-05T16:50:00Z'),   // 12:50 en Caracas
    zona: CARACAS,
    horario: CON_SIESTA as any
  });

  assert.equal(m.open_now, true);
  assert.equal(m.closes_at, '1:00pm', 'el fin del tramo en curso, no el del dia');
}

// Y EN EL HUECO DE LA COMIDA, a las 14:00, está cerrada de verdad y vuelve a las 15:00 —
// el mismo día. Es el caso donde la aritmética de franjas se equivoca y por eso se camina
// a saltos.
{
  const CON_SIESTA = {
    0: [], 1: [], 2: [], 3: [], 4: [], 5: [],
    6: [{ desde: 540, hasta: 780 }, { desde: 900, hasta: 1140 }]
  };
  const m = momentoDeLaClinica({
    ahora: new Date('2026-09-05T18:00:00Z'),   // 14:00 en Caracas
    zona: CARACAS,
    horario: CON_SIESTA as any
  });

  assert.equal(m.open_now, false);
  assert.equal(m.next_open_label, 'el sábado 5 a las 3:00pm', 'vuelve a abrir HOY tras la comida');
}

// =============================================================================
// 6. LA ZONA DE LA CLÍNICA, NO LA DEL SERVIDOR
// =============================================================================
//
// El contenedor corre en UTC. Es el mismo borde que con `today`, y aquí decide entre
// abierto y cerrado.

// SE ELIGE UN INSTANTE EN QUE LA ZONA CAMBIA LA RESPUESTA, no solo la hora. Con las 19:07
// UTC del sábado las dos zonas están cerradas y las dos apuntan al mismo lunes: la prueba
// pasaría sin comprobar nada. Aquí, el mismo milisegundo tiene una clínica ABIERTA y la
// otra no.
{
  const instante = new Date('2026-09-07T12:30:00Z');   // lunes: 08:30 en Caracas, 14:30 en Madrid

  const enCaracas = momentoDeLaClinica({ ahora: instante, zona: CARACAS, horario: SEMANA_DE_COI as any });
  const enMadrid = momentoDeLaClinica({ ahora: instante, zona: 'Europe/Madrid', horario: SEMANA_DE_COI as any });

  assert.equal(enCaracas.now, '8:30am');
  assert.equal(enMadrid.now, '2:30pm', 'la misma marca de tiempo son horas distintas en cada clinica');

  assert.equal(enCaracas.open_now, false, 'en Caracas todavia no han abierto');
  assert.equal(enCaracas.next_open_label, 'el lunes 7 a las 10:00am');

  assert.equal(enMadrid.open_now, true, 'en Madrid llevan cuatro horas atendiendo');
  assert.equal(enMadrid.closes_at, '6:00pm');
}

// =============================================================================
// 7. LA MEDIANOCHE NO PUEDE DAR UNA HORA IMPOSIBLE
// =============================================================================

{
  const m = momentoDeLaClinica({
    ahora: new Date('2026-09-05T04:00:00Z'),   // 00:00 del sabado en Caracas
    zona: CARACAS,
    horario: SEMANA_DE_COI as any
  });

  assert.equal(m.now, '12:00am', 'las doce de la noche son 12:00am, no 0:00am ni 12:00pm');
  assert.equal(m.open_now, false);
  assert.equal(m.next_open_label, 'el sábado 5 a las 10:00am');
}

// LA SEMANA ENTERA CERRADA -un horario mal puesto, o vacaciones- no puede inventar una
// fecha de apertura.
{
  const m = momentoDeLaClinica({
    ahora: new Date('2026-09-05T19:07:00Z'),
    zona: CARACAS,
    horario: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } as any
  });

  assert.equal(m.open_now, false);
  assert.equal(m.next_open_label, undefined, 'sin ningun tramo abierto no se inventa cuando abre');
}

// =============================================================================
// 8. Y QUE VIAJE DE VERDAD EN EL PAYLOAD
// =============================================================================
//
// Puede estar perfecto y no servir de nada si no llega. Es el mismo fallo que el horario y
// el tono, que se guardaban y nunca viajaban.

{
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  const inicio = fuente.indexOf('      clinic_context: {');
  assert.ok(inicio > 0, 'se encontro el bloque clinic_context');
  const bloque = fuente.slice(inicio, fuente.indexOf('\n      },', inicio));

  // ANCLADO AL PRINCIPIO DE LÍNEA: sin `^\s*` esto pasa en verde con la línea comentada.
  // Ya ocurrió una vez.
  assert.ok(
    /^\s*\.\.\.momentoDeLaClinica\(\{/m.test(bloque),
    'el payload no lleva la hora: Helios volvera a ofrecer franjas que ya pasaron'
  );

  // CON LA ZONA DE LA CLÍNICA. Con la del servidor, a las 22:30 de Caracas ya es otro día
  // en UTC y «abierto» se equivocaría todas las noches.
  assert.ok(
    /momentoDeLaClinica\(\{[\s\S]{0,200}?contextoDeClinica\.zona/.test(bloque),
    'tiene que calcularse en la zona de ESTA clinica'
  );

  // Y CON EL HORARIO INTERNO, no con el que se le manda a Hermes. `horario` son cadenas
  // -«10:00»- y `clinicaAbierta` cuenta minutos: pasarle el otro no lanza, simplemente
  // no encuentra ninguna franja y dice que esta cerrado SIEMPRE.
  assert.ok(
    /momentoDeLaClinica\(\{[\s\S]{0,300}?horario: contextoDeClinica\.horarioCrudo/.test(bloque),
    'tiene que usar horarioCrudo: con el formato del panel diria «cerrado» siempre'
  );
}

console.log('hora_actual_test: OK');

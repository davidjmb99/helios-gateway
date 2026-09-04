/**
 * Qué día es hoy, dicho como un hecho en el payload.
 *
 * EL FALLO QUE ARREGLA, Y PASÓ DE VERDAD EL 4-sep-2026. Un paciente escribió un jueves y
 * la conversación quedó en «¿a qué hora le quedaría mejor su limpieza para MAÑANA
 * VIERNES?». Al día siguiente —viernes— volvió a escribir y Helios contestó «quedamos en
 * agendar su limpieza para mañana viernes». Ayer era cierto. Hoy manda al paciente al
 * sábado creyendo que va al viernes.
 *
 * LA CAUSA NO ES QUE EL MODELO NO SEPA SUMAR: es que en el payload NO iba qué día es hoy.
 * Solo la zona horaria. Así que al retomar una conversación tenía delante una frase de
 * ayer y ninguna razón para desconfiar de ella.
 *
 * Una fecha relativa guardada en el historial deja de ser cierta al día siguiente, y una
 * regla del SOUL que diga «recalcúlalo» es débil contra eso: le pide deducir lo que ya
 * cree saber. Con la fecha delante como dato, no tiene que deducir nada.
 *
 * LO QUE MÁS IMPORTA DE ESTA PRUEBA ES LA ZONA. El contenedor corre en UTC: a las 22:30 de
 * Caracas allí ya es el día siguiente. Si «hoy» se calculara con el reloj del servidor,
 * cada noche Helios le diría a los pacientes que es mañana.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.CLINIC_TIMEZONE = 'America/Caracas';

const { fechaDeHoyEn } = await import('../src/agenda/reloj.js');

// =============================================================================
// 1. EL CASO EXACTO QUE SE ROMPIÓ
// =============================================================================

// Jueves 3 de septiembre de 2026, 15:00 UTC = 11:00 en Caracas.
assert.deepEqual(
  fechaDeHoyEn('America/Caracas', new Date('2026-09-03T15:00:00Z')),
  { today: '2026-09-03', today_label: 'jueves 3 de septiembre de 2026' }
);

// Y el viernes siguiente, que es cuando la frase de ayer se volvió mentira.
assert.deepEqual(
  fechaDeHoyEn('America/Caracas', new Date('2026-09-04T15:00:00Z')),
  { today: '2026-09-04', today_label: 'viernes 4 de septiembre de 2026' }
);

// =============================================================================
// 2. LA ZONA DE LA CLÍNICA, NO LA DEL SERVIDOR
// =============================================================================
//
// ES LA PARTE QUE PUEDE HACER MÁS DAÑO. El contenedor corre en UTC. A las 03:30 UTC del
// día 5 en Caracas son las 23:30 del día 4: todavía es jueves para el paciente. Si se
// usara el reloj del servidor, CADA NOCHE Helios le diría a los pacientes que ya es
// mañana, y una cita «para mañana» se iría un día entero.

assert.equal(
  fechaDeHoyEn('America/Caracas', new Date('2026-09-05T03:30:00Z')).today, '2026-09-04',
  'a las 23:30 de Caracas todavia es el dia 4, aunque en UTC ya sea el 5'
);
// Y en Madrid, a esa misma hora, ya es el 5.
assert.equal(
  fechaDeHoyEn('Europe/Madrid', new Date('2026-09-05T03:30:00Z')).today, '2026-09-05',
  'la misma marca de tiempo da dias distintos segun la clinica: eso es el punto'
);

// El otro borde: 00:30 UTC. En Caracas son las 20:30 del dia ANTERIOR.
assert.equal(
  fechaDeHoyEn('America/Caracas', new Date('2026-09-04T00:30:00Z')).today, '2026-09-03'
);

// =============================================================================
// 3. LOS SIETE DÍAS Y LOS DOCE MESES, SIN AGUJEROS
// =============================================================================
//
// Los nombres se escriben a mano para no depender de los datos de locale de la imagen
// -un «Friday» suelto en un prompt en español es justo lo que el modelo copia-. Y algo
// escrito a mano hay que recorrerlo entero: un mes mal puesto solo se descubriria ese mes.

const DIAS_ESPERADOS = [
  ['2026-09-06', 'domingo'], ['2026-09-07', 'lunes'], ['2026-09-08', 'martes'],
  ['2026-09-09', 'miércoles'], ['2026-09-10', 'jueves'], ['2026-09-11', 'viernes'],
  ['2026-09-12', 'sábado']
] as const;

for (const [dia, nombre] of DIAS_ESPERADOS) {
  const r = fechaDeHoyEn('America/Caracas', new Date(`${dia}T15:00:00Z`));
  assert.equal(r.today, dia);
  assert.ok(
    r.today_label.startsWith(nombre + ' '),
    `${dia} tenia que ser ${nombre} y salio «${r.today_label}»`
  );
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];
for (let m = 1; m <= 12; m++) {
  const dia = `2026-${String(m).padStart(2, '0')}-15`;
  const r = fechaDeHoyEn('America/Caracas', new Date(`${dia}T15:00:00Z`));
  assert.equal(r.today, dia);
  assert.equal(
    r.today_label, `${r.today_label.split(' ')[0]} 15 de ${MESES[m - 1]} de 2026`,
    `el mes ${m} sale mal: «${r.today_label}»`
  );
}

// Y un año bisiesto, que es donde falla cualquier aritmética de fechas hecha a mano.
assert.equal(
  fechaDeHoyEn('America/Caracas', new Date('2028-02-29T15:00:00Z')).today_label,
  'martes 29 de febrero de 2028'
);

// =============================================================================
// 4. Y QUE VIAJE DE VERDAD EN EL PAYLOAD
// =============================================================================
//
// La función puede estar perfecta y no servir de nada si no llega a Hermes. Es el mismo
// fallo que el horario y el tono, que se guardaban en el panel y NUNCA viajaban: la
// pantalla decía «guardado» y era decorativa.

{
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  const inicio = fuente.indexOf('clinic_context: {');
  const bloque = fuente.slice(inicio, fuente.indexOf('signals: {', inicio));

  // ANCLADO AL PRINCIPIO DE LÍNEA: sin `^\s*` la comprobación pasa en verde con la línea
  // comentada, porque el texto sigue estando. Ya pasó una vez hoy.
  assert.ok(
    /^\s*\.\.\.fechaDeHoyEn\(/m.test(bloque) || /^\s*today:/m.test(bloque),
    'clinic_context no lleva la fecha de hoy: el modelo seguira fiandose del historial'
  );

  // Y CON LA ZONA DE LA CLÍNICA. Pasarle `undefined` o la del entorno haría que la fecha
  // fuera la del servidor, que es exactamente el fallo que esto viene a evitar.
  assert.ok(
    /fechaDeHoyEn\(contextoDeClinica\.zona\)/.test(bloque),
    'la fecha tiene que calcularse con la zona de ESTA clinica, no con la del servidor'
  );
}

console.log('fecha_de_hoy_test: OK');

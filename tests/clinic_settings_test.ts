import { readFileSync } from 'node:fs';
/**
 * Horario de la clínica, ventana de envío, modos, equipos, zona y tono.
 *
 * LO PRIMERO Y MÁS IMPORTANTE: QUE NO SE ESCRIBA A NADIE DORMIDO. El operador lo ha
 * pedido dos veces, así que no se comprueba con un caso: se recorren TODOS los
 * minutos de una semana y se exige que ni uno solo fuera de la ventana permita
 * escribir. Un caso de ejemplo demuestra que funciona una vez; el barrido completo
 * demuestra que no hay ningún hueco.
 *
 * Después, lo de siempre: que cada ajuste tenga EFECTO en el flujo y no solo se
 * guarde, que una clínica no le cambie los ajustes a otra, y que un valor imposible
 * no llegue nunca a producción.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.BUFFER_MS = '5000';
process.env.HELIOS_HANDOFF_STALE_HOURS = '5';
process.env.CLINIC_TIMEZONE = 'Europe/Madrid';
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' },
  '7': { tenant_id: 'fisio7', clinic_id: 'fisio', hermes_profile: 'fisio' }
});

const esquema = await import('../src/tenants/settings-schema.js');
const { sePuedeEscribir, calcularMomentoDeEnvio, VENTANA_POR_DEFECTO, momentoLocal } =
  await import('../src/leads/policy.js');
const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const settings = await import('../src/tenants/settings.js');

// =============================================================================
// NADIE RECIBE UN MENSAJE DE MADRUGADA
// =============================================================================

const ZONA = 'Europe/Madrid';
const horarioCOI = esquema.normalizarHorario({
  sun: [],
  mon: [['10:00', '20:00']], tue: [['10:00', '20:00']], wed: [['10:00', '20:00']],
  thu: [['10:00', '20:00']], fri: [['10:00', '20:00']],
  sat: [['10:00', '15:00']]
})!;
assert.ok(horarioCOI, 'el horario de ejemplo es válido');

const ventana = esquema.normalizarVentanaEnvio({ desde: '08:00', hasta: '22:00' })!;

// Una semana entera, minuto a minuto. Empieza un lunes a las 00:00 locales.
const LUNES = new Date('2026-08-17T00:00:00+02:00');
let permitidos = 0;
let dentroDeVentana = 0;

for (let minuto = 0; minuto < 7 * 24 * 60; minuto++) {
  const instante = new Date(LUNES.getTime() + minuto * 60_000);
  const { dia, minuto: minutoLocal } = momentoLocal(instante, ZONA);
  const puede = sePuedeEscribir(instante, ZONA, horarioCOI, ventana);

  if (puede) {
    permitidos++;
    // LA COMPROBACIÓN QUE IMPORTA: si se permite, es dentro de la ventana y en un
    // día que la clínica trabaja. Nunca de noche, nunca en domingo.
    assert.ok(
      minutoLocal >= ventana.desde && minutoLocal < ventana.hasta,
      `se permitió escribir a las ${Math.floor(minutoLocal / 60)}:${String(minutoLocal % 60).padStart(2, '0')}, fuera de la ventana`
    );
    assert.ok(dia !== 0, 'se permitió escribir en domingo');
  }
  if (dia !== 0 && minutoLocal >= ventana.desde && minutoLocal < ventana.hasta) dentroDeVentana++;
}

assert.equal(permitidos, dentroDeVentana, 'permite exactamente la ventana en días laborables');
assert.equal(permitidos, 6 * 14 * 60, 'seis días por catorce horas');

// Y las horas concretas que preocupan, dichas de forma legible.
const aLas = (dia: string, hora: string) => new Date(`2026-08-${dia}T${hora}:00+02:00`);
assert.equal(sePuedeEscribir(aLas('17', '03:00'), ZONA, horarioCOI, ventana), false, 'a las 3 de la madrugada NO');
assert.equal(sePuedeEscribir(aLas('17', '07:59'), ZONA, horarioCOI, ventana), false, 'a las 7:59 todavía no');
assert.equal(sePuedeEscribir(aLas('17', '08:00'), ZONA, horarioCOI, ventana), true, 'a las 8:00 sí, aunque la clínica abra a las 10');
assert.equal(sePuedeEscribir(aLas('17', '21:59'), ZONA, horarioCOI, ventana), true, 'a las 21:59 sí, aunque la clínica cerrara a las 20');
assert.equal(sePuedeEscribir(aLas('17', '22:00'), ZONA, horarioCOI, ventana), false, 'a las 22:00 ya no');
assert.equal(sePuedeEscribir(aLas('22', '11:00'), ZONA, horarioCOI, ventana), true, 'sábado por la mañana sí');
assert.equal(sePuedeEscribir(aLas('23', '11:00'), ZONA, horarioCOI, ventana), false, 'DOMINGO no, aunque sean las 11');

// Ninguna ventana puede colarse de madrugada, ni escrita a mano en la base.
for (const imposible of [
  { desde: '02:00', hasta: '06:00' },
  { desde: '00:00', hasta: '08:00' },
  { desde: '23:00', hasta: '23:30' },
  { desde: '22:00', hasta: '23:30' },
  { desde: '08:00', hasta: '08:30' },
  { desde: '20:00', hasta: '08:00' },
  { desde: '10:00', hasta: '10:00' }
]) {
  assert.equal(
    esquema.normalizarVentanaEnvio(imposible),
    null,
    `«${imposible.desde}-${imposible.hasta}» no puede aceptarse como ventana de envío`
  );
}
assert.deepEqual(esquema.normalizarVentanaEnvio({ desde: '09:00', hasta: '21:00' }), { desde: 540, hasta: 1260 });

// =============================================================================
// EL HORARIO SEMANAL
// =============================================================================

assert.equal(esquema.normalizarHorario({ mon: [['25:00', '26:00']] }), null, 'una hora que no existe');
assert.equal(esquema.normalizarHorario({ mon: [['20:00', '10:00']] }), null, 'cierra antes de abrir');
assert.equal(esquema.normalizarHorario({ mon: [['10:00', '10:00']] }), null, 'un tramo de cero minutos');
assert.equal(esquema.normalizarHorario({ mon: [['10:00']] }), null, 'un tramo incompleto');
assert.equal(esquema.normalizarHorario({ mon: '10:00-20:00' }), null, 'un día que no es lista');
assert.equal(esquema.normalizarHorario({}), null, 'los siete días cerrados no es un horario');
assert.equal(esquema.normalizarHorario(null), null);
assert.equal(esquema.normalizarHorario([]), null);

// Un solo día mal invalida el horario ENTERO. Descartar ese día en silencio
// significaría «cerrado el martes», y eso cambia a qué hora se escribe sin que
// nadie lo haya decidido.
assert.equal(
  esquema.normalizarHorario({ mon: [['10:00', '20:00']], tue: [['99:00', '20:00']] }),
  null,
  'un martes mal escrito no puede pasar como martes cerrado'
);

// Jornada partida, que es lo normal en una clínica dental.
const partido = esquema.normalizarHorario({ mon: [['09:00', '13:00'], ['16:00', '20:00']] })!;
assert.equal(partido[1].length, 2);
assert.equal(sePuedeEscribir(aLas('17', '14:00'), ZONA, partido, ventana), true,
  'la ventana de ENVÍO no se corta a mediodía: el día es laborable y son horas decentes');

// Ida y vuelta sin perder nada: lo que se guarda es lo que se lee.
assert.deepEqual(
  esquema.horarioParaGuardar(partido).mon,
  [['09:00', '13:00'], ['16:00', '20:00']]
);

// =============================================================================
// EFECTO: DOS CLÍNICAS, MISMO LEAD, MOMENTOS DISTINTOS
// =============================================================================

function baseDeDatos(filas: any[]) {
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  db.seed('helios_tenants', JSON.parse(JSON.stringify(filas)));
  __setSupabaseClientForTests(db as any);
  settings.__limpiarCacheAjustes();
  return db;
}

const db = baseDeDatos([
  {
    tenant_id: 'democoi1',
    clinic_hours: { mon: [['10:00', '20:00']], tue: [['10:00', '20:00']], sat: [['10:00', '15:00']], sun: [] },
    followup_window: { desde: '08:00', hasta: '22:00' }
  },
  {
    // Otra clínica que solo trabaja por la tarde y no quiere escribir antes de las 17.
    tenant_id: 'fisio7',
    clinic_hours: { mon: [['16:00', '21:00']], tue: [['16:00', '21:00']], sun: [] },
    followup_window: { desde: '17:00', hasta: '21:00' }
  }
]);

const coi = await settings.obtenerHorarioYVentana('democoi1');
const fisio = await settings.obtenerHorarioYVentana('fisio7');

// Un interés a las 09:00 del lunes. Plazo de WhatsApp: hasta las 08:00 del martes.
const interes = new Date('2026-08-17T09:00:00+02:00');

const momentoCOI = calcularMomentoDeEnvio(interes, { ...VENTANA_POR_DEFECTO, ...coi, envio: coi.envio });
assert.ok(momentoCOI, 'para COI existe un momento válido');
assert.equal(
  momentoLocal(momentoCOI!, coi.zona).minuto,
  8 * 60,
  'COI escribe a las 08:00 del martes: el primer minuto decente dentro del plazo'
);

const momentoFisio = calcularMomentoDeEnvio(interes, { ...VENTANA_POR_DEFECTO, ...fisio, envio: fisio.envio });
assert.equal(
  momentoFisio,
  null,
  'para la otra clínica NO hay momento válido: su ventana empieza a las 17:00 y el plazo vence a las 08:00'
);

// Y eso es lo correcto: antes de forzar un envío fuera de su ventana, no se manda.
// Estos casos se cuentan aparte, y si son muchos es cuando merece la pena tramitar
// una plantilla con Meta.

// EL SEGUIMIENTO ES DE OTRO DÍA. El mensaje dice literalmente «ayer preguntaste
// por una cita», así que un interés de las 09:00 no puede contestarse a las 21:00
// del mismo día por mucho que caiga dentro de la ventana y cumpla las 12 horas.
assert.ok(
  momentoCOI!.getTime() - interes.getTime() > 20 * 3600_000,
  'el momento elegido está al día siguiente, no esa misma tarde'
);

// --- La zona horaria surte efecto de verdad ---------------------------------
// Mismo instante, misma clínica, distinta zona: el reloj del paciente es otro, así
// que el momento elegido cambia. Se usa un interés de mediodía porque con el de las
// 09:00 la clínica canaria se queda SIN ningún momento válido -su ventana abre
// después de que venza el plazo de WhatsApp-, que es correcto pero no sirve para
// comparar.
const interesMediodia = new Date('2026-08-17T12:00:00+02:00');
const HORARIO_Y_VENTANA = {
  clinic_hours: { mon: [['10:00', '20:00']], tue: [['10:00', '20:00']] },
  followup_window: { desde: '08:00', hasta: '22:00' }
};

baseDeDatos([{ tenant_id: 'democoi1', ...HORARIO_Y_VENTANA, clinic_timezone: 'Europe/Madrid' }]);
const enMadrid = await settings.obtenerHorarioYVentana('democoi1');
const momentoMadrid = calcularMomentoDeEnvio(interesMediodia, { ...VENTANA_POR_DEFECTO, ...enMadrid });

baseDeDatos([{ tenant_id: 'democoi1', ...HORARIO_Y_VENTANA, clinic_timezone: 'Atlantic/Canary' }]);
const enCanarias = await settings.obtenerHorarioYVentana('democoi1');
assert.equal(enCanarias.zona, 'Atlantic/Canary');
const momentoCanarias = calcularMomentoDeEnvio(interesMediodia, { ...VENTANA_POR_DEFECTO, ...enCanarias });

assert.ok(momentoMadrid && momentoCanarias, 'las dos tienen momento válido');
assert.equal(momentoLocal(momentoMadrid!, 'Europe/Madrid').minuto, 8 * 60, 'Madrid escribe a sus 08:00');
assert.equal(momentoLocal(momentoCanarias!, 'Atlantic/Canary').minuto, 8 * 60, 'Canarias, a las suyas');
assert.equal(
  (momentoCanarias!.getTime() - momentoMadrid!.getTime()) / 3600_000,
  1,
  'y las 08:00 canarias caen una hora más tarde en tiempo real: la zona NO es decorativa'
);

// =============================================================================
// MODOS: OFF NO ES LO MISMO QUE OBSERVE
// =============================================================================

baseDeDatos([{ tenant_id: 'democoi1' }, { tenant_id: 'fisio7' }]);

// Sin nada elegido se DERIVA de las variables de entorno viejas, y un flag en false
// nunca significó «apagado»: significaba observación. Traducirlo a 'off' habría
// apagado en silencio la recogida de datos que lleva días acumulándose.
assert.equal(await settings.obtenerModoCsat('democoi1'), 'observe', 'por defecto, observación');
assert.equal(await settings.obtenerModoLeads('democoi1'), 'observe');

assert.equal((await settings.guardarAjustes('democoi1', { csat_mode: 'on', leads_mode: 'off' })).ok, true);
assert.equal(await settings.obtenerModoCsat('democoi1'), 'on');
assert.equal(await settings.obtenerModoLeads('democoi1'), 'off');
assert.equal(await settings.obtenerModoCsat('fisio7'), 'observe', 'la otra clínica no se ha enterado');
assert.equal(await settings.obtenerModoLeads('fisio7'), 'observe');

// Las mayúsculas sí se perdonan: es un descuido al teclear, no otro valor.
assert.equal(esquema.normalizarModo(' ON '), 'on');
assert.equal(esquema.normalizarModo('Observe'), 'observe');

// Lo que NO se perdona es un valor que parece decir lo mismo pero no está en la
// lista. «true» leído como 'on' encendería una función con datos de pacientes
// porque alguien escribió un booleano donde iba un modo.
for (const malo of ['encendido', 'true', 'false', '1', '0', 'apagado', 'observacion', '', null, undefined, 0, {}]) {
  const salida = await settings.guardarAjustes('democoi1', { csat_mode: malo });
  assert.equal(salida.ok, false, `«${String(malo)}» no es un modo`);
  assert.equal(salida.error, 'MODO_INVALIDO');
  assert.equal(salida.campo, 'csat_mode', 'y se dice QUÉ campo lo rechazó');
}
assert.equal(await settings.obtenerModoCsat('democoi1'), 'on', 'el valor bueno sigue en pie');

// =============================================================================
// EQUIPOS: SE MEZCLA POR DESTINO, NO TODO O NADA
// =============================================================================

baseDeDatos([{ tenant_id: 'democoi1', chatwoot_teams: { reception: '9' } }]);
const DEL_ENTORNO = { reception: '3', clinical_lead: '4', helios_support: '5' };
const mezclados = await settings.obtenerEquipos('democoi1', DEL_ENTORNO);
assert.deepEqual(
  mezclados,
  { reception: '9', clinical_lead: '4', helios_support: '5' },
  'el panel gana en recepción y los otros dos siguen viniendo del entorno'
);

// Si reemplazara el mapa entero, clinical_lead y helios_support se quedarían sin
// equipo, y un destino sin equipo es una derivación que no se asigna a nadie.
assert.equal(mezclados.helios_support, '5', 'soporte NO se queda sin equipo');

baseDeDatos([{ tenant_id: 'democoi1' }]);
assert.deepEqual(
  await settings.obtenerEquipos('democoi1', DEL_ENTORNO),
  DEL_ENTORNO,
  'sin nada en el panel, todo sale del entorno'
);

// Los IDs de Chatwoot son enteros. Uno con letras no da un error claro: da una
// asignación que no ocurre.
for (const malo of [{ reception: 'recepcion' }, { reception: '3a' }, { reception: -1 }, { reception: '3.5' }, {}, 'reception:3', []]) {
  assert.equal(esquema.normalizarEquipos(malo), null, `«${JSON.stringify(malo)}» no es un mapa de equipos`);
}
assert.deepEqual(esquema.normalizarEquipos({ reception: 3, otro: 'x' }), { reception: '3' },
  'un número se acepta y las claves desconocidas se ignoran');

// =============================================================================
// ZONA Y TONO
// =============================================================================

assert.equal(esquema.normalizarZona('Europe/Madrid'), 'Europe/Madrid');
assert.equal(esquema.normalizarZona('Atlantic/Canary'), 'Atlantic/Canary');
assert.equal(esquema.normalizarZona('America/Bogota'), 'America/Bogota');
// Una zona inválida mandaría TODOS los cálculos de hora al reloj del servidor: se
// escribiría a la gente a horas que nadie eligió.
for (const mala of ['Madrid', 'Europa/Madrid', 'GMT+2:00', '', null, 'no-existe/ninguna']) {
  assert.equal(esquema.normalizarZona(mala), null, `«${String(mala)}» no es una zona`);
}

assert.equal(esquema.normalizarTono('  Cercano   y   claro, de tú.  '), 'Cercano y claro, de tú.',
  'se limpian los espacios de sobra: esto viaja en cada turno');
assert.equal(esquema.normalizarTono(''), null);
assert.equal(esquema.normalizarTono('x'.repeat(esquema.MAX_LARGO_TONO)), 'x'.repeat(esquema.MAX_LARGO_TONO));
assert.equal(esquema.normalizarTono('x'.repeat(esquema.MAX_LARGO_TONO + 1)), null,
  'un tono larguísimo son tokens pagados en todos los mensajes de todos los pacientes');

// =============================================================================
// EL CONTEXTO QUE VIAJA A HERMES
// =============================================================================

baseDeDatos([{ tenant_id: 'democoi1' }]);
let contexto = await settings.leerContextoDeClinica('democoi1');
assert.equal(
  contexto.horario,
  null,
  'sin horario configurado NO se manda: mandar el de por defecto haría creer a Hermes que es el de verdad'
);
assert.equal(contexto.tono, null);
assert.equal(contexto.zona, 'Europe/Madrid', 'la zona sí va siempre: sin ella no puede razonar sobre horas');

baseDeDatos([{
  tenant_id: 'democoi1',
  clinic_hours: { mon: [['10:00', '20:00']], sun: [] },
  clinic_tone: 'Cercano, de tú, sin tecnicismos.'
}]);
contexto = await settings.leerContextoDeClinica('democoi1');
assert.deepEqual(contexto.horario!.mon, [['10:00', '20:00']], 'el horario va en horas legibles, no en minutos');
assert.deepEqual(contexto.horario!.sun, [], 'y los días cerrados se dicen explícitamente');
assert.equal(contexto.tono, 'Cercano, de tú, sin tecnicismos.');

// --- Que el orquestador LO USE, no solo que exista -------------------------
//
// EL FALLO QUE ESTO CUBRE, encontrado el 19-ago-2026: leerContextoDeClinica estaba
// escrita y probada, pero el orquestador construia clinic_context con
// config.CLINIC_TIMEZONE y config.CLINIC_TONE -las variables de ENTORNO- y el
// horario semanal no se mandaba en absoluto. O sea que la pantalla de Ajustes
// guardaba el horario, decia «guardado», y a Hermes le seguia llegando otra cosa.
// En multiclinica era peor: todas habrian recibido el horario y el tono de COI.
//
// Una funcion pura probada no demuestra nada si nadie la llama. Esto comprueba el
// cableado leyendo la fuente, que es la unica forma de verlo sin levantar medio
// sistema. Es tosco a proposito: prefiero una guarda fea que un fallo invisible.

{
  const fuente = readFileSync(
    new URL('../src/orchestrator.ts', import.meta.url),
    'utf8'
  );

  const bloqueContexto = fuente.slice(
    fuente.indexOf('clinic_context: {'),
    fuente.indexOf('signals: {', fuente.indexOf('clinic_context: {'))
  );
  assert.ok(bloqueContexto.length > 0, 'no se encuentra el bloque clinic_context del payload');

  assert.ok(
    !/timezone:\s*config\.CLINIC_TIMEZONE/.test(bloqueContexto),
    'la zona horaria de clinic_context NO puede salir de la variable de entorno: '
    + 'cada clinica tiene la suya y el panel la guarda'
  );
  assert.ok(
    !/tone:\s*config\.CLINIC_TONE\s*\|\|\s*"es-ES"\s*,/.test(bloqueContexto),
    'el tono de clinic_context NO puede salir solo de la variable de entorno'
  );
  assert.ok(
    /contextoDeClinica/.test(bloqueContexto),
    'clinic_context tiene que construirse con los ajustes de la clinica'
  );
  assert.ok(
    /clinic_hours/.test(bloqueContexto),
    'el horario semanal tiene que viajar a Hermes; si no, el panel es decorativo'
  );
  assert.ok(
    /leerContextoDeClinica\(tenantId\)/.test(fuente),
    'el orquestador tiene que LLAMAR a leerContextoDeClinica, no solo importarla'
  );
}

console.log('clinic_settings_test: PASS');
console.log('  minutos de la semana en que se puede escribir: ' + permitidos + ' de ' + 7 * 24 * 60);

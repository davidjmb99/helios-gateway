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
  const puede = sePuedeEscribir(instante, ZONA, ventana);

  if (puede) {
    permitidos++;
    // LA COMPROBACIÓN QUE IMPORTA: si se permite, es dentro de la ventana. NUNCA DE
    // NOCHE, ningún día. Lo que ya no se exige es que la clínica abra: escribir un
    // mensaje no es atender, y el bot atiende todos los días.
    assert.ok(
      minutoLocal >= ventana.desde && minutoLocal < ventana.hasta,
      `se permitió escribir a las ${Math.floor(minutoLocal / 60)}:${String(minutoLocal % 60).padStart(2, '0')}, fuera de la ventana`
    );
  }
  if (minutoLocal >= ventana.desde && minutoLocal < ventana.hasta) dentroDeVentana++;
}

assert.equal(permitidos, dentroDeVentana, 'permite exactamente la ventana, todos los días');
assert.equal(permitidos, 7 * 14 * 60, 'siete días por catorce horas: el domingo cuenta');

// Y las horas concretas que preocupan, dichas de forma legible.
const aLas = (dia: string, hora: string) => new Date(`2026-08-${dia}T${hora}:00+02:00`);
assert.equal(sePuedeEscribir(aLas('17', '03:00'), ZONA, ventana), false, 'a las 3 de la madrugada NO');
assert.equal(sePuedeEscribir(aLas('17', '07:59'), ZONA, ventana), false, 'a las 7:59 todavía no');
assert.equal(sePuedeEscribir(aLas('17', '08:00'), ZONA, ventana), true, 'a las 8:00 sí, aunque la clínica abra a las 10');
assert.equal(sePuedeEscribir(aLas('17', '21:59'), ZONA, ventana), true, 'a las 21:59 sí, aunque la clínica cerrara a las 20');
assert.equal(sePuedeEscribir(aLas('17', '22:00'), ZONA, ventana), false, 'a las 22:00 ya no');
assert.equal(sePuedeEscribir(aLas('22', '11:00'), ZONA, ventana), true, 'sábado por la mañana sí');
// EL DOMINGO SI SE PUEDE ESCRIBIR, y es un cambio del 28-ago-2026.
//
// Antes se exigia que el dia fuera laborable para la clinica, y eso dejaba SIN SEGUIMIENTO
// TODO LO QUE PASABA EN SABADO: el interes cumple las 12 horas ese mismo sabado -mismo dia,
// se salta-, el domingo entero quedaba descartado, y el plazo de 23 horas de WhatsApp vencia
// antes del lunes. Una sexta parte de la semana, en silencio.
//
// David: «el bot si puede atender ese dia, por si alguien escribe, y hacer seguimiento
// tambien». El bot atiende todos los dias; la clinica no abre todos. Son dos cosas.
assert.equal(
  sePuedeEscribir(aLas('23', '11:00'), ZONA, ventana), true,
  'el DOMINGO se puede escribir: el bot atiende todos los dias aunque la clinica no abra'
);
assert.equal(
  sePuedeEscribir(aLas('23', '03:00'), ZONA, ventana), false,
  'pero el domingo de madrugada tampoco: la hora sigue mandando'
);

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

// LA VENTANA DE ENVÍO NO SE CORTA A MEDIODÍA aunque la clínica cierre para comer. Son dos
// cosas distintas: escribir un mensaje no es atender. Desde el 28-ago el horario de la
// clínica ya no interviene aquí en absoluto —ni los días ni las horas—; solo manda la
// ventana de envío, que es la que dice a qué horas es decente escribirle a alguien.
assert.equal(sePuedeEscribir(aLas('17', '14:00'), ZONA, ventana), true,
  'a las 2 de la tarde se escribe, aunque la clínica esté cerrada para comer');

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

// --- La zona horaria se elige de una lista, no se escribe -------------------
//
// Con el cambio a Venezuela esto deja de ser comodidad y pasa a ser correccion. Una
// zona mal escrita no la acepta normalizarZona y el ajuste no se guarda; una bien
// escrita pero equivocada -Europe/Madrid con la clinica en Caracas- desplaza SEIS
// HORAS todo lo que Helios dice de horarios, y ademas descuadra con Cal.com.

{
  const panel = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.ok(
    !/<input[^>]*id="clinica-zona"/.test(panel),
    'la zona horaria no puede ser un campo de texto libre: se escribe mal y no se guarda'
  );
  assert.ok(
    /<select[^>]*id="clinica-zona"/.test(panel),
    'la zona horaria tiene que elegirse de una lista'
  );
  for (const zona of ['America/Caracas', 'Europe/Madrid', 'America/Bogota']) {
    assert.ok(
      panel.includes('value="' + zona + '"'),
      'falta ' + zona + ' en la lista de zonas horarias'
    );
  }
  // Y todas las de la lista tienen que ser zonas IANA de verdad: si una no lo es,
  // normalizarZona la rechaza y el ajuste se pierde sin decir por que.
  const zonas = [...panel.matchAll(/<option value="([A-Za-z]+\/[A-Za-z_\/]+)"/g)].map(m => m[1]);
  assert.ok(zonas.length >= 20, 'la lista de zonas parece truncada: ' + zonas.length);
  for (const zona of zonas) {
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat('en-US', { timeZone: zona }),
      'la lista ofrece una zona que no existe: ' + zona
    );
  }
}

console.log('clinic_settings_test: PASS');
console.log('  minutos de la semana en que se puede escribir: ' + permitidos + ' de ' + 7 * 24 * 60);

// --- LA DIRECCION VIAJA COMO DATO, NO COMO INSTRUCCION ----------------------
//
// EL FALLO, con hora exacta. El 20-ago-2026 se escribio la direccion en el perfil de
// Hermes -«La clinica esta en Acarigua, CC Mamanico, local 27»-, se verifico el hash,
// David reinicio, y desde una conversacion NUEVA el modelo se nego a decirla:
//
//   21:30  «¿donde estan ubicados?»
//          «No quiero darte una direccion DE MEMORIA por si no es exacta. Te voy a
//           conectar con una persona del equipo.»
//
//   21:36  «¿cual es el horario de atencion?»
//          «De lunes a viernes de 10:00am a 8:00pm y los sabados de 10:00am a 3:00pm.»
//
// Seis minutos de diferencia, las dos preguntas generales, las dos en el prompt. El
// horario lo contesta y la direccion no, y la razon es EL CANAL: el horario llega en
// clinic_context dentro de la peticion, la direccion estaba escrita en el prompt. Lo
// que viene en la peticion lo trata como dato; lo que esta en el prompt, como un
// recuerdo del que el SOUL entero le enseña a desconfiar. Y bien que le enseña: es
// lo que evita que invente citas.
//
// Asi que la direccion se manda por donde va el horario.

{
  const { normalizarDireccion, MAX_LARGO_DIRECCION } = esquema;

  // Texto libre, limpiando espacios como el tono.
  assert.equal(normalizarDireccion('  Acarigua,   CC Mamanico   local 27  '), 'Acarigua, CC Mamanico local 27');
  assert.equal(normalizarDireccion('Acarigua, CC Mamánico local 27. Tiene estacionamiento.'),
    'Acarigua, CC Mamánico local 27. Tiene estacionamiento.');

  // VACIO ES NULL, NO CADENA VACIA. Una direccion en blanco que se guardara como ''
  // se mandaria a Hermes como un campo presente y vacio, y eso es peor que no
  // mandarlo: parece un dato confirmado que no dice nada.
  assert.equal(normalizarDireccion(''), null);
  assert.equal(normalizarDireccion('   '), null);
  assert.equal(normalizarDireccion(null), null);
  assert.equal(normalizarDireccion(undefined), null);

  // Se rechaza en vez de recortar: media direccion es una direccion equivocada, y
  // recortar en silencio mandaria al paciente a otro sitio.
  assert.equal(normalizarDireccion('x'.repeat(MAX_LARGO_DIRECCION)), 'x'.repeat(MAX_LARGO_DIRECCION));
  assert.equal(normalizarDireccion('x'.repeat(MAX_LARGO_DIRECCION + 1)), null,
    'una direccion demasiado larga se rechaza entera, no se recorta');
}

{
  // NO HAY DIRECCION POR DEFECTO, y esto es lo que impide el fallo de Madrid.
  //
  // Si hubiera un valor de siempre, TODAS las clinicas recibirian el de COI en
  // cuanto se provisione la segunda -exactamente lo que paso con el horario y el
  // tono antes de que fueran por clinica-. Un paciente de otra ciudad se plantaria
  // en Acarigua.
  const defectos = await settings.leerAjustes('clinica-sin-nada');
  assert.equal(defectos.clinic_address, null, 'sin configurar no puede haber direccion');
}

{
  // Y EL CABLEADO, que es donde estaba el fallo de verdad: no basta con guardarla,
  // tiene que LLEGAR en el contexto del turno. Si esta prueba no existiera, se podria
  // guardar la direccion en el panel y seguir sin que Hermes la viera nunca.
  const fuente = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  const bloque = fuente.slice(fuente.indexOf('clinic_context: {'), fuente.indexOf('clinic_context: {') + 2000);
  assert.ok(
    /clinic_address:\s*contextoDeClinica\.direccion/.test(bloque),
    'clinic_context no lleva clinic_address: la direccion se guardaria y Hermes no la veria'
  );
  assert.ok(
    /contextoDeClinica\.direccion\s*\?/.test(bloque),
    'la direccion tiene que mandarse SOLO si esta configurada; un campo vacio parece un dato confirmado'
  );
}

console.log('clinic_settings_test: direccion OK');

// --- LA PRIMERA VISITA LA DECIDE LA CLINICA, NO EL CODIGO ------------------
//
// ESTUVO CABLEADO A `true` EN EL ORQUESTADOR para todas las cuentas, asi que Helios
// llevaba semanas cerrando mensajes con «le recuerdo que su primera visita es gratuita»
// sin que nadie lo hubiera confirmado.
//
// Y NO ERA CIERTO NI PARA COI, la clinica para la que se escribio. Lo dijo David el
// 25-ago-2026: «quitaremos lo de la primera valoracion gratuita, porque en Venezuela casi
// no se ve eso».
//
// Es el mismo fallo que «Acarigua» escrito en el SOUL (HEL-085): un dato de UNA clinica
// puesto en un sitio que sirve a TODAS.

{
  const { normalizarPrimeraVisita } = esquema;

  // EL DEFECTO ES `false`, y es la comprobacion que mas importa de este bloque. Los dos
  // fallos posibles no cuestan lo mismo: prometer algo gratis que luego se cobra es una
  // discusion con el paciente en el mostrador, con Helios de testigo por escrito; no
  // prometer algo que si es gratis se arregla hablando en la misma llamada.
  assert.equal(
    normalizarPrimeraVisita(undefined), false,
    'sin configurar NO es gratis: el defecto cae del lado del fallo que se arregla hablando'
  );
  assert.equal(normalizarPrimeraVisita(null), false);
  assert.equal(normalizarPrimeraVisita(''), false);

  // Y cualquier cosa rara tambien cae en false, no en true.
  for (const raro of ['si', 'yes', 'gratis', 'SI', {}, [], 'false', 0, '0', -1, NaN]) {
    assert.equal(
      normalizarPrimeraVisita(raro), false,
      `${JSON.stringify(raro)}: solo un si explicito activa una promesa que cuesta dinero`
    );
  }

  // Lo que SI la activa, en las formas en que puede llegar de un formulario o del JSON.
  for (const si of [true, 'true', 1, '1']) {
    assert.equal(normalizarPrimeraVisita(si), true, `${JSON.stringify(si)} activa la promesa`);
  }
}

{
  // Y LA COSTURA, que es donde vivia el fallo: un `first_visit_free: true` escrito a mano
  // en el orquestador. Las comprobaciones de arriba prueban el normalizador; esta prueba
  // que el orquestador USA el ajuste y no una constante.
  //
  // Es una comprobacion sobre el texto del archivo, y eso es debil -no ejecuta nada- pero
  // la alternativa era montar el orquestador entero con Supabase de mentira para
  // comprobar una linea. Queda anotado: si algun dia hay una prueba que ejecute
  // processBufferEvent de verdad, esta se cambia por una de esas.
  const orquestador = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');

  assert.match(
    orquestador, /first_visit_free:\s*contextoDeClinica\.primeraVisitaGratis/,
    'el orquestador tiene que leer el ajuste de la clinica'
  );
  assert.doesNotMatch(
    orquestador, /first_visit_free:\s*(true|false)/,
    'y NO puede quedar ningun valor fijo: es un dato de cada clinica, y cableado a `true` ' +
    'hizo que Helios prometiera visitas gratis durante semanas sin que nadie lo confirmara'
  );

  // Y la rama de fallo -cuando no se pueden leer los ajustes- tambien tiene que decir que
  // NO. Sin saberlo, no se promete nada gratis.
  assert.match(
    orquestador, /primeraVisitaGratis:\s*false/,
    'si los ajustes no se pueden leer, no es gratis: no sabriamos ni por que se prometio'
  );
}

// --- SERVICIOS Y PRECIOS, CON LOS OTROS NOMBRES ---------------------------
//
// LO PIDIO DAVID: «el agente debe saber los otros terminos a cada uno de esos servicios».
// Y es la mitad que de verdad importa: un paciente en Venezuela no pide una «exodoncia
// simple», dice que le van a SACAR LA MUELA. Sin los sinonimos el precio esta en el
// sistema y el paciente no lo alcanza, que es igual de inutil que no tenerlo.
//
// Lo que se protege, por orden de daño:
//
//  1. QUE UNA LISTA A MEDIAS NO SE GUARDE. Si una sola linea no se entiende, no se guarda
//     NINGUNA. La clinica creeria que puso doce precios y Helios sabria seis, y nadie se
//     enteraria hasta que un paciente preguntara por el que falta.
//
//  2. QUE SIN PRECIOS NO SE MANDE NADA. Un precio inventado acaba en una discusion en el
//     mostrador con Helios de testigo por escrito.
//
//  3. Que el precio admita rangos y frases. «150$ a 250$ por unidad» es un precio real.

{
  const { normalizarServicios, serviciosDeTexto, leerLineaDeServicio } = esquema;

  // El caso real de COI, tal como lo va a pegar David.
  const listaDeCoi = [
    'Consulta de valoración: 20$ (consulta, valoración, revisión, chequeo)',
    'Exodoncia simple: 30$ (extracción, sacar una muela, sacar un diente)',
    'Cirugía de cordal: 100$ por diente (cordales, muela del juicio)',
    'Implantología: 150$ a 250$ por unidad (implante, poner un diente, tornillo)'
  ].join('\n');

  const guardado = normalizarServicios(listaDeCoi);
  assert.ok(guardado, 'la lista de COI se guarda');

  const leidos = serviciosDeTexto(guardado);
  assert.equal(leidos.length, 4);

  // 3. EL PRECIO ES TEXTO LIBRE. Forzar un numero obligaria a la clinica a mentir o a
  // dejarlo vacio: un rango, un «desde» y un «por diente» son respuestas legitimas.
  assert.equal(leidos[2].precio, '100$ por diente');
  assert.equal(leidos[3].precio, '150$ a 250$ por unidad', 'un rango con frase detras');

  // LOS OTROS NOMBRES, que es lo que hace que el paciente alcance el precio.
  assert.deepEqual(
    leidos[1].tambien, ['extracción', 'sacar una muela', 'sacar un diente'],
    'los otros nombres se separan por comas y van en minusculas'
  );
  assert.ok(
    leidos[1].tambien.includes('sacar una muela'),
    'LO QUE DE VERDAD DICE UN PACIENTE tiene que estar ahi'
  );
}

{
  const { normalizarServicios } = esquema;

  // 1. UNA LINEA MALA TIRA LA LISTA ENTERA. Es deliberado y es lo contrario de lo
  // permisivo: guardar la mitad entendida es el fallo que no se ve.
  const conUnaMala = [
    'Higiene dental completa: 25$ (limpieza, sarro)',
    'esta linea no tiene el formato y no hay forma de leerla',
    'Blanqueamiento: 60$ (blanquear los dientes)'
  ].join('\n');
  assert.equal(
    normalizarServicios(conUnaMala), null,
    'con una sola linea ilegible NO se guarda ninguna: la clinica creeria tener tres ' +
    'precios y Helios sabria dos'
  );

  // 2. SIN NADA, NADA. No se guarda una lista vacia ni de espacios.
  assert.equal(normalizarServicios(''), null);
  assert.equal(normalizarServicios('   \n  \n '), null);
  assert.equal(normalizarServicios(null), null);
  assert.equal(normalizarServicios(undefined), null);

  // Los topes: 40 servicios y 4000 caracteres.
  const demasiados = Array.from({ length: 41 }, (_, i) => `Servicio ${i}: 10$`).join('\n');
  assert.equal(normalizarServicios(demasiados), null, 'mas de 40 servicios no se guarda');
  assert.equal(
    normalizarServicios('Servicio: ' + 'x'.repeat(4100)), null,
    'y tampoco un texto de 4000 caracteres para arriba'
  );

  // Un servicio SIN otros nombres es valido: el parentesis es opcional.
  const sinSinonimos = normalizarServicios('Radiografía panorámica: 15$');
  assert.ok(sinSinonimos, 'el parentesis de los otros nombres es opcional');
}

{
  const { leerLineaDeServicio } = esquema;

  // Un nombre sin precio no vale: seria un servicio del que Helios no sabe decir nada.
  assert.equal(leerLineaDeServicio('Blanqueamiento'), null, 'sin precio no es un servicio');
  assert.equal(leerLineaDeServicio('Blanqueamiento:'), null, 'ni con los dos puntos vacios');
  assert.equal(leerLineaDeServicio(': 60$'), null, 'ni un precio sin nombre');

  // Y los nombres larguisimos se rechazan en vez de recortarse: recortar un nombre de
  // servicio a mitad de palabra es peor que decir que la linea esta mal.
  assert.equal(leerLineaDeServicio('X'.repeat(90) + ': 10$'), null);
  assert.equal(leerLineaDeServicio('Blanqueamiento: ' + '9'.repeat(90)), null);
}

{
  // Y LA COSTURA. Sin servicios configurados el campo NO se manda, igual que la
  // direccion: un `services: []` en clinic_context es distinto de que el campo no exista.
  // Lo primero le dice a Hermes «esta clinica no tiene servicios», que es falso; lo
  // segundo, «no lo se», que es la verdad y le hace derivar.
  const orquestador = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');

  assert.match(
    orquestador, /servicios\.length > 0[\s\S]{0,120}?services: contextoDeClinica\.servicios/,
    'los servicios solo se mandan si la clinica los configuro'
  );
  assert.doesNotMatch(
    orquestador, /^\s*services: contextoDeClinica\.servicios,/m,
    'y NO incondicionalmente: una lista vacia le dice a Hermes que la clinica no tiene ' +
    'servicios, que es falso, en vez de que no lo sabemos'
  );

  // La rama de fallo -sin poder leer los ajustes- tambien va vacia: antes de inventar un
  // precio, derivar.
  assert.match(
    orquestador, /servicios: \[\]/,
    'si los ajustes no se pueden leer, no hay precios: Helios deriva antes que inventar'
  );
}

console.log('clinic_settings_test: servicios y precios OK');

console.log('clinic_settings_test: primera visita OK');

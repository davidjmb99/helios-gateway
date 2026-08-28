/**
 * La agenda servida como MCP, que es como Hermes la va a llamar.
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE NO SE RESERVE UNA HORA QUE YA NO ESTÁ LIBRE. Entre ofrecer y confirmar pasan
 *     minutos, y en esos minutos alguien puede reservar por teléfono. La oferta era una
 *     propuesta; la reserva es lo que no se puede deshacer. Se vuelve a comprobar.
 *
 *  2. QUE NO SE RESERVE CON UN DOCTOR QUE NADIE ELIGIÓ. Con dos doctoras Ana, elegir una
 *     manda al paciente con la que no era. Se devuelve la duda para que Helios pregunte.
 *
 *  3. QUE UNA FECHA QUE NO SE ENTIENDE NO SE IGNORE. Seguir sin ella contestaría por el
 *     jueves a quien preguntó por el martes, y el modelo no sabría que su pregunta se
 *     perdió por el camino.
 *
 *  4. Que un fallo llegue como resultado de herramienta y no como error de protocolo: lo
 *     primero lo lee el modelo y deriva; lo segundo le corta la conversación al cliente.
 *
 *  5. Que las notificaciones no se contesten. Responder a un mensaje sin `id` rompe a
 *     algunos clientes MCP, y `notifications/initialized` llega en cada arranque.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
const { atenderMcp, NOMBRES_DE_HERRAMIENTA } = await import('../src/agenda/mcp.js');
const { leerDoctores } = await import('../src/agenda/doctores.js');
const { olvidarTokens } = await import('../src/agenda/google.js');

const J = [{ desde: 600, hasta: 1200 }];
const HORARIO = { 0: [], 1: J, 2: J, 3: J, 4: J, 5: J, 6: J } as any;
const ZONA = 'America/Caracas';
/** Lunes 7 de septiembre de 2026, 10:00 en Caracas. */
const AHORA = new Date('2026-09-07T14:00:00Z');

const DOCTORES = leerDoctores(`
Dra. Ana Martínez
  calendario: c-ana@g.com
  hace: valoración, higiene
Dra. María López
  calendario: c-maria@g.com
  hace: valoración, higiene
`, HORARIO)!;

const CLAVE = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CRED = { correo: 'a@b.c', clave: CLAVE };

const CTX = {
  tenantId: 'democoi1', doctores: DOCTORES, cierresTexto: null,
  horario: HORARIO, zona: ZONA, ahora: AHORA
};

/**
 * Google de mentira. `ocupado` es lo que tiene cogido cada calendario; `respuestas` son las
 * de escritura, en orden, para create/patch/delete.
 */
function google(ocupado: Record<string, Array<[string, string]>>, escrituras: any[] = []) {
  const llamadas: Array<{ url: string; metodo: string; cuerpo: any }> = [];
  let escritas = 0;
  const impl = (async (url: any, o: any = {}) => {
    const u = String(url);
    let cuerpo = o.body;
    if (typeof cuerpo === 'string' && cuerpo.startsWith('{')) { try { cuerpo = JSON.parse(cuerpo); } catch {} }
    llamadas.push({ url: u, metodo: o.method || 'GET', cuerpo });

    if (u.includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }), text: async () => '' } as any;
    }
    if (u.includes('freeBusy')) {
      const calendars: any = {};
      for (const [id, f] of Object.entries(ocupado)) calendars[id] = { busy: f.map(([s, e]) => ({ start: s, end: e })) };
      return { ok: true, status: 200, json: async () => ({ calendars }), text: async () => '' } as any;
    }
    const r = escrituras[escritas++] ?? { ok: true, cuerpo: { id: 'ev-1' } };
    return {
      ok: r.ok !== false, status: r.status ?? 200,
      json: async () => r.cuerpo ?? {}, text: async () => ''
    } as any;
  }) as unknown as typeof fetch;
  return { impl, llamadas };
}

const LIBRES = { 'c-ana@g.com': [], 'c-maria@g.com': [] } as Record<string, Array<[string, string]>>;
const deps = (impl: typeof fetch) => ({ fetchImpl: impl, credenciales: CRED, ahora: AHORA });
const llamar = (nombre: string, args: any, impl: typeof fetch, ctx: any = CTX) =>
  atenderMcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: nombre, arguments: args } }, ctx, deps(impl));
const leer = (r: any) => JSON.parse(r.result.content[0].text);

// --- EL APRETÓN DE MANOS Y LA LISTA ---------------------------------------

{
  const { impl } = google(LIBRES);
  const init: any = await atenderMcp(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    CTX, deps(impl)
  );
  // SE DEVUELVE LA VERSIÓN QUE PIDE EL CLIENTE si se sabe hablar. Imponer la nuestra hace
  // que un cliente más viejo se caiga en el saludo, antes de llegar a ninguna herramienta.
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'helios-agenda');

  const desconocida: any = await atenderMcp(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    CTX, deps(impl)
  );
  assert.equal(desconocida.result.protocolVersion, '2025-06-18', 'si no la conocemos, la nuestra');

  const lista: any = await atenderMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, CTX, deps(impl));
  assert.deepEqual(
    lista.result.tools.map((t: any) => t.name),
    ['get_available_slots', 'create_booking', 'reschedule_booking', 'cancel_booking'],
    'LOS MISMOS NOMBRES QUE CAL.COM: el cambio en el perfil es un buscar-y-reemplazar'
  );
  assert.deepEqual(NOMBRES_DE_HERRAMIENTA, lista.result.tools.map((t: any) => t.name));

  // Las descripciones van cortas: viajan en CADA llamada al modelo, no una por conversación.
  for (const t of lista.result.tools) {
    assert.ok(t.description.length < 220, `«${t.name}» tiene una descripción demasiado larga`);
    assert.ok(t.inputSchema?.type === 'object');
  }
}

// --- 5. LAS NOTIFICACIONES NO SE CONTESTAN --------------------------------

{
  const { impl } = google(LIBRES);
  assert.equal(
    await atenderMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, CTX, deps(impl)),
    null,
    'responder a un mensaje sin id rompe a algunos clientes'
  );
  assert.equal(await atenderMcp({ jsonrpc: '2.0', method: 'notifications/cancelled' }, CTX, deps(impl)), null);

  // NI SIQUIERA SI UN CLIENTE LE PONE `id` POR ERROR. Una notificación no lo lleva nunca,
  // así que un `notifications/…` con id es un cliente mal escrito — y contestarle es
  // exactamente lo que le va a romper. Esta línea es la que distingue las dos guardas:
  // sin la que mira el nombre del método, esto caería en «method not found».
  assert.equal(
    await atenderMcp({ jsonrpc: '2.0', id: 5, method: 'notifications/initialized' }, CTX, deps(impl)),
    null,
    'una notificación no se contesta ni con id'
  );
  // Un método desconocido CON id sí se contesta, con el error que manda el estándar.
  const r: any = await atenderMcp({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, CTX, deps(impl));
  assert.equal(r.error.code, -32601);
}

// --- CONSULTAR: LA FORMA DE LA FRASE --------------------------------------

{
  olvidarTokens();
  const { impl } = google({ ...LIBRES, 'c-ana@g.com': [['2026-09-07T18:00:00Z', '2026-09-07T19:00:00Z']] });
  const r: any = await llamar('get_available_slots', { doctor: 'Ana', cuando: '2026-09-07T14:00' }, impl);
  const d = leer(r);

  assert.equal(r.result.isError, false);
  assert.equal(d.pedido.libre, false);
  assert.ok(d.mismaHora.some((n: string) => n.includes('María')), 'quién más puede a esa hora');
  assert.ok(d.otras.length > 0, 'y otras horas de Ana');
}

// --- 3. UNA FECHA QUE NO SE ENTIENDE NO SE IGNORA -------------------------

{
  olvidarTokens();
  const { impl, llamadas } = google(LIBRES);
  const r: any = await llamar('get_available_slots', { doctor: 'Ana', cuando: 'mañana a las 2' }, impl);
  assert.equal(r.result.isError, true, 'se dice que no se entendió');
  assert.ok(leer(r).error.includes('no_entiendo_la_fecha'));
  assert.equal(llamadas.length, 0, 'y no se contesta por otro día como si nada');
}

{
  // Y LA HORA SIN HUSO ES HORA DE LA CLÍNICA. El contenedor corre en UTC: interpretarla
  // allí daría una cita cuatro horas antes en Caracas, sin error y sin aviso.
  olvidarTokens();
  const { impl } = google({ ...LIBRES, 'c-ana@g.com': [['2026-09-07T18:00:00Z', '2026-09-07T19:00:00Z']] });
  const r: any = await llamar('get_available_slots', { doctor: 'Ana', cuando: '2026-09-07T14:00' }, impl);
  assert.equal(leer(r).pedido.libre, false, 'las 14:00 de Caracas son las 18:00Z, y ahí está ocupada');

  olvidarTokens();
  const { impl: impl2 } = google({ ...LIBRES, 'c-ana@g.com': [['2026-09-07T14:00:00Z', '2026-09-07T15:00:00Z']] });
  const r2: any = await llamar('get_available_slots', { doctor: 'Ana', cuando: '2026-09-07T14:00' }, impl2);
  assert.equal(leer(r2).pedido.libre, true, 'ocupada a las 14:00Z NO es ocupada a las 14:00 de Caracas');
}

// --- RESERVAR ------------------------------------------------------------

{
  olvidarTokens();
  const { impl, llamadas } = google(LIBRES, [{ ok: true, cuerpo: { id: 'ev-abc' } }]);
  const r: any = await llamar('create_booking', {
    doctor: 'Martínez', cuando: '2026-09-07T14:00', paciente: 'María Pérez',
    servicio: 'higiene', telefono: '+58 412 000 0000'
  }, impl);

  const d = leer(r);
  assert.equal(r.result.isError, false);

  // LA MISMA FORMA QUE DEVOLVIA CAL.COM, campo por campo. El SOUL esta escrito contra este
  // contrato -lineas 21, 102, 110 y 125- y probado con pacientes de verdad. La herramienta
  // nueva habla como la que sustituye; asi el prompt no se toca.
  assert.equal(d.ok, true);
  assert.ok(d.booking_uid, 'booking_uid, que es lo que el SOUL guarda en booking_patch');
  assert.equal(d.start_time, '2026-09-07T18:00:00.000Z', 'start_time, el confirmado');
  assert.equal(d.status, 'confirmed', 'nunca «accepted»: el SOUL solo admite tres valores');
  assert.equal(d.doctor, 'Dra. Ana Martínez');

  // Y NO SE DEVUELVEN LOS DOS DATOS SUELTOS. El calendario va DENTRO del uid: para el SOUL
  // sigue siendo una cadena que guarda y devuelve, igual que la de Cal.com.
  assert.equal(d.cita_id, undefined);
  assert.equal(d.calendario, undefined);
  const dentro = Buffer.from(d.booking_uid, 'base64url').toString('utf8');
  assert.equal(dentro, 'c-ana@g.com|ev-abc', 'el uid lleva calendario y evento');

  const creacion = llamadas.find(l => l.metodo === 'POST' && l.url.includes('/events'))!;
  assert.ok(creacion, 'se creó el evento');
  assert.equal(creacion.cuerpo.start.dateTime, '2026-09-07T18:00:00.000Z', 'las 2 de la tarde EN CARACAS');
  assert.ok(creacion.cuerpo.summary.includes('María Pérez'));
  assert.ok(creacion.cuerpo.description.includes('+58 412 000 0000'), 'el teléfono, para poder llamarle');
  assert.equal(creacion.cuerpo.attendees, undefined, 'sin asistentes: una cuenta de servicio no puede invitar');
  assert.ok(creacion.cuerpo.id, 'con id propio, para que un reintento no doble la cita');
}

// --- 1. NO SE RESERVA UNA HORA QUE YA NO ESTÁ LIBRE -----------------------

{
  olvidarTokens();
  // Alguien reservó por teléfono entre que se ofreció la hora y el paciente dijo que sí.
  const { impl, llamadas } = google({ ...LIBRES, 'c-ana@g.com': [['2026-09-07T18:00:00Z', '2026-09-07T19:00:00Z']] });
  const r: any = await llamar('create_booking', {
    doctor: 'Martínez', cuando: '2026-09-07T14:00', paciente: 'María Pérez'
  }, impl);

  assert.equal(r.result.isError, true);
  assert.ok(leer(r).error.startsWith('esa_hora_ya_no_esta_libre'), 'se dice, y no se reserva');
  // Y SE DICE QUIÉN SÍ PUEDE, para que la conversación siga en vez de morirse.
  assert.ok(leer(r).error.includes('María'), 'con quién sí puede a esa hora');
  assert.equal(
    llamadas.filter(l => l.metodo === 'POST' && l.url.includes('/events')).length, 0,
    'NO se creó ningún evento'
  );
}

// --- 2. NO SE RESERVA CON UN DOCTOR QUE NADIE ELIGIÓ ----------------------

{
  olvidarTokens();
  const DOS_ANAS = leerDoctores(
    'Dra. Ana Martínez\n  calendario: c1@g.com\nDra. Ana López\n  calendario: c2@g.com', HORARIO
  )!;
  const { impl, llamadas } = google({ 'c1@g.com': [], 'c2@g.com': [] });
  const r: any = await llamar(
    'create_booking', { doctor: 'Ana', cuando: '2026-09-07T14:00', paciente: 'X' },
    impl, { ...CTX, doctores: DOS_ANAS }
  );

  assert.equal(r.result.isError, true);
  const e = leer(r).error;
  assert.ok(e.startsWith('varios_doctores_se_llaman_asi'), 'se devuelve la duda para preguntar');
  assert.ok(e.includes('Martínez') && e.includes('López'), 'con los dos apellidos');
  assert.equal(llamadas.length, 0, 'y no se toca Google para nada');

  // Un doctor que no trabaja allí tampoco se aproxima al más parecido.
  olvidarTokens();
  const { impl: i2 } = google(LIBRES);
  const r2: any = await llamar('create_booking', { doctor: 'Pérez', cuando: '2026-09-07T14:00', paciente: 'X' }, i2);
  assert.equal(leer(r2).error, 'no_se_quien_es_ese_doctor');
}

{
  // UN DÍA CERRADO NO SE RESERVA, aunque el calendario del doctor esté vacío. Google no
  // sabe que la clínica cierra: para él ese día está libre.
  olvidarTokens();
  const { impl, llamadas } = google(LIBRES);
  const r: any = await llamar(
    'create_booking', { doctor: 'Martínez', cuando: '2026-12-25T14:00', paciente: 'X' },
    impl, { ...CTX, cierresTexto: '25/12/2026  Navidad' }
  );
  assert.equal(leer(r).error, 'la_clinica_cierra_ese_dia');
  assert.equal(llamadas.length, 0);
}

// --- MOVER Y CANCELAR -----------------------------------------------------

{
  olvidarTokens();
  const { impl, llamadas } = google(LIBRES, [{ ok: true, cuerpo: {} }, { ok: true, cuerpo: {} }]);
  const uid = Buffer.from('c-ana@g.com|ev-abc', 'utf8').toString('base64url');
  const r: any = await llamar('reschedule_booking', {
    booking_uid: uid, cuando: '2026-09-08T15:00', doctor: 'López'
  }, impl);

  const d = leer(r);
  assert.equal(d.status, 'rescheduled', 'el estado que el SOUL escribe en booking_patch');
  assert.equal(d.start_time, '2026-09-08T19:00:00.000Z');
  assert.equal(d.doctor, 'Dra. María López');
  assert.equal(
    Buffer.from(d.booking_uid, 'base64url').toString('utf8'),
    'c-maria@g.com|ev-abc',
    'el uid nuevo apunta ya al calendario del doctor nuevo'
  );
  // EL TRASLADO VA ANTES QUE LA HORA. Al revés, si el traslado falla, la cita se queda con
  // la hora nueva en el doctor viejo.
  const escrituras = llamadas.filter(l => !l.url.includes('oauth2') && !l.url.includes('freeBusy'));
  assert.ok(escrituras[0].url.includes('/move?destination='), 'primero el traslado');
  assert.equal(escrituras[1].metodo, 'PATCH', 'y después la hora');
  assert.equal(escrituras[1].cuerpo.start.dateTime, '2026-09-08T19:00:00.000Z', 'las 3 EN CARACAS');
}

{
  olvidarTokens();
  const { impl } = google(LIBRES, [{ ok: true, status: 204 }]);
  const uid = Buffer.from('c-ana@g.com|ev-abc', 'utf8').toString('base64url');
  const r: any = await llamar('cancel_booking', { booking_uid: uid }, impl);
  assert.equal(leer(r).ok, true);
  assert.equal(leer(r).status, 'cancelled', 'el estado que el SOUL escribe');

  // Sin el uid no se inventa cuál cancelar.
  olvidarTokens();
  const { impl: i2, llamadas } = google(LIBRES);
  const r2: any = await llamar('cancel_booking', {}, i2);
  assert.equal(leer(r2).error, 'falta_booking_uid');
  assert.equal(llamadas.length, 0);
}

// --- 4. UN FALLO ES RESULTADO DE HERRAMIENTA, NO ERROR DE PROTOCOLO -------

{
  olvidarTokens();
  // Google se cae del todo. Esto lo atrapa el cliente y sale como error con nombre.
  const revienta = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
  const r: any = await llamar('get_available_slots', { doctor: 'Ana' }, revienta);
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true, 'Google caído: el modelo lo lee y deriva');

  // Y UNA EXCEPCIÓN QUE NADIE ESPERABA. Una zona horaria inventada hace que `Intl` lance un
  // RangeError desde dentro, muy por encima del cliente de Google.
  //
  // La primera versión de esta prueba usaba solo el fetch de arriba y pasaba sin ejercitar
  // nada: ese fallo lo atrapa `google.ts` y nunca llega al try/catch de aquí. Pasaba por el
  // motivo equivocado, que es la peor forma de pasar.
  olvidarTokens();
  const { impl: roto } = google(LIBRES);
  const zonaMala: any = await llamar(
    'get_available_slots', { doctor: 'Ana', cuando: '2026-09-07T14:00' },
    roto, { ...CTX, zona: 'Zona/Inventada' }
  );
  assert.equal(
    zonaMala.error, undefined,
    'NO es un error de protocolo: eso le corta la conversación al cliente'
  );
  assert.equal(zonaMala.result.isError, true, 'es un resultado que el modelo lee y puede derivar');
  assert.ok(JSON.parse(zonaMala.result.content[0].text).error.startsWith('fallo_inesperado'));

  // Y una herramienta que no existe tampoco tumba nada.
  const { impl } = google(LIBRES);
  const r2: any = await llamar('borrar_todo', {}, impl);
  assert.equal(r2.error, undefined);
  assert.ok(leer(r2).error.includes('herramienta_desconocida'));
}


// --- LO QUE EL SOUL YA SABE MANEJAR Y NO HAY QUE REESCRIBIR ---------------

{
  // UNA CITA QUE YA PASO NO SE REPROGRAMA, y se devuelve EL MISMO codigo que devolvia
  // Cal.com. El SOUL tiene escrita la explicacion en la linea 119 -«no puedo cambiar una
  // cita cuya hora ya paso, pero le agendo una nueva»-, probada con pacientes. Inventar un
  // codigo propio obligaria a reescribir esa regla para no ganar nada.
  olvidarTokens();
  const { impl, llamadas } = google(LIBRES);
  const uid = Buffer.from('c-ana@g.com|ev-abc', 'utf8').toString('base64url');
  const r: any = await llamar('reschedule_booking', { booking_uid: uid, cuando: '2026-09-01T10:00' }, impl);

  assert.equal(r.result.isError, true);
  assert.equal(
    leer(r).error, 'calcom_reschedule_past_booking_forbidden',
    'el codigo exacto que el SOUL ya sabe explicar'
  );
  assert.equal(llamadas.length, 0, 'y no se toca Google para algo que no se puede hacer');
}

{
  // `location` AL CONFIRMAR. Lo usa la linea 125 del SOUL: «si Cal.com ya devolvio
  // location, usa ese valor». Aqui es la direccion de la clinica, que es la misma respuesta
  // que le daba Cal.com al paciente.
  olvidarTokens();
  const { impl } = google(LIBRES, [{ ok: true, cuerpo: { id: 'ev-loc' } }]);
  const r: any = await llamar(
    'create_booking', { doctor: 'Martinez', cuando: '2026-09-07T14:00', paciente: 'X' },
    impl, { ...CTX, direccion: 'CC Mamanico local 27' }
  );
  assert.equal(leer(r).location, 'CC Mamanico local 27');

  // Sin direccion configurada NO se inventa una. Es la misma regla que en clinic_context:
  // una direccion inventada manda al paciente a otro sitio.
  olvidarTokens();
  const { impl: i2 } = google(LIBRES, [{ ok: true, cuerpo: { id: 'ev-sin' } }]);
  const r2: any = await llamar('create_booking', { doctor: 'Martinez', cuando: '2026-09-07T14:00', paciente: 'X' }, i2);
  assert.equal(leer(r2).location, undefined);
}

{
  // EL SOUL LE PASA `tenant_id` A LA HERRAMIENTA (linea 21). Se acepta sin quejarse y NO SE
  // MIRA: la clinica sale del token. Es justo el parametro que no debe decidir nada, y si
  // rechazaramos la llamada por traerlo, el SOUL habria que cambiarlo.
  olvidarTokens();
  const { impl } = google(LIBRES, [{ ok: true, cuerpo: { id: 'ev-t' } }]);
  const r: any = await llamar('create_booking', {
    doctor: 'Martinez', cuando: '2026-09-07T14:00', paciente: 'X',
    tenant_id: 'otra-clinica', contact_id: '123'
  }, impl);
  assert.equal(r.result.isError, false, 'no se rechaza por traer tenant_id');
  assert.ok(leer(r).booking_uid);
  assert.ok(
    !JSON.stringify(leer(r)).includes('otra-clinica'),
    'y ese tenant_id no aparece por ningun lado en la respuesta'
  );
}

console.log('agenda_mcp_test: OK');

/**
 * Hablar con Google Calendar.
 *
 * NO HAY RED AQUÍ, PERO SÍ HAY CRIPTOGRAFÍA DE VERDAD: se genera un par de claves RSA y se
 * comprueba que el JWT que sale de aquí lo puede verificar la pública. Firmar mal es el
 * fallo más caro de este módulo -Google devuelve un `invalid_grant` que no dice qué está
 * mal- y es justo la parte que no se puede probar mirando el código.
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE UN CALENDARIO QUE NO SE PUEDE LEER NO PAREZCA LIBRE. Es la regla 115. Google
 *     devuelve un `busy: []` junto al error, así que un doctor sin permiso parece un doctor
 *     con el día entero libre. Se le ofrecerían todas sus horas.
 *
 *  2. QUE UN FALLO ENTERO NO SE CONFUNDA CON «NO HAY HUECOS». Si la credencial está mal,
 *     eso es un error que se deriva a una persona. Un «no hay huecos» el paciente se lo
 *     cree y se va a otra clínica.
 *
 *  3. QUE UN REINTENTO NO DOBLE LA CITA. Si la respuesta de crear se pierde, el reintento
 *     tiene que encontrar la cita que sí se guardó, no crear una segunda.
 *
 *  4. Que cancelar algo que ya no está sea un éxito, no un error que despierte a alguien.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';

const {
  leerCredenciales, tokenDeAcceso, ocupacionDe, agendaDeDoctores,
  crearCita, moverCita, cancelarCita, idDeEvento, olvidarTokens, esError
} = await import('../src/agenda/google.js');
const { huecosDisponibles } = await import('../src/agenda/huecos.js');

// --- Una cuenta de servicio de mentira, con una clave de verdad ------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CLAVE = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CUENTA = {
  type: 'service_account',
  client_email: 'helios-agenda@proyecto.iam.gserviceaccount.com',
  private_key: CLAVE
};
const CRED = { correo: CUENTA.client_email, clave: CLAVE };

/** Un `fetch` de mentira que apunta lo que le piden y contesta lo que se le diga. */
function fetchDe(respuestas: Array<{ ok?: boolean; status?: number; cuerpo?: any; texto?: string }>) {
  const llamadas: Array<{ url: string; metodo: string; cuerpo: any; cabeceras: any }> = [];
  let i = 0;
  const impl = (async (url: any, opciones: any = {}) => {
    let cuerpo: any = opciones.body;
    if (typeof cuerpo === 'string' && cuerpo.startsWith('{')) {
      try { cuerpo = JSON.parse(cuerpo); } catch { /* se deja como texto */ }
    }
    llamadas.push({ url: String(url), metodo: opciones.method || 'GET', cuerpo, cabeceras: opciones.headers || {} });
    const r = respuestas[i++] ?? { ok: true, cuerpo: {} };
    return {
      ok: r.ok !== false && (r.status === undefined || r.status < 400),
      status: r.status ?? 200,
      json: async () => r.cuerpo ?? {},
      text: async () => r.texto ?? JSON.stringify(r.cuerpo ?? {})
    } as any;
  }) as unknown as typeof fetch;
  return { impl, llamadas };
}

const TOKEN_OK = { ok: true, cuerpo: { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' } };
const AYER = new Date('2026-08-27T14:00:00Z');

// --- LA CREDENCIAL ---------------------------------------------------------

{
  // Base64, que es como va en Coolify.
  const enB64 = Buffer.from(JSON.stringify(CUENTA)).toString('base64');
  const c = leerCredenciales(enB64);
  assert.ok(!esError(c), 'el base64 de Coolify tiene que leerse');
  assert.equal((c as any).correo, CUENTA.client_email);

  // Y el JSON pegado tal cual, porque alguien lo hará.
  assert.ok(!esError(leerCredenciales(JSON.stringify(CUENTA))), 'el JSON pegado directo también');

  // LA CLAVE CON `\n` LITERALES. Pasa al pegar el JSON en un formulario que escapa las
  // cadenas. Sin arreglarlo, la firma falla con «PEM routines», que no menciona el formato
  // y manda a buscar el problema a Google Cloud.
  const escapada = leerCredenciales(JSON.stringify({
    client_email: CUENTA.client_email,
    private_key: CLAVE.replace(/\n/g, '\\n')
  }));
  assert.ok(!esError(escapada));
  assert.ok((escapada as any).clave.includes('\n'), 'los \\n literales se convierten en saltos');

  // Lo que no sirve, con nombre propio para saber dónde mirar.
  assert.deepEqual(leerCredenciales(''), { error: 'agenda_sin_credenciales' });
  assert.deepEqual(leerCredenciales('esto no es nada'), { error: 'agenda_credenciales_ilegibles' });
  assert.deepEqual(
    leerCredenciales(JSON.stringify({ client_email: 'a@b.c' })),
    { error: 'agenda_credenciales_incompletas' },
    'sin clave privada no hay credencial'
  );
  assert.deepEqual(
    leerCredenciales(JSON.stringify({ private_key: CLAVE })),
    { error: 'agenda_credenciales_incompletas' },
    'sin correo tampoco'
  );
}

// --- EL JWT: QUE LA FIRMA SEA VERIFICABLE ----------------------------------

{
  olvidarTokens();
  const { impl, llamadas } = fetchDe([TOKEN_OK]);
  const token = await tokenDeAcceso({ fetchImpl: impl, credenciales: CRED, ahora: AYER });
  assert.equal(token, 'tok-1');

  const cuerpo = new URLSearchParams(llamadas[0].cuerpo as string);
  assert.equal(cuerpo.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');

  const jwt = String(cuerpo.get('assertion'));
  const [cab, datos, firma] = jwt.split('.');
  assert.equal(jwt.split('.').length, 3, 'un JWT son tres partes');

  // Y QUE EL ALFABETO SEA URL-SAFE DE VERDAD. Verificar la firma con la publica NO detecta
  // esto: si el `+` no se convirtiera a `-`, la prueba lo desharia al decodificar y todo
  // cuadraria consigo mismo. Quien no cuadra es Google, que rechaza el JWT con un error que
  // no menciona el formato. Asi que se comprueba lo que Google ve: los caracteres.
  assert.ok(
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt),
    'el JWT solo puede llevar el alfabeto base64url: ni +, ni /, ni ='
  );

  // Y LA FIRMA SE VERIFICA CON LA PUBLICA, que es lo unico de aqui que no se puede
  // comprobar leyendo el codigo: firmar sobre los bytes equivocados, o con un algoritmo que
  // no es el que declara la cabecera, se ve aqui y en ningun otro sitio hasta que lo diga
  // Google -y lo dice con un `invalid_grant` que no menciona la firma-.
  const verificador = createVerify('RSA-SHA256').update(`${cab}.${datos}`);
  assert.ok(
    verificador.verify(publicKey, Buffer.from(firma.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    'la firma del JWT tiene que validar contra la clave pública'
  );

  const reclamos = JSON.parse(Buffer.from(datos, 'base64').toString('utf8'));
  assert.equal(reclamos.iss, CUENTA.client_email);
  assert.equal(reclamos.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(reclamos.exp - reclamos.iat, 3600);

  // EL ÁMBITO ES EL ESTRECHO. El amplio -.../auth/calendar- añade borrar calendarios
  // enteros y cambiar sus permisos, que es lo que no debe poder hacer una credencial que
  // vive en un servidor.
  assert.ok(reclamos.scope.includes('calendar.events'), 'permiso para crear y cancelar');
  assert.ok(reclamos.scope.includes('calendar.freebusy'), 'permiso para consultar ocupación');
  assert.ok(
    !reclamos.scope.split(/\s+/).includes('https://www.googleapis.com/auth/calendar'),
    'y NO el ámbito amplio'
  );
}

// --- EL TOKEN SE GUARDA, Y CADUCA ------------------------------------------

{
  olvidarTokens();
  const { impl, llamadas } = fetchDe([TOKEN_OK, TOKEN_OK]);

  await tokenDeAcceso({ fetchImpl: impl, credenciales: CRED, ahora: AYER });
  await tokenDeAcceso({ fetchImpl: impl, credenciales: CRED, ahora: new Date(AYER.getTime() + 60_000) });
  assert.equal(llamadas.length, 1, 'el segundo uso reaprovecha el token: pedir uno por consulta dobla la latencia');

  // Pasada la hora, uno nuevo. Y el margen: a falta de menos de un minuto NO se reaprovecha,
  // porque un token que caduca a mitad de petición es un 401 con la credencial correcta.
  await tokenDeAcceso({ fetchImpl: impl, credenciales: CRED, ahora: new Date(AYER.getTime() + 3_570_000) });
  assert.equal(llamadas.length, 2, 'con menos de un minuto de vida se pide otro');
}

{
  // El motivo de Google va en el error: `invalid_scope` se arregla en una variable de
  // entorno y `invalid_grant` en la consola de Google. Son sitios distintos.
  olvidarTokens();
  const { impl } = fetchDe([{ ok: false, status: 400, cuerpo: { error: 'invalid_scope' } }]);
  const r = await tokenDeAcceso({ fetchImpl: impl, credenciales: CRED, ahora: AYER });
  assert.deepEqual(r, { error: 'agenda_token_rechazado_invalid_scope' });
}

{
  // Una clave que no firma se detecta ANTES de salir a la red: el problema está en la
  // variable de entorno, no en Google.
  olvidarTokens();
  const { impl, llamadas } = fetchDe([TOKEN_OK]);
  const r = await tokenDeAcceso({
    fetchImpl: impl, ahora: AYER,
    credenciales: { correo: 'a@b.c', clave: '-----BEGIN PRIVATE KEY-----\nno\n-----END PRIVATE KEY-----' }
  });
  assert.deepEqual(r, { error: 'agenda_clave_invalida' });
  assert.equal(llamadas.length, 0, 'no se sale a la red con una clave que no sirve');
}

// --- 1. UN CALENDARIO QUE NO SE PUEDE LEER NO ES UN CALENDARIO LIBRE -------

const VENTANA = { desde: new Date('2026-09-05T14:00:00Z'), hasta: new Date('2026-09-05T22:00:00Z') };

{
  olvidarTokens();
  const { impl, llamadas } = fetchDe([
    TOKEN_OK,
    {
      ok: true,
      cuerpo: {
        calendars: {
          'c-ana@group.calendar.google.com': {
            busy: [{ start: '2026-09-05T18:00:00Z', end: '2026-09-05T19:00:00Z' }]
          },
          // SIN PERMISO. Google manda el error JUNTO A UN `busy` VACÍO, que es exactamente
          // lo que parecería un doctor con el día entero libre. Es el paso 5 del manual, el
          // que se olvida: compartir el calendario con la cuenta de servicio.
          'c-sin-permiso@group.calendar.google.com': { busy: [], errors: [{ reason: 'notFound' }] },
          // UNA FRANJA ILEGIBLE invalida el calendario entero: no se sabe qué trozo del día
          // tapaba, así que quedarse con las que sí se entienden es ofrecer justo esa hora.
          'c-rota@group.calendar.google.com': { busy: [{ start: 'a las tres', end: '2026-09-05T19:00:00Z' }] }
        }
      }
    }
  ]);

  const r = await ocupacionDe(
    {
      calendarios: [
        'c-ana@group.calendar.google.com',
        'c-sin-permiso@group.calendar.google.com',
        'c-rota@group.calendar.google.com',
        // NI SIQUIERA VIENE EN LA RESPUESTA. Sin comprobarlo sería `undefined`, y un
        // `undefined` tratado como lista vacía es otra vez un doctor libre todo el día.
        'c-ausente@group.calendar.google.com'
      ],
      ...VENTANA
    },
    { fetchImpl: impl, credenciales: CRED, ahora: AYER }
  );

  assert.ok(!esError(r));
  const mapa = r as Map<string, any>;
  assert.equal(mapa.get('c-ana@group.calendar.google.com').length, 1, 'el que sí se lee, se lee');
  assert.equal(mapa.get('c-sin-permiso@group.calendar.google.com'), null, 'sin permiso NO es libre');
  assert.equal(mapa.get('c-rota@group.calendar.google.com'), null, 'una franja ilegible tumba el calendario');
  assert.equal(mapa.get('c-ausente@group.calendar.google.com'), null, 'lo que no contesta NO es libre');

  // La ventana se le pide a Google tal cual, en UTC.
  assert.equal((llamadas[1].cuerpo as any).timeMin, VENTANA.desde.toISOString());
  assert.equal((llamadas[1].cuerpo as any).items.length, 4);
}

{
  // Un ID de calendario es un correo, y los correos no distinguen mayúsculas. Google puede
  // devolver la clave normalizada; buscarla exacta dejaría al doctor como ilegible.
  olvidarTokens();
  const { impl } = fetchDe([
    TOKEN_OK,
    { ok: true, cuerpo: { calendars: { 'c-ana@group.calendar.google.com': { busy: [] } } } }
  ]);
  const r = await ocupacionDe(
    { calendarios: ['C-Ana@Group.Calendar.Google.com'], ...VENTANA },
    { fetchImpl: impl, credenciales: CRED, ahora: AYER }
  );
  assert.deepEqual((r as Map<string, any>).get('C-Ana@Group.Calendar.Google.com'), []);
}

// --- 2. UN FALLO ENTERO NO ES «NO HAY HUECOS» ------------------------------

{
  olvidarTokens();
  const { impl } = fetchDe([{ ok: false, status: 400, cuerpo: { error: 'invalid_grant' } }]);
  const r = await ocupacionDe({ calendarios: ['c-ana@g.com'], ...VENTANA }, { fetchImpl: impl, credenciales: CRED, ahora: AYER });

  // ES UN ERROR, NO UN MAPA DE NULOS. La diferencia importa: un error se deriva a una
  // persona; un mapa lleno de nulos daría cero huecos y Helios diría «no hay disponibilidad»
  // con la agenda vacía. El paciente se lo cree y se va.
  assert.ok(esError(r), 'una credencial mala es un error, no una agenda llena');
  assert.equal((r as any).error, 'agenda_token_rechazado_invalid_grant');
}

{
  // Un 401 tira el token guardado: repetir el mismo token muerto durante su hora de
  // validez convierte un fallo momentáneo en una hora sin agenda.
  olvidarTokens();
  const { impl, llamadas } = fetchDe([
    TOKEN_OK,
    { ok: false, status: 401 },
    TOKEN_OK,
    { ok: true, cuerpo: { calendars: {} } }
  ]);
  const deps = { fetchImpl: impl, credenciales: CRED, ahora: AYER };
  await ocupacionDe({ calendarios: ['c-ana@g.com'], ...VENTANA }, deps);
  await ocupacionDe({ calendarios: ['c-ana@g.com'], ...VENTANA }, deps);
  assert.equal(llamadas.length, 4, 'tras un 401 se vuelve a pedir token en vez de reusar el muerto');
}

{
  // MÁS DE CINCUENTA CALENDARIOS: error, NO recorte silencioso. Google ignoraría los de
  // más y esos doctores saldrían libres a todas horas, que es la peor forma de fallar.
  olvidarTokens();
  const { impl, llamadas } = fetchDe([TOKEN_OK]);
  const muchos = Array.from({ length: 51 }, (_, i) => `c${i}@g.com`);
  const r = await ocupacionDe({ calendarios: muchos, ...VENTANA }, { fetchImpl: impl, credenciales: CRED, ahora: AYER });
  assert.deepEqual(r, { error: 'agenda_demasiados_calendarios' });
  assert.equal(llamadas.length, 0, 'ni se intenta');
}

// --- 1 (de verdad). EL DOCTOR ILEGIBLE NO RECIBE CITAS, LOS DEMÁS SÍ -------
//
// Esto es lo mismo de arriba pero comprobado donde se paga: en los huecos que se le
// ofrecen a un paciente. Sin el `null`, Sin-Permiso saldría con el día entero libre y se
// llevaría la mitad de las citas de la clínica a un calendario que nadie puede leer.

{
  const JORNADA = [{ desde: 10 * 60, hasta: 20 * 60 }];
  const HORARIO = { 0: [], 1: JORNADA, 2: JORNADA, 3: JORNADA, 4: JORNADA, 5: JORNADA, 6: JORNADA } as any;
  const doctor = (nombre: string, calendario: string) => ({
    nombre, apellido: nombre, calendario, horario: HORARIO, hace: [], preferente: []
  });

  olvidarTokens();
  const { impl } = fetchDe([
    TOKEN_OK,
    {
      ok: true,
      cuerpo: {
        calendars: {
          'c-ana@g.com': { busy: [] },
          'c-sin-permiso@g.com': { busy: [], errors: [{ reason: 'notFound' }] }
        }
      }
    }
  ]);

  const agenda = await agendaDeDoctores(
    { doctores: [doctor('Ana', 'c-ana@g.com'), doctor('SinPermiso', 'c-sin-permiso@g.com')], ...VENTANA },
    { fetchImpl: impl, credenciales: CRED, ahora: AYER }
  );
  assert.ok(!esError(agenda));

  const huecos = huecosDisponibles({
    doctores: agenda as any,
    zona: 'America/Caracas',
    ...VENTANA,
    duracionMin: 45,
    margenMin: 15,
    antelacionMin: 0,
    ahora: VENTANA.desde
  });

  assert.ok(huecos.length > 0, 'la clínica sigue dando citas aunque un calendario falle');
  assert.ok(
    huecos.every(h => h.doctor_id === 'c-ana@g.com'),
    'y NINGUNA va al doctor cuyo calendario no se puede leer'
  );
}

// --- 3. UN REINTENTO NO DOBLA LA CITA --------------------------------------

{
  // El ID sale de la cita, no de Google. Google admite `[a-v0-9]` y un hexadecimal cabe
  // entero, así que no hace falta codificar nada raro.
  const id = idDeEvento('democoi1', 84, '2026-09-05T14:00:00.000Z', 'c-ana@g.com');
  assert.equal(id, idDeEvento('democoi1', 84, '2026-09-05T14:00:00.000Z', 'c-ana@g.com'), 'el mismo hueco, el mismo ID');
  assert.notEqual(id, idDeEvento('democoi1', 84, '2026-09-05T15:00:00.000Z', 'c-ana@g.com'), 'otra hora, otro ID');
  assert.ok(/^[a-v0-9]{5,1024}$/.test(id), 'el alfabeto que acepta Google');

  olvidarTokens();
  const { impl, llamadas } = fetchDe([TOKEN_OK, { ok: true, cuerpo: { id, status: 'confirmed' } }]);
  const cita = {
    calendario: 'c-ana@g.com',
    inicio: new Date('2026-09-05T14:00:00Z'),
    fin: new Date('2026-09-05T14:45:00Z'),
    titulo: 'Valoración · María Pérez',
    descripcion: '+58 412 000 0000',
    zona: 'America/Caracas',
    id
  };
  const r = await crearCita(cita, { fetchImpl: impl, credenciales: CRED, ahora: AYER });
  assert.ok(!esError(r));
  assert.equal((r as any).yaExistia, false);

  const enviado = llamadas[1].cuerpo as any;
  assert.equal(enviado.id, id, 'el ID va en la petición: sin él, el reintento crea otra cita');

  // OPACO, EXPLÍCITAMENTE. Un evento «transparent» no cuenta en freeBusy: sería una cita
  // que no ocupa, y el doctor acabaría con dos pacientes a la misma hora.
  assert.equal(enviado.transparency, 'opaque');

  // EL PACIENTE NO VA COMO INVITADO. Una cuenta de servicio no puede invitar sin delegación
  // de dominio y Google rechaza la petición ENTERA: se perdería la cita por querer mandar
  // un correo. Va en el título, que es lo que mira la recepcionista.
  assert.equal(enviado.attendees, undefined, 'nada de attendees con una cuenta de servicio');
  assert.ok(enviado.summary.includes('María Pérez'));
  assert.equal(enviado.start.timeZone, 'America/Caracas');
}

{
  // EL 409 ES ÉXITO. Significa que la llamada anterior sí guardó la cita aunque no
  // viéramos la respuesta. Tratarlo como fallo haría que Helios dijera «no se pudo
  // agendar» con la cita ya en el calendario del doctor.
  olvidarTokens();
  const id = idDeEvento('x');
  const { impl } = fetchDe([TOKEN_OK, { ok: false, status: 409 }]);
  const r = await crearCita(
    {
      calendario: 'c-ana@g.com', inicio: new Date('2026-09-05T14:00:00Z'), fin: new Date('2026-09-05T14:45:00Z'),
      titulo: 'Valoración', zona: 'America/Caracas', id
    },
    { fetchImpl: impl, credenciales: CRED, ahora: AYER }
  );
  assert.ok(!esError(r), 'un 409 con nuestro ID es la cita que ya se guardó');
  assert.equal((r as any).yaExistia, true);
  assert.equal((r as any).id, id);
}

// --- MOVER: EL TRASLADO VA ANTES QUE LA HORA -------------------------------

{
  olvidarTokens();
  const { impl, llamadas } = fetchDe([TOKEN_OK, { ok: true, cuerpo: {} }, { ok: true, cuerpo: {} }]);
  const r = await moverCita(
    {
      calendario: 'c-ana@g.com', id: 'abc', calendarioDestino: 'c-velez@g.com',
      inicio: new Date('2026-09-06T15:00:00Z'), fin: new Date('2026-09-06T15:45:00Z'), zona: 'America/Caracas'
    },
    { fetchImpl: impl, credenciales: CRED, ahora: AYER }
  );
  assert.ok(!esError(r));
  assert.equal((r as any).calendario, 'c-velez@g.com');

  // EL ORDEN NO ES CAPRICHO. Al revés, si el traslado falla, la cita se queda con la hora
  // nueva en el doctor viejo: un paciente citado con quien ya no le toca.
  assert.ok(llamadas[1].url.includes('/move?destination='), 'primero el traslado');
  assert.equal(llamadas[1].metodo, 'POST');
  assert.equal(llamadas[2].metodo, 'PATCH', 'y después la hora');
  assert.equal((llamadas[2].cuerpo as any).start.dateTime, '2026-09-06T15:00:00.000Z');
  assert.ok(!llamadas[2].url.includes('c-ana@g.com'), 'el patch va ya al calendario nuevo');
}

{
  // Sin cambio de doctor, una sola llamada: mover a la misma agenda no es un traslado.
  olvidarTokens();
  const { impl, llamadas } = fetchDe([TOKEN_OK, { ok: true, cuerpo: {} }]);
  await moverCita(
    {
      calendario: 'c-ana@g.com', id: 'abc', calendarioDestino: 'c-ana@g.com',
      inicio: new Date('2026-09-06T15:00:00Z'), fin: new Date('2026-09-06T15:45:00Z'), zona: 'America/Caracas'
    },
    { fetchImpl: impl, credenciales: CRED, ahora: AYER }
  );
  assert.equal(llamadas.length, 2, 'sin traslado, sólo el patch');
  assert.equal(llamadas[1].metodo, 'PATCH');
}

// --- 4. CANCELAR ALGO QUE YA NO ESTÁ ES UN ÉXITO ---------------------------

{
  for (const estado of [404, 410]) {
    olvidarTokens();
    const { impl } = fetchDe([TOKEN_OK, { ok: false, status: estado }]);
    const r = await cancelarCita({ calendario: 'c-ana@g.com', id: 'abc' }, { fetchImpl: impl, credenciales: CRED, ahora: AYER });
    // El resultado que se pedía -que esa hora quede libre- es exactamente el que hay. Dar
    // error aquí despertaría a alguien por una cancelación que está hecha.
    assert.deepEqual(r, { cancelada: true }, `un ${estado} al cancelar es una cita que ya no está`);
  }

  // Pero un 500 SÍ es un fallo: la cita puede seguir viva y la hora sigue ocupada.
  olvidarTokens();
  const { impl } = fetchDe([TOKEN_OK, { ok: false, status: 500 }]);
  const r = await cancelarCita({ calendario: 'c-ana@g.com', id: 'abc' }, { fetchImpl: impl, credenciales: CRED, ahora: AYER });
  assert.deepEqual(r, { error: 'agenda_google_500' }, 'un fallo de Google no se traga');

  // El DELETE de Google devuelve 204 sin cuerpo: pedirle JSON no debe romper.
  olvidarTokens();
  const { impl: impl2 } = fetchDe([TOKEN_OK, { ok: true, status: 204 }]);
  assert.deepEqual(
    await cancelarCita({ calendario: 'c-ana@g.com', id: 'abc' }, { fetchImpl: impl2, credenciales: CRED, ahora: AYER }),
    { cancelada: true }
  );
}

// --- SIN CREDENCIAL, NADA SALE A LA RED ------------------------------------

{
  olvidarTokens();
  const { impl, llamadas } = fetchDe([TOKEN_OK]);
  const r = await ocupacionDe(
    { calendarios: ['c-ana@g.com'], ...VENTANA },
    { fetchImpl: impl, credenciales: { correo: '', clave: '' } as any, ahora: AYER }
  );
  assert.ok(esError(r));
  assert.equal(llamadas.length, 0);

  // Y sin doctores no se molesta a Google: es el caso de una clínica recién dada de alta.
  assert.deepEqual(await agendaDeDoctores({ doctores: [], ...VENTANA }, { fetchImpl: impl }), []);
  assert.equal(llamadas.length, 0);
}

console.log('agenda_google_test: OK');

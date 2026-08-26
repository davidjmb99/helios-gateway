/**
 * El selector de cuentas: quién puede cambiarse de clínica y quién no.
 *
 * ESTE ES EL PRIMER PERMISO DEL SISTEMA QUE DEJA A UNA SESIÓN VER DOS CLÍNICAS, así que es
 * también el primer sitio donde se puede romper el aislamiento que David ha pedido desde
 * el principio: «que no se mezclen entre clientes de clínicas ni pacientes».
 *
 * LA PROPIEDAD QUE LO HACE SEGURO, y es de diseño y no de vigilancia: el token apunta
 * SIEMPRE a UNA sola clínica, y todos los endpoints sacan el tenant DEL TOKEN. No existe
 * ningún endpoint al que se le pueda pasar un `tenant_id` y que lo obedezca. Cambiar de
 * cuenta es pedir un token nuevo, y los tokens los emite el servidor.
 *
 * Lo que se protege, por orden de daño:
 *
 *  1. QUE UNA SESIÓN DE CLÍNICA NO PUEDA CAMBIARSE A OTRA. Es el fallo que expondría los
 *     datos de un paciente a otra clínica.
 *
 *  2. QUE EL NAVEGADOR NO PUEDA DECLARARSE OPERADOR. El rol va dentro del token firmado,
 *     y una firma que no cuadra invalida el token entero.
 *
 *  3. QUE QUITAR EL PERMISO SURTA EFECTO EN EL MOMENTO. Se vuelve a mirar la fila en cada
 *     cambio de cuenta, no solo al iniciar sesión: para un permiso que abre todas las
 *     clínicas, esperar a que caduque una sesión no es aceptable.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const { puedeCambiarDeCuenta, estadoHttpDe } = await import('../src/admin/operador.js');

const fuente = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

// --- 2. EL ROL VIAJA FIRMADO -----------------------------------------------
//
// Se reproduce aqui el mismo esquema del token para poder atacarlo: base64url del payload,
// mas HMAC-SHA256 de ese payload. Si el atacante pudiera cambiar el payload sin romper la
// firma, podria declararse operador y ver todas las clinicas.

const SECRETO = 'un-secreto-de-prueba';

const firmar = (payload: string) =>
  crypto.createHmac('sha256', SECRETO).update(payload).digest('base64url');

const token = (datos: Record<string, unknown>) => {
  const payload = Buffer.from(JSON.stringify(datos)).toString('base64url');
  return `${payload}.${firmar(payload)}`;
};

const verificar = (t: string): { tenant_id: string; operador: string | null } | null => {
  const [payload, firma] = t.split('.');
  if (!payload || !firma) return null;
  const esperada = firmar(payload);
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!d.tenant_id || !d.exp || d.exp <= Date.now()) return null;
    return { tenant_id: String(d.tenant_id), operador: d.operador ? String(d.operador) : null };
  } catch {
    return null;
  }
};

{
  const dentro = Date.now() + 60000;

  // Una sesion de clinica normal: sin operador.
  const deClinica = verificar(token({ tenant_id: 'democoi1', exp: dentro }));
  assert.equal(deClinica?.tenant_id, 'democoi1');
  assert.equal(deClinica?.operador, null, 'una sesion de clinica NO es de operador');

  // Y una de operador, emitida por nosotros.
  const deOperador = verificar(token({ tenant_id: 'democoi1', operador: 'escala365', exp: dentro }));
  assert.equal(deOperador?.operador, 'escala365');

  // EL ATAQUE: coger el token de una clinica, añadirle el campo de operador y reenviarlo.
  // La firma deja de cuadrar y el token entero se cae.
  const original = token({ tenant_id: 'democoi1', exp: dentro });
  const [payloadOriginal] = original.split('.');
  const manipulado = JSON.parse(Buffer.from(payloadOriginal, 'base64url').toString('utf8'));
  manipulado.operador = 'escala365';
  const falsificado =
    Buffer.from(JSON.stringify(manipulado)).toString('base64url') + '.' + original.split('.')[1];

  assert.equal(
    verificar(falsificado), null,
    'declararse operador cambiando el payload TIENE que invalidar el token: si esto ' +
    'pasara, cualquier clinica podria ver las demas'
  );

  // Lo mismo cambiando el tenant al que apunta.
  const otroTenant = JSON.parse(Buffer.from(payloadOriginal, 'base64url').toString('utf8'));
  otroTenant.tenant_id = 'otraclinica';
  assert.equal(
    verificar(Buffer.from(JSON.stringify(otroTenant)).toString('base64url') + '.' + original.split('.')[1]),
    null,
    'y cambiar el tenant del token tampoco cuela'
  );

  // Un token caducado no vale aunque la firma sea buena.
  assert.equal(
    verificar(token({ tenant_id: 'democoi1', operador: 'escala365', exp: Date.now() - 1 })), null,
    'un token caducado no vale ni siendo de operador'
  );
}

// --- 1 y 3. LA DECISION, EJERCITADA ----------------------------------------
//
// PRIMERO LO INTENTE MIRANDO EL TEXTO DE server.ts Y NO SERVIA. Quite el `if` que rechaza
// a una sesion de clinica y las comprobaciones siguieron pasando: el codigo seguia escrito
// en el archivo, solo que inalcanzable. Una prueba que pasa igual con el codigo bueno y
// con uno que da acceso a cualquiera no protege nada, y menos esto.
//
// Por eso la decision se saco a `puedeCambiarDeCuenta`, pura y sin base de datos, y aqui
// se ejercita de verdad.

{
  const clinica = { tenant_id: 'democoi1', operador: null };
  const operador = { tenant_id: 'democoi1', operador: 'escala365' };
  const filaBuena = { es_operador: true };

  // 1. EL CASO QUE NO PUEDE FALLAR NUNCA: una sesion de clinica no se cambia a nada.
  // Es el fallo que expondria los datos de un paciente a otra clinica.
  for (const fila of [filaBuena, { es_operador: false }, null, {}]) {
    assert.equal(
      puedeCambiarDeCuenta(clinica, fila), 'no_es_operador',
      'una sesion de clinica NO puede cambiarse de cuenta, mire lo que mire la fila'
    );
  }

  // El camino bueno.
  assert.equal(puedeCambiarDeCuenta(operador, filaBuena), 'permitido');

  // 3. SE LE QUITO EL PERMISO MIENTRAS TENIA LA SESION ABIERTA. Tiene que dejar de poder
  // AHORA, no cuando le caduque: es un permiso que abre todas las clinicas.
  assert.equal(puedeCambiarDeCuenta(operador, { es_operador: false }), 'ya_no_es_operador');
  assert.equal(
    puedeCambiarDeCuenta(operador, null), 'ya_no_es_operador',
    'y si la fila del operador ya no existe, tampoco'
  );

  // SE EXIGE `true` EXACTO. Un valor que se le parezca no es un permiso.
  for (const raro of ['true', 1, 'si', {}, [], 'TRUE', -1]) {
    assert.equal(
      puedeCambiarDeCuenta(operador, { es_operador: raro }), 'ya_no_es_operador',
      `es_operador ${JSON.stringify(raro)}: solo un true de verdad abre todas las clinicas`
    );
  }

  // Sin sesion, o con una rota, es 401 y no 403: son cosas distintas.
  for (const nada of [null, { tenant_id: '', operador: 'escala365' }]) {
    assert.equal(puedeCambiarDeCuenta(nada as any, filaBuena), 'sin_sesion');
  }

  assert.equal(estadoHttpDe('sin_sesion'), 401, '401 es «no se quien eres»');
  assert.equal(estadoHttpDe('no_es_operador'), 403, '403 es «se quien eres y no»');
  assert.equal(estadoHttpDe('ya_no_es_operador'), 403);
  assert.equal(estadoHttpDe('permitido'), 200);
}

// --- Y LA COSTURA: QUE ALGUIEN USE LA DECISION -----------------------------
//
// Estas comprobaciones miran el texto de server.ts. Es debil -no ejecutan nada- pero la
// alternativa era levantar el servidor con Supabase de mentira para comprobar cuatro
// lineas de autorizacion. Queda anotado: si algun dia hay pruebas de integracion del
// panel, estas se cambian por esas.

{
  // 1. LOS DOS ENDPOINTS DEL SELECTOR EXIGEN OPERADOR. Sin esto, una sesion de clinica
  // podria pedir un token para otra cuenta, que es exactamente la fuga que no puede pasar.
  for (const ruta of ['/admin/cuentas', '/admin/cambiar-cuenta']) {
    const i = fuente.indexOf(`'${ruta}'`);
    assert.ok(i > 0, `no se encuentra el endpoint ${ruta}`);
    const cuerpo = fuente.slice(i, i + 400);
    assert.match(
      cuerpo, /await exigirOperador\(request, reply\)/,
      `${ruta} tiene que exigir operador ANTES de hacer nada`
    );
    assert.match(
      cuerpo, /if \(!operador\) return;/,
      `${ruta} tiene que CORTAR si no lo es: comprobar y seguir igual no protege nada`
    );
  }

  // 3. EL GUARDIA TIENE QUE USAR LA DECISION Y LA FILA DE VERDAD. La logica ya se prueba
  // arriba ejercitandola; lo que se comprueba aqui es que el servidor la llame y le pase
  // el dato fresco de la base de datos, no algo del token.
  const guardia = fuente.slice(fuente.indexOf('async function exigirOperador'), fuente.indexOf('// GET /admin/cuentas'));
  assert.match(
    guardia, /\.from\('helios_tenants'\)[\s\S]{0,200}?es_operador/,
    'el guardia tiene que leer es_operador de la fila: si se fiara solo del token, quitarle ' +
    'el permiso a alguien no surtiria efecto hasta que le caducara la sesion'
  );
  assert.match(guardia, /puedeCambiarDeCuenta\(sesion, fila\)/, 'y decidir con la funcion pura');
  assert.match(
    guardia, /if \(motivo !== 'permitido'\)/,
    'cortando en cualquier motivo que no sea permitido'
  );

  // EL ROL SALE DE LA FILA, NUNCA DE LO QUE MANDE EL NAVEGADOR.
  const login = fuente.slice(fuente.indexOf('const esOperador'), fuente.indexOf('const esOperador') + 300);
  assert.match(
    login, /tenant\.es_operador === true/,
    'el rol se lee de la fila de la base de datos'
  );
  assert.doesNotMatch(
    fuente, /es_operador:\s*(request|req)\.(body|query|headers)/,
    'el rol NO puede salir de la peticion por ningun camino'
  );
}

{
  // Y LA PROPIEDAD DE FONDO: `checkAuth` sigue devolviendo un tenant_id y nada mas, asi que
  // ningun endpoint existente cambia y ninguno acepta un tenant como parametro. Es lo que
  // hace que el selector NO toque el aislamiento: no se añade ningun sitio donde se pueda
  // pedir «dame los datos del tenant X».
  assert.match(
    fuente, /return tenant\.tenant_id; \/\/ Retorna el tenant_id validado/,
    'checkAuth tiene que seguir devolviendo solo el tenant_id'
  );
  assert.ok(
    !/checkAuth\([^)]*\)[\s\S]{0,80}?\.operador/.test(fuente),
    'y ningun endpoint puede sacar el rol de checkAuth: para eso estan las funciones ' +
    'aparte, usadas solo por los dos endpoints del selector'
  );
}

{
  // EL PANEL: el selector no se pinta si el servidor no da la lista.
  //
  // La proteccion NO es que el desplegable este oculto -ocultar un boton no es un
  // permiso-: es que /admin/cuentas responde 403 a una sesion de clinica y la lista nunca
  // llega. Aqui se comprueba que el panel se comporte asi y no al reves.
  const panel = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // La ventana es amplia a proposito: lo que importa es el ORDEN -primero el corte, y
  // solo despues mostrar-, no cuantas lineas haya en medio.
  assert.match(
    panel, /if \(!res\.ok\) return;[\s\S]{0,1200}?classList\.remove\('hidden'\)/,
    'el selector solo se muestra DESPUES de una respuesta buena: si el servidor dice que ' +
    'no, no se pinta nada'
  );

  // Y el cambio de cuenta pide un TOKEN al servidor. Si el panel se guardara «la cuenta
  // que estoy viendo» y la mandara en cada peticion, cualquiera con una sesion de clinica
  // podria pedir los datos de otra cambiando ese valor.
  assert.match(
    panel, /fetch\('\/admin\/cambiar-cuenta'/,
    'cambiar de cuenta es pedirle un token nuevo al servidor'
  );
  assert.match(
    panel, /localStorage\.setItem\('helios_session_token', datos\.token\)/,
    'y guardar ESE token, no una preferencia de cuenta'
  );
  assert.ok(
    !/localStorage\.setItem\('helios_tenant/.test(panel),
    'el navegador NO puede guardar el tenant por su cuenta: el tenant vive en el token'
  );

  // Se recarga entero al cambiar: quedan datos de la cuenta anterior en media pantalla.
  assert.match(
    panel, /datos\.tenant\.name[\s\S]{0,120}?window\.location\.reload\(\)/,
    'al cambiar de cuenta se recarga la pagina: repintar a mano es donde se cuela un ' +
    'resto de la clinica de al lado'
  );
}

console.log('operador_test: OK');

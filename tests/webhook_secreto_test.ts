/**
 * Quién puede mandarle un webhook al Gateway.
 *
 * HASTA EL 28-ago-2026, CUALQUIERA. Las dos rutas no comprobaban firma, ni token, ni
 * cabecera: el único filtro era que el `account.id` del CUERPO estuviera en el mapa de
 * clínicas. Y los account_id de Chatwoot son números pequeños —el de COI es el 2—, así que
 * el filtro era «acierta un número de una cifra».
 *
 * LO QUE SE PUEDE HACER CON ESO NO ES GASTAR TOKENS. Con un `conversation_id` real, alguien
 * manda un `message_created` falso y Helios le contesta A UN PACIENTE DE VERDAD, en su
 * conversación de verdad, con la voz de la clínica.
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE SIN EL SECRETO NO SE ENTRE. Es la única pared.
 *  2. QUE DESPLEGAR ESTO NO DEJE A UNA CLÍNICA SIN MENSAJES. Sin la variable puesta, todo
 *     sigue como antes; el arranque avisa. Una protección que corta el servicio al
 *     desplegarse se acaba quitando, y entonces no protege nada.
 *  3. Que valga por cabecera Y por ruta, porque no todos los Chatwoot dejan añadir
 *     cabeceras a un webhook.
 *  4. Que la comparación no filtre el secreto por el tiempo que tarda.
 */

import assert from 'node:assert/strict';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
process.env.CHATWOOT_WEBHOOK_SECRET = 'un-secreto-largo-y-aleatorio-de-verdad';

const { compruebaElSecreto, avisoDeArranque, CABECERA } =
  await import('../src/chatwoot/secreto-webhook.js');

const BUENO = 'un-secreto-largo-y-aleatorio-de-verdad';

// --- 1. SIN EL SECRETO NO SE ENTRA ---------------------------------------

{
  assert.equal(compruebaElSecreto({ deLaCabecera: BUENO }), 'vale', 'por cabecera');
  assert.equal(compruebaElSecreto({ deLaConsulta: BUENO }), 'vale', 'por ?s=');
  assert.equal(compruebaElSecreto({ deLaRuta: BUENO }), 'vale', 'y por ruta');
  assert.equal(
    compruebaElSecreto({ deLaCabecera: BUENO, deLaRuta: 'basura' }), 'vale',
    'con que uno de los dos valga, basta'
  );

  // Y TODO LO DEMAS SE RECHAZA.
  for (const malo of [
    undefined, null, '', '   ', 'otro-secreto',
    BUENO + 'x',                    // uno de mas
    BUENO.slice(0, -1),             // uno de menos
    BUENO.toUpperCase(),            // mayusculas
    ' ' + BUENO,                    // con espacio delante: se recorta, asi que este VALE
    'un-secreto-largo-y-aleatorio-de-verdao'   // una letra cambiada al final
  ].filter(x => String(x ?? '').trim() !== BUENO)) {
    assert.equal(
      compruebaElSecreto({ deLaCabecera: malo }), 'rechazado',
      `«${String(malo)}» no puede entrar`
    );
    assert.equal(compruebaElSecreto({ deLaRuta: malo }), 'rechazado');
    assert.equal(compruebaElSecreto({ deLaConsulta: malo }), 'rechazado');
  }

  // Los espacios de sobra se recortan: quien lo pega en Chatwoot puede arrastrar uno.
  assert.equal(compruebaElSecreto({ deLaCabecera: `  ${BUENO}  ` }), 'vale');

  // Sin nada, rechazado. Es el caso de quien no sabe que hay secreto.
  assert.equal(compruebaElSecreto({}), 'rechazado');
}

// --- 2. SIN CONFIGURAR, TODO SIGUE COMO ANTES ----------------------------

{
  // El caso «sin configurar»: el estado en que queda el sistema justo despues de desplegar
  // esto y antes de que nadie ponga nada en Coolify.
  assert.equal(
    compruebaElSecreto({ esperadoDe: '' }), 'sin_configurar',
    'DESPLEGAR ESTO NO PUEDE DEJAR A UNA CLINICA SIN RECIBIR MENSAJES'
  );
  assert.equal(compruebaElSecreto({ deLaCabecera: 'lo que sea', esperadoDe: '' }), 'sin_configurar');

  // PERO SE AVISA, Y FUERTE. Sin secreto el sistema se comporta EXACTAMENTE igual que
  // antes: nada delata que la puerta esta abierta. Si no se dice al arrancar, no se dice.
  const aviso = avisoDeArranque('');
  assert.ok(aviso, 'tiene que haber aviso');
  assert.ok(
    /cualquiera/i.test(aviso as string),
    'y tiene que decir lo que pasa, no «revise la configuracion»'
  );
  assert.ok(
    (aviso as string).includes('CHATWOOT_WEBHOOK_SECRET'),
    'con el nombre de la variable, para saber que poner'
  );

}

{
  // Y CON SECRETO PUESTO, NO SE AVISA DE NADA. Un aviso que sale siempre deja de leerse, y
  // el dia que importe estara ahi con los demas.
  assert.equal(avisoDeArranque(), null);
}

// --- 3. LA CABECERA TIENE EL NOMBRE QUE SE DOCUMENTA ---------------------

{
  // Se exporta para que la ruta y el manual digan lo mismo. Un nombre de cabecera escrito a
  // mano en dos sitios acaba siendo dos nombres distintos.
  assert.equal(CABECERA, 'x-helios-webhook-secret');
  assert.equal(CABECERA, CABECERA.toLowerCase(), 'en minusculas: es como llegan en Node');
}

// --- 4. LA COMPARACION NO FILTRA EL SECRETO ------------------------------

{
  // ESTO NO SE PUEDE COMPROBAR EJECUTANDO, y se dice aqui para que nadie lo «simplifique»
  // creyendo que las pruebas le cubren. `timingSafeEqual` y `===` dan el MISMO resultado
  // siempre: lo unico que cambia es cuanto tardan. Un `===` tarda un poco mas cuantos mas
  // caracteres coincidan desde el principio, y un webhook se puede llamar todas las veces
  // que uno quiera hasta adivinarlo letra a letra.
  //
  // Lo que si se comprueba es que dos secretos de LARGO distinto no revienten: el
  // `timingSafeEqual` de Node lanza si los buffers no miden lo mismo, y una excepcion aqui
  // seria un 500 en vez de un 401 -y un 500 le dice a quien prueba que ha tocado hueso-.
  assert.equal(compruebaElSecreto({ deLaCabecera: 'x' }), 'rechazado', 'uno muy corto no revienta');
  assert.equal(
    compruebaElSecreto({ deLaCabecera: 'x'.repeat(5000) }), 'rechazado',
    'y uno enorme tampoco'
  );
}


// --- 5. Y QUE LAS TRES RUTAS ESTEN GUARDADAS -----------------------------
//
// La funcion puede estar perfecta y no servir de nada si una ruta no la llama. Eso no se ve
// probando el modulo: hay que mirar donde se usa.
//
// Y ES EL FALLO MAS FACIL DE COMETER: se añade una ruta nueva de webhook, se copia el
// cuerpo de otra, y se olvida la primera linea. Nada se rompe, nada avisa, y esa ruta queda
// abierta para siempre.

{
  const fs = await import('node:fs');
  const fuente = fs.readFileSync('src/server.ts', 'utf8');

  const guarda = fuente.slice(
    fuente.indexOf('function webhookAutorizado'),
    fuente.indexOf('function webhookAutorizado') + 900
  );

  const rutas = [...fuente.matchAll(/server\.post\('(\/webhooks\/[^']*)'/g)].map(m => m[1]);
  assert.ok(rutas.length >= 3, `se esperaban al menos tres rutas de webhook y hay ${rutas.length}`);

  for (const ruta of rutas) {
    const i = fuente.indexOf(`server.post('${ruta}'`);
    // Las tres primeras lineas del cuerpo: la guarda tiene que ser lo PRIMERO, antes de
    // leer el cuerpo de la peticion.
    const principio = fuente.slice(i, i + 260);
    assert.ok(
      principio.includes('webhookAutorizado(request, reply'),
      `la ruta ${ruta} NO comprueba el secreto: queda abierta a cualquiera`
    );
  }

  // Y QUE LA GUARDA LEA LOS TRES CAMINOS. Aceptarlos en `compruebaElSecreto` no sirve de
  // nada si el servidor no se los pasa: quitar la linea del `?s=` deja ese camino muerto y
  // la prueba del modulo sigue en verde, porque el modulo esta perfecto. Es el mismo fallo
  // que no llamar a la guarda desde una ruta, un nivel mas abajo.
  for (const [fuenteDelSecreto, deDonde] of [
    ['deLaCabecera', 'la cabecera'],
    ['deLaConsulta', 'el ?s= de la URL'],
    ['deLaRuta', 'el segmento de ruta']
  ]) {
    assert.ok(
      guarda.includes(`${fuenteDelSecreto}:`),
      `webhookAutorizado no mira ${deDonde}: ese camino esta muerto y nada lo dice`
    );
  }

  // EL SECRETO NO PUEDE ACABAR EN NUESTRO PROPIO LOG. Con `?s=` viaja en la URL, y la linea
  // de `webhook_rechazado` escribe la ruta: si escribiera la URL entera, cada intento
  // fallido dejaria escrito un secreto -el correcto, el dia que alguien se equivoque de
  // campo al configurarlo-. Se corta por el `?`.
  const registro = fuente.slice(
    fuente.indexOf("event: 'webhook_rechazado'"),
    fuente.indexOf("event: 'webhook_rechazado'") + 500
  );
  assert.ok(
    registro.includes("split('?')[0]"),
    'la linea de rechazo NO puede registrar la query: ahi va el secreto'
  );

  // Y se rechaza con 401 y sin explicar nada: decir «falta el secreto» o «el secreto es
  // incorrecto» le dice a quien esta probando por donde seguir probando.
  assert.ok(guarda.includes('.status(401)'), 'se rechaza con 401');
  assert.ok(
    !/status\(401\)[\s\S]{0,120}(falta|incorrecto|invalid)/i.test(guarda),
    'y sin decir por que'
  );
}

console.log('webhook_secreto_test: OK');

/**
 * De dónde sale el tipo de un archivo: la extensión, y si no, la cabecera.
 *
 * ESTA PRUEBA NACE DE LA PRIMERA NOTA DE VOZ DE VERDAD, el 24 de agosto de 2026, PERO NO
 * DEL FALLO QUE LA CAUSÓ. Conviene dejarlo claro para que nadie lea aquí una historia
 * equivocada, como hice yo:
 *
 *   LO QUE YO DIJE. Que WhatsApp nombraba la nota «AUDIO-2026-08-24-14.47.31» y que mi
 *   expresión regular se tragaba el «31» como extensión. Lo deduje del síntoma -«1 audio
 *   · 1 fallaron», «Gemini $0»- sin esperar el dato.
 *
 *   LO QUE PASÓ DE VERDAD. La extensión se leyó bien, `ogg`. La llamada SÍ se hizo. Y
 *   Gemini devolvió un 404: el modelo no existía para esa clave. Lo dijo la columna
 *   `error` de helios_media_events, que es donde estaba el dato desde el principio.
 *
 * ASÍ QUE ESTA PRUEBA CUBRE DOS COSAS DISTINTAS. La primera parte es una mejora real que
 * NO era la causa de aquello: una extensión que no reconocemos no significa «formato
 * malo», significa «no lo sé», y cuando no se sabe se pregunta al `content-type` en vez
 * de decidir por el paciente. Ese fallo no había ocurrido todavía, pero ocurrirá -las
 * URLs de ActiveStorage sin nombre son reales-.
 *
 * La segunda parte, al final del archivo, SÍ es del incidente: el cuerpo del error de
 * Google se pedía y se tiraba, y por eso el panel decía «gemini_404» sin explicar nada.
 *
 * Lo que se protege, por orden de daño:
 *
 *  1. QUE UNA NOTA DE VOZ CON UN NOMBRE RARO SE TRANSCRIBA. Es el fallo que ocurrió.
 *
 *  2. QUE LO QUE SE LE DECLARA A GEMINI SALGA DE UNA LISTA NUESTRA. El content-type lo
 *     pone Chatwoot -un host ya comprobado-, pero eso no lo convierte en un valor que se
 *     pueda copiar tal cual en el campo `mime_type` de la llamada.
 *
 *  3. QUE SEGUIR AHORRANDO RED en lo que sí sabemos que no se puede leer. Un .amr no lo
 *     lee Gemini y no hay cabecera que lo salve: se rechaza sin descargar.
 */

import assert from 'node:assert/strict';

const CHATWOOT = 'https://chatwoot.app.escala365.com';
process.env.CHATWOOT_BASE_URL = CHATWOOT;
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' }
});
process.env.GEMINI_API_KEY = 'clave-de-prueba';
process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';

const { procesarAdjunto } = await import('../src/media/gemini.js');
const { normalizarAdjuntos } = await import('../src/chatwoot/adjuntos.js');

function adjunto(over: Record<string, any> = {}) {
  const [a] = normalizarAdjuntos({
    attachments: [{ file_type: 'audio', data_url: `${CHATWOOT}/x/nota.ogg`, file_size: 12000, ...over }]
  }, CHATWOOT);
  return a;
}

/** Una red de mentira que sirve el archivo con el content-type que se le diga. */
function red(opciones: { contentType?: string; texto?: string; tokens?: number } = {}) {
  const registro: Array<{ url: string; body?: any }> = [];
  const impl = (async (url: any, init: any = {}) => {
    const direccion = String(url);
    registro.push({ url: direccion, body: init.body ? JSON.parse(init.body) : undefined });

    if (!direccion.includes('generativelanguage')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (n: string) =>
            (n.toLowerCase() === 'content-type' ? (opciones.contentType ?? '') : null)
        },
        arrayBuffer: async () => new ArrayBuffer(1000)
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        candidates: [{ content: { parts: [{ text: opciones.texto ?? 'hola' }] } }],
        usageMetadata: { promptTokenCount: opciones.tokens ?? 960, candidatesTokenCount: 18 }
      })
    };
  }) as unknown as typeof fetch;

  const mimeDeclarado = () => {
    const p = registro.find(x => x.url.includes('generativelanguage'));
    return p ? p.body.contents[0].parts[1].inline_data.mime_type : null;
  };
  return { impl, registro, mimeDeclarado };
}

// --- 1. EL CASO QUE OCURRIO -------------------------------------------------

{
  const a = adjunto({
    data_url: `${CHATWOOT}/rails/active_storage/blobs/redirect/xYz--abc/AUDIO-2026-08-24-14.47.31`,
    file_name: 'AUDIO-2026-08-24-14.47.31'
  });

  // El diagnostico, escrito para que no haya que reconstruirlo otra vez.
  assert.equal(a.extension, '31', 'la «extension» que saca la regex de ese nombre es «31»');
  assert.equal(a.soporte, 'desconocido', 'y eso es NO LO SE, que no es lo mismo que NO VALE');
  assert.equal(a.rechazo, null, 'lo desconocido NO se rechaza de entrada: ahi estaba el fallo');

  const { impl, mimeDeclarado } = red({
    contentType: 'audio/ogg', texto: 'Hola, quería una cita para el martes'
  });
  const r = await procesarAdjunto(a, false, impl);
  assert.match(String(r.texto), /cita para el martes/, 'la nota de voz SE TRANSCRIBE');
  assert.equal(r.error, null);
  assert.equal(mimeDeclarado(), 'audio/ogg', 'y se declara lo que dijo Chatwoot, no el «31»');
}

{
  // Sin extension ninguna: una URL de ActiveStorage sin nombre de archivo.
  const a = adjunto({ data_url: `${CHATWOOT}/rails/active_storage/blobs/redirect/xYz--abc/file` });
  assert.equal(a.extension, '');
  assert.equal(a.rechazo, null);

  const { impl } = red({ contentType: 'audio/ogg', texto: 'buenas tardes' });
  assert.equal((await procesarAdjunto(a, false, impl)).texto, 'buenas tardes');
}

{
  // OGG OPUS, que es el formato REAL de WhatsApp. `audio/opus` es valido en HTTP pero no
  // esta en la lista de Gemini, asi que se traduce al nombre que el conoce.
  const { impl, mimeDeclarado } = red({ contentType: 'audio/opus' });
  await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/sinnombre` }), false, impl);
  assert.equal(
    mimeDeclarado(), 'audio/ogg',
    'audio/opus se declara como audio/ogg: si se manda «audio/opus» tal cual, Gemini lo ' +
    'rechaza con un 400 y parece un problema del archivo'
  );
}

// --- 2. LO QUE SE DECLARA SALE DE UNA LISTA NUESTRA -------------------------

{
  // UNA CABECERA QUE NO CUADRA CON EL TIPO no se manda. Si el webhook dice «audio» y la
  // cabecera dice «image/png», son dos fuentes que deberian coincidir y no coinciden: lo
  // prudente es no adivinar cual tiene razon.
  const { impl, registro } = red({ contentType: 'image/png' });
  const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/sinnombre` }), false, impl);
  assert.match(String(r.error), /^formato_no_soportado/, 'familia que no cuadra: no se manda');
  assert.equal(r.uso, null, 'y no se paga nada');
  assert.equal(registro.length, 1, 'se descargo -hacia falta para saberlo- pero no se mando');
}

{
  // Y NADA QUE NO ESTE EN LA LISTA, ni aunque empiece por «audio/». Es lo que impide que
  // una cabecera cualquiera acabe copiada en el campo mime_type de la llamada.
  for (const raro of [
    'audio/vnd.inventado', 'application/octet-stream', 'text/html', '',
    'audio/ogg; algo raro que no deberia estar aqui'
  ]) {
    const { impl, registro } = red({ contentType: raro });
    const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/sinnombre` }), false, impl);
    if (raro.startsWith('audio/ogg;')) {
      // El punto y coma se recorta: «audio/ogg; charset=x» es audio/ogg.
      assert.equal(r.error, null, 'los parametros despues del punto y coma se ignoran');
      continue;
    }
    assert.match(
      String(r.error), /^formato_no_soportado/,
      `content-type ${JSON.stringify(raro)}: solo pasa lo que esta en la lista`
    );
    assert.ok(
      !registro.some(x => x.url.includes('generativelanguage')),
      `content-type ${JSON.stringify(raro)}: y NO se llama al modelo`
    );
  }
}

{
  // LA EXTENSION MANDA CUANDO EXISTE, porque es fiable y no depende de como sirva el
  // archivo Chatwoot, que a veces manda application/octet-stream para todo.
  const { impl, mimeDeclarado } = red({
    contentType: 'application/octet-stream', texto: 'con extension va igual'
  });
  const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/nota.mp3` }), false, impl);
  assert.equal(r.texto, 'con extension va igual');
  assert.equal(mimeDeclarado(), 'audio/mp3', 'la extension gana a una cabecera generica');
}

// --- 3. LO QUE SI SABEMOS QUE NO VALE SIGUE SIN DESCARGARSE -----------------

{
  // De aqui venia el ahorro de red, y se conserva. Un .amr no lo lee Gemini y no hay
  // cabecera que lo salve.
  const { impl, registro } = red({ contentType: 'audio/amr' });
  const a = adjunto({ data_url: `${CHATWOOT}/x/nota.amr` });
  assert.equal(a.soporte, 'no_soportado', 'un .amr SI se sabe que no vale');
  assert.equal(a.rechazo, 'formato_no_soportado');

  const r = await procesarAdjunto(a, false, impl);
  assert.equal(r.error, 'formato_no_soportado');
  assert.equal(registro.length, 0, 'y NO se descarga: el ahorro se conserva');
}

{
  // Y la lista de lo que no vale cubre las cuatro familias, para que el ahorro no se
  // pierda solo en el audio.
  const casos: Array<[string, string]> = [
    ['imagen', 'gif'], ['video', 'mkv'], ['documento', 'docx']
  ];
  for (const [familia, ext] of casos) {
    const tipoDeChatwoot = familia === 'imagen' ? 'image' : familia === 'video' ? 'video' : 'file';
    const a = adjunto({ file_type: tipoDeChatwoot, data_url: `${CHATWOOT}/x/f.${ext}` });
    assert.equal(a.rechazo, 'formato_no_soportado', `.${ext} se sigue rechazando sin descargar`);
  }
}

console.log('media_content_type_test: OK');

// --- EL ERROR DE GOOGLE SE LEE, NO SE TIRA ---------------------------------
//
// ESTO NACE DE UN FALLO MIO QUE COSTO UNA PRUEBA ENTERA. El codigo pedia el cuerpo del
// error y lo tiraba: habia un `${cuerpo ? '' : ''}` que siempre daba cadena vacia. Asi
// que un 404 llegaba al panel como «gemini_404» y punto, cuando Google estaba explicando
// en ese cuerpo exactamente que modelo no encontraba y para que version de la API.
//
// El resultado fue que diagnostique mal -culpe al nombre del archivo- y David tuvo que
// mandar otra nota de voz para averiguar algo que ya estaba escrito en la respuesta.

{
  // UN 404 SE MARCA APARTE, con el nombre del modelo dentro. No es un fallo de este
  // archivo: es que el modelo no existe para esta clave, y entonces fallan TODAS las
  // llamadas. Mismo criterio que el codec: un problema sistematico no puede parecer uno
  // aislado en el panel.
  const impl = (async (url: any) => {
    if (!String(url).includes('generativelanguage')) {
      return {
        ok: true, status: 200,
        headers: { get: () => 'audio/ogg' },
        arrayBuffer: async () => new ArrayBuffer(1000)
      };
    }
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({
        error: {
          code: 404,
          message: 'models/gemini-2.5-flash-lite is not found for API version v1beta, or is not supported for generateContent.',
          status: 'NOT_FOUND'
        }
      })
    };
  }) as unknown as typeof fetch;

  const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/nota.ogg` }), false, impl);
  assert.match(
    String(r.error), /^gemini_modelo_no_existe_/,
    'un 404 dice que el MODELO no existe, no un «gemini_404» que no explica nada'
  );
  assert.match(
    String(r.error), /gemini-2\.5-flash-lite/,
    'y lleva dentro el nombre del modelo, que es el dato que hace falta para arreglarlo'
  );
  assert.ok(String(r.error).length <= 80, 'sin pasarse de largo: es una columna, no un log');
}

{
  // UNA CLAVE RECHAZADA es otra cosa distinta, y tambien sistematica.
  for (const estado of [401, 403]) {
    const impl = (async (url: any) => {
      if (!String(url).includes('generativelanguage')) {
        return {
          ok: true, status: 200,
          headers: { get: () => 'audio/ogg' },
          arrayBuffer: async () => new ArrayBuffer(1000)
        };
      }
      return {
        ok: false, status: estado,
        text: async () => JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'API key not valid' } })
      };
    }) as unknown as typeof fetch;

    const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/nota.ogg` }), false, impl);
    assert.match(String(r.error), /^gemini_clave_rechazada_/, `${estado}: se distingue de un 404`);
  }
}

{
  // Y CUALQUIER OTRO ERROR lleva el codigo corto de Google, que es lo que cabe en la
  // columna. Sin el, dos fallos con motivos distintos se ven iguales.
  const impl = (async (url: any) => {
    if (!String(url).includes('generativelanguage')) {
      return {
        ok: true, status: 200,
        headers: { get: () => 'audio/ogg' },
        arrayBuffer: async () => new ArrayBuffer(1000)
      };
    }
    return {
      ok: false, status: 500,
      text: async () => JSON.stringify({ error: { status: 'INTERNAL', message: 'algo se rompio en Google' } })
    };
  }) as unknown as typeof fetch;

  const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/nota.ogg` }), false, impl);
  assert.equal(r.error, 'gemini_500_INTERNAL', 'el codigo de Google viaja hasta el panel');
}

{
  // Y SI EL CUERPO NO ES JSON no se rompe nada: se cae al codigo HTTP a secas.
  const impl = (async (url: any) => {
    if (!String(url).includes('generativelanguage')) {
      return {
        ok: true, status: 200,
        headers: { get: () => 'audio/ogg' },
        arrayBuffer: async () => new ArrayBuffer(1000)
      };
    }
    return { ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' };
  }) as unknown as typeof fetch;

  const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/nota.ogg` }), false, impl);
  assert.equal(r.error, 'gemini_502', 'un cuerpo que no es JSON no puede tumbar el manejo del error');
}

console.log('media_content_type_test: errores de Google OK');

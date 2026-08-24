/**
 * De dónde sale el tipo de un archivo: la extensión, y si no, la cabecera.
 *
 * ESTA PRUEBA NACE DE LA PRIMERA NOTA DE VOZ DE VERDAD, el 24 de agosto de 2026. No se
 * transcribió, y no fue culpa de Gemini: se rechazó aquí, sin llegar a intentarlo,
 * gastando cero. El panel decía «1 audio · 1 fallaron» y «Gemini $0», que es justo el
 * síntoma de haberse rendido antes de empezar.
 *
 * LA CAUSA. WhatsApp nombra las notas de voz «AUDIO-2026-08-24-14.47.31», con puntos en
 * la fecha, y mi expresión regular se tragaba el «31» como si fuera el formato. Y una URL
 * de ActiveStorage sin nombre de archivo no da extensión ninguna. Los dos casos acababan
 * en `formato_no_soportado`.
 *
 * LO QUE SE APRENDIÓ, y es la propiedad que esta prueba protege: UNA EXTENSIÓN QUE NO
 * RECONOCEMOS NO SIGNIFICA «FORMATO MALO», SIGNIFICA «NO LO SÉ». Y cuando no se sabe, se
 * pregunta a quien tiene el dato -el `content-type` que manda Chatwoot- en vez de decidir
 * por el paciente.
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

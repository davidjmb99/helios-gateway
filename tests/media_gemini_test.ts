/**
 * La llamada a Gemini: descargar el archivo, mandarlo, devolver el texto.
 *
 * Lo que se protege, por orden de daño si falla:
 *
 *  1. QUE LA DESCRIPCION DE UNA IMAGEN CLINICA NO LLEGUE A LA CONVERSACION, ni cuando el
 *     modelo desobedece el prompt. Es la garantía de que Helios no opina sobre una muela.
 *
 *  2. QUE NO SE DESCARGUE UNA URL QUE NO ES DE CHATWOOT, ni aunque el normalizador la
 *     hubiera dejado pasar. Esta comprobación está pegada a la llamada de red, que es
 *     donde de verdad protege, y además AQUI SE MANDA EL TOKEN DE CHATWOOT: sin ella,
 *     esta función le entregaría nuestra credencial a quien pusiera una URL en el webhook.
 *
 *  3. QUE EL FALLO DE OPUS SE DISTINGA de un fallo cualquiera. Si Gemini no lee el codec
 *     de WhatsApp, fallarían TODAS las notas de voz: un error genérico haría que un
 *     problema sistemático pareciera aislado.
 *
 *  4. Que el gasto se reporte incluso cuando la llamada no sirvió de nada. Esconderlo es
 *     lo que el panel de métricas existe para evitar.
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

/** Un adjunto ya normalizado, como el que produce el webhook. */
function adjunto(over: Record<string, any> = {}) {
  const [a] = normalizarAdjuntos({
    attachments: [{
      file_type: 'audio', data_url: `${CHATWOOT}/x/nota.ogg`, file_size: 12000, ...over
    }]
  }, CHATWOOT);
  return a;
}

/**
 * Un Gemini de mentira. Registra lo que se le pide para poder comprobarlo, y permite
 * forzar cualquier respuesta o código de error.
 */
function fakeRed(opciones: {
  respuestaDeGemini?: any;
  estadoDeGemini?: number;
  bytesDelArchivo?: number;
  estadoDeDescarga?: number;
  /** El content-type con el que Chatwoot sirve el archivo. */
  tipoDeContenido?: string;
}) {
  const registro: Array<{ url: string; headers: any; body?: any }> = [];
  const impl = (async (url: any, init: any = {}) => {
    const direccion = String(url);
    registro.push({
      url: direccion,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined
    });

    // La descarga del archivo.
    if (direccion.startsWith(CHATWOOT) || !direccion.includes('generativelanguage')) {
      const estado = opciones.estadoDeDescarga ?? 200;
      return {
        ok: estado >= 200 && estado < 300,
        status: estado,
        headers: {
          get: (n: string) =>
            (n.toLowerCase() === 'content-type' ? (opciones.tipoDeContenido ?? '') : null)
        },
        arrayBuffer: async () => new ArrayBuffer(opciones.bytesDelArchivo ?? 1000)
      };
    }

    // La llamada al modelo.
    const estado = opciones.estadoDeGemini ?? 200;
    return {
      ok: estado >= 200 && estado < 300,
      status: estado,
      text: async () => 'detalle del error',
      json: async () => opciones.respuestaDeGemini ?? {
        candidates: [{ content: { parts: [{ text: 'Buenas, quería cita para mañana' }] } }],
        usageMetadata: { promptTokenCount: 960, candidatesTokenCount: 12 }
      }
    };
  }) as unknown as typeof fetch;
  return { impl, registro };
}

// --- El camino bueno: una nota de voz se transcribe -------------------------

{
  const { impl, registro } = fakeRed({});
  const r = await procesarAdjunto(adjunto(), false, impl);

  assert.equal(r.texto, 'Buenas, quería cita para mañana');
  assert.equal(r.error, null);
  assert.equal(r.derivar, false, 'un audio normal no deriva');
  assert.deepEqual(r.uso, { input_tokens: 960, output_tokens: 12 }, 'el gasto se reporta');

  // La clave va en CABECERA y no en la query: una URL con la clave dentro acaba en logs
  // de acceso, en trazas y en mensajes de error.
  const aGemini = registro.find(p => p.url.includes('generativelanguage'))!;
  assert.equal(aGemini.headers['x-goog-api-key'], 'clave-de-prueba');
  assert.ok(!aGemini.url.includes('clave-de-prueba'), 'la clave NO puede ir en la URL');

  // Y se le pide transcribir literalmente, sin resumir.
  const prompt = aGemini.body.contents[0].parts[0].text;
  assert.match(prompt, /literalmente/i);
  assert.match(prompt, /NO resumas/);
  assert.equal(aGemini.body.generationConfig.temperature, 0, 'sin temperatura: no se crea, se transcribe');
}

// --- 1. LA IMAGEN CLINICA -------------------------------------------------

{
  // El modelo DESOBEDECE y describe la boca. La descripcion NO puede salir de aqui.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{
        text: '{"categoria":"clinica","descripcion":"Se aprecia una caries profunda en el molar"}'
      }] } }],
      usageMetadata: { promptTokenCount: 1032, candidatesTokenCount: 30 }
    }
  });
  const r = await procesarAdjunto(
    adjunto({ file_type: 'image', data_url: `${CHATWOOT}/x/muela.jpg` }), false, impl
  );

  assert.equal(r.categoria, 'clinica');
  assert.equal(r.derivar, true, 'una imagen clinica la ve una persona');
  assert.equal(
    r.texto, null,
    'LA GARANTIA: la descripcion de una imagen clinica NO llega a la conversacion, ni ' +
    'cuando el modelo la genera desobedeciendo el prompt'
  );
  assert.ok(!JSON.stringify(r).includes('caries'), 'ni asomada en ningun campo del resultado');

  // DONDE ESTA DE VERDAD ESTA GARANTIA, para que nadie se confunda: la descripcion se
  // tira en leerClasificacionDeImagen, una capa mas arriba, y eso lo comprueba
  // media_prompts_test con esta misma frase de la caries. La linea de gemini.ts que
  // vuelve a anularla es un SEGUNDO cinturon, y quitarla NO hace fallar esta prueba
  // -lo comprobe inyectandolo-. Esta bien que este, pero no se puede decir que este
  // probada: lo que se prueba aqui es el resultado compuesto de las dos capas.
}

{
  // Un comprobante de pago: se reconoce y se deriva, sin leer la cifra. Una cantidad mal
  // leida por un modelo es una discusion con un paciente sobre dinero.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: '{"categoria":"pago","descripcion":"Transferencia de 400"}' }] } }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20 }
    }
  });
  const r = await procesarAdjunto(adjunto({ file_type: 'image', data_url: `${CHATWOOT}/x/pago.png` }), false, impl);
  assert.equal(r.derivar, true);
  assert.equal(r.texto, null, 'la cifra de un pago no se transcribe');
}

{
  // Una promocion SI se describe y la conversacion sigue: es la rama que David pidio.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: '{"categoria":"promocional","descripcion":"Cartel de 20% en limpiezas"}' }] } }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20 }
    }
  });
  const r = await procesarAdjunto(adjunto({ file_type: 'image', data_url: `${CHATWOOT}/x/promo.jpg` }), false, impl);
  assert.equal(r.derivar, false, 'una promocion no interrumpe la conversacion');
  assert.match(String(r.texto), /20%/);
}

{
  // Y si la clasificacion no se entiende, cae en clinica y se deriva, pero se DICE que la
  // clasificacion no era de fiar: si eso pasa siempre, el modelo esta devolviendo basura.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: 'no soy json' }] } }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 5 }
    }
  });
  const r = await procesarAdjunto(adjunto({ file_type: 'image', data_url: `${CHATWOOT}/x/x.jpg` }), false, impl);
  assert.equal(r.derivar, true);
  assert.equal(r.error, 'clasificacion_no_confiable');
}

// --- 2. LA URL Y EL TOKEN DE CHATWOOT ------------------------------------

{
  // El normalizador ya rechaza esto, pero la comprobacion que de verdad protege es la
  // pegada a la llamada de red. Se fuerza un adjunto con URL ajena y sin rechazo previo.
  const { impl, registro } = fakeRed({});
  const ajeno = { ...adjunto(), url: 'http://169.254.169.254/latest/meta-data/', rechazo: null };
  const r = await procesarAdjunto(ajeno as any, false, impl);

  assert.equal(r.error, 'url_no_es_de_chatwoot');
  assert.equal(
    registro.length, 0,
    'NO se hizo ni una peticion. Si se hubiera hecho, le habriamos mandado el token de ' +
    'Chatwoot a los metadatos de la nube'
  );
}

{
  // Y en la descarga legitima SI va el token, que es lo que hace imprescindible la
  // comprobacion de arriba.
  process.env.CHATWOOT_API_TOKEN = 'token-de-chatwoot';
  const { impl, registro } = fakeRed({});
  await procesarAdjunto(adjunto(), false, impl);
  const descarga = registro.find(p => p.url.startsWith(CHATWOOT));
  assert.ok(descarga, 'se descarga del propio Chatwoot');
}

// --- 3. EL FALLO DE OPUS SE DISTINGUE -----------------------------------

{
  // 400 con un audio ogg/opus significa que Gemini no lee el codec de WhatsApp. Eso NO es
  // un fallo aislado: fallarian TODAS las notas de voz.
  const { impl } = fakeRed({ estadoDeGemini: 400 });
  const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/nota.ogg` }), false, impl);
  assert.equal(
    r.error, 'gemini_rechaza_el_codec',
    'un 400 con ogg/opus tiene su propio error: es el aviso de que hace falta ffmpeg'
  );
}

{
  // Un 400 con un formato que SI esta prometido es otra cosa, y no puede confundirse con
  // el problema del codec.
  const { impl } = fakeRed({ estadoDeGemini: 400 });
  const r = await procesarAdjunto(adjunto({ data_url: `${CHATWOOT}/x/nota.mp3` }), false, impl);
  assert.equal(r.error, 'gemini_400', 'un 400 con mp3 no es el problema del codec');
}

{
  // El limite del nivel gratuito tiene su propio codigo, para no confundirlo con Opus.
  const { impl } = fakeRed({ estadoDeGemini: 429 });
  const r = await procesarAdjunto(adjunto(), false, impl);
  assert.equal(r.error, 'gemini_limite_de_frecuencia');
}

// --- 4. EL GASTO SE REPORTA IGUAL ---------------------------------------

{
  // El modelo dice que no entiende nada. La llamada SE PAGO, asi que el gasto se reporta:
  // esconderlo es lo que el panel de metricas existe para evitar.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: 'ILEGIBLE' }] } }],
      usageMetadata: { promptTokenCount: 960, candidatesTokenCount: 3 }
    }
  });
  const r = await procesarAdjunto(adjunto(), false, impl);
  assert.equal(r.texto, null, 'sin transcripcion');
  assert.equal(r.error, 'ilegible');
  assert.deepEqual(r.uso, { input_tokens: 960, output_tokens: 3 }, 'pero el gasto SI se reporta');
}

// --- Los caminos que no gastan nada ------------------------------------

// --- EL VIDEO SE CLASIFICA, Y LAS CADENAS SE IGNORAN --------------------
//
// LO PIDIO DAVID: «imaginate que manden un video que no tenga nada que ver, solo que
// alguien decidio enviarlo a todos los contactos. Creo que no es necesario derivarlo, sino
// tiene nada que ver, pues que no lo pase a nadie, que lo ignore».
//
// Antes el video se derivaba a ciegas, que era demasiado brusco: una cadena reenviada le
// hacia perder el tiempo a recepcion.

{
  // Un video de una boca: se clasifica y se DERIVA. Nunca se ignora algo clinico.
  const { impl, registro } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: '{"categoria":"clinica","descripcion":""}' }] } }],
      usageMetadata: { promptTokenCount: 8000, candidatesTokenCount: 15 }
    }
  });
  const r = await procesarAdjunto(adjunto({ file_type: 'video', data_url: `${CHATWOOT}/x/boca.mp4` }), false, impl);
  assert.equal(r.derivar, true, 'un video clinico lo ve una persona');
  assert.equal(r.ignorar, false, 'y NUNCA se ignora');
  assert.equal(r.texto, null, 'sin describirlo');

  // SOLO LOS PRIMEROS DIEZ SEGUNDOS. Clasificar un video entero de tres minutos son unos
  // 46.000 tokens, como ocho turnos de texto, y para una cadena eso es tirar dinero.
  const aGemini = registro.find(p => p.url.includes('generativelanguage'))!;
  const parteDelArchivo = aGemini.body.contents[0].parts[1];
  assert.deepEqual(
    parteDelArchivo.video_metadata, { start_offset: '0s', end_offset: '10s' },
    'un video se clasifica con los primeros diez segundos, no entero'
  );
}

{
  // UNA CADENA REENVIADA, sin texto: se ignora. Nadie contesta.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: '{"categoria":"irrelevante","descripcion":"","seguridad":"alta"}' }] } }],
      usageMetadata: { promptTokenCount: 8000, candidatesTokenCount: 10 }
    }
  });
  const r = await procesarAdjunto(adjunto({ file_type: 'video', data_url: `${CHATWOOT}/x/cadena.mp4` }), false, impl);
  assert.equal(r.ignorar, true, 'una cadena reenviada no merece respuesta');
  assert.equal(r.derivar, false, 'y tampoco le hace perder el tiempo a recepcion');

  // PERO EL GASTO SE REPORTA IGUAL: «ignorar» significa no contestar, NO no enterarse. Si
  // no quedara rastro y el clasificador empezara a comerse fotos de pacientes, no habria
  // forma de verlo.
  assert.deepEqual(r.uso, { input_tokens: 8000, output_tokens: 10 });
  assert.equal(r.categoria, 'irrelevante', 'y consta por que se ignoro');
}

{
  // LA MISMA CADENA, PERO CON TEXTO: NO se ignora. Si alguien manda un video y escribe
  // «mira esto, ¿es normal?», eso es una conversacion y el texto manda.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: '{"categoria":"irrelevante","descripcion":"","seguridad":"alta"}' }] } }],
      usageMetadata: { promptTokenCount: 8000, candidatesTokenCount: 10 }
    }
  });
  const r = await procesarAdjunto(
    adjunto({ file_type: 'video', data_url: `${CHATWOOT}/x/cadena.mp4` }), true, impl
  );
  assert.equal(
    r.ignorar, false,
    'con texto NO se ignora: el paciente esta hablando, no reenviando'
  );
}

{
  // Y «otra» ES LA RED DE SEGURIDAD: si el modelo no esta seguro cae aqui, y el paciente
  // recibe respuesta. Solo se ignora cuando dice «irrelevante» explicitamente.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: '{"categoria":"otra","descripcion":"Una foto de un coche"}' }] } }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 12 }
    }
  });
  const r = await procesarAdjunto(adjunto({ file_type: 'image', data_url: `${CHATWOOT}/x/coche.jpg` }), false, impl);
  assert.equal(r.ignorar, false, '«otra» NO se ignora: es la red de seguridad');
  assert.equal(r.derivar, false);
  assert.match(String(r.texto), /coche/, 'y se describe, para que la conversacion siga');
}

{
  // Una clasificacion NO CONFIABLE no puede hacer que se ignore nada, ni aunque dijera
  // «irrelevante». Sin confianza no se tira nada.
  const { impl } = fakeRed({
    respuestaDeGemini: {
      candidates: [{ content: { parts: [{ text: 'esto es una cadena, ignoralo' }] } }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 8 }
    }
  });
  const r = await procesarAdjunto(adjunto({ file_type: 'image', data_url: `${CHATWOOT}/x/x.jpg` }), false, impl);
  assert.equal(r.ignorar, false, 'sin clasificacion confiable no se ignora nada');
  assert.equal(r.derivar, true, 'cae en clinica, que es el lado seguro');
}

{
  // Un adjunto ya rechazado no se toca.
  const { impl, registro } = fakeRed({});
  const r = await procesarAdjunto(adjunto({ file_type: 'image', data_url: `${CHATWOOT}/x/a.gif` }), false, impl);
  assert.equal(r.error, 'formato_no_soportado');
  assert.equal(registro.length, 0, 'un formato no soportado no se descarga: se sabe antes');
}

{
  // Sin clave no se llama a nadie, y los archivos siguen llegando a Hermes sin procesar.
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const { config } = await import('../src/config.js');
  (config as any).GEMINI_API_KEY = '';
  const { impl, registro } = fakeRed({});
  const r = await procesarAdjunto(adjunto(), false, impl);
  assert.equal(r.error, 'sin_clave_de_gemini');
  assert.equal(registro.length, 0);
  (config as any).GEMINI_API_KEY = original;
  process.env.GEMINI_API_KEY = original!;
}

{
  // Un archivo vacio no se manda al modelo.
  const { impl } = fakeRed({ bytesDelArchivo: 0 });
  assert.equal((await procesarAdjunto(adjunto(), false, impl)).error, 'archivo_vacio');
}

{
  // Y uno que MIENTE sobre su tamaño se corta al descargarlo. El tamaño declarado viene
  // del webhook: mirarlo antes de empezar no basta.
  const { impl } = fakeRed({ bytesDelArchivo: 21 * 1024 * 1024 });
  assert.equal(
    (await procesarAdjunto(adjunto({ file_size: 1000 }), false, impl)).error,
    'demasiado_grande_al_descargar',
    'declara 1 KB y manda 21 MB: se corta al leerlo, no al creerlo'
  );
}

console.log('media_gemini_test: OK');

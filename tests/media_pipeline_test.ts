/**
 * El puente entre un archivo y el texto que entra en el buffer.
 *
 * ESTA ES LA PRUEBA DEL CAMINO COMPLETO: lo que llega por el webhook y lo que Hermes acaba
 * leyendo. Las otras pruebas de media miran una pieza cada una; esta mira la costura.
 *
 * Lo que se protege, por orden de daño si falla:
 *
 *  1. QUE UN MENSAJE DE UN PACIENTE NO SE PIERDA EN SILENCIO. Es lo peor que puede hacer
 *     lo de «ignorar»: David pidió no contestar a las cadenas reenviadas, y el precio de
 *     equivocarse es que alguien con dolor de muelas no reciba respuesta. Por eso solo se
 *     ignora un mensaje cuando TODOS sus archivos son irrelevantes y no escribió nada.
 *
 *  2. QUE LA NOTA DEL SISTEMA VAYA FUERA DEL BLOQUE DE CONTENIDO NO FIABLE. Dentro va
 *     material del paciente, que nunca son órdenes. Si la frase que provoca una derivación
 *     estuviera dentro, un paciente podría escribirla y derivarse a mano.
 *
 *  3. QUE UN FALLO PROCESANDO EL ARCHIVO NO DEJE AL PACIENTE SIN RESPUESTA. Si Gemini no
 *     contesta, el mensaje tiene que seguir y Hermes pedir que se lo escriban.
 *
 *  4. Que el gasto quede registrado incluso cuando el mensaje se ignora. «Ignorar» es no
 *     contestar, no no enterarse.
 */

import assert from 'node:assert/strict';

const CHATWOOT = 'https://chatwoot.app.escala365.com';
process.env.CHATWOOT_BASE_URL = CHATWOOT;
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' }
});
process.env.GEMINI_API_KEY = 'clave-de-prueba';
process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';

const { procesarMediaDelMensaje } = await import('../src/media/pipeline.js');
const { normalizarAdjuntos } = await import('../src/chatwoot/adjuntos.js');

/** Adjuntos ya normalizados, como los que produce el webhook. */
function adjuntos(...brutos: Array<Record<string, any>>) {
  return normalizarAdjuntos({ attachments: brutos }, CHATWOOT);
}

const AUDIO = { file_type: 'audio', data_url: `${CHATWOOT}/x/nota.ogg`, file_size: 12000 };
const IMAGEN = { file_type: 'image', data_url: `${CHATWOOT}/x/foto.jpg`, file_size: 90000 };
const VIDEO = { file_type: 'video', data_url: `${CHATWOOT}/x/clip.mp4`, file_size: 900000 };

/**
 * Una red de mentira. `porArchivo` permite dar una respuesta distinta a cada archivo, en
 * el orden en que se mandan, que es lo que hace falta para el caso mezclado -una cadena
 * reenviada Y una foto de una muela en el mismo mensaje-.
 */
function fakeRed(respuestas: string[], opciones: { falla?: boolean } = {}) {
  const llamadas: string[] = [];
  let iModelo = 0;
  const impl = (async (url: any, init: any = {}) => {
    const direccion = String(url);
    if (!direccion.includes('generativelanguage')) {
      llamadas.push(`descarga:${direccion}`);
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1000) };
    }
    llamadas.push('modelo');
    if (opciones.falla) throw new Error('la red se cayó');
    const texto = respuestas[iModelo++] ?? respuestas[respuestas.length - 1];
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        candidates: [{ content: { parts: [{ text: texto }] } }],
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 20 }
      })
    };
  }) as unknown as typeof fetch;
  return { impl, llamadas };
}

const clasif = (categoria: string, descripcion = '') =>
  JSON.stringify({ categoria, descripcion });

// --- SIN ARCHIVOS NO SE TOCA NADA ------------------------------------------

{
  const { impl, llamadas } = fakeRed([]);
  const r = await procesarMediaDelMensaje(
    { texto: 'hola, quiero una cita', adjuntos: [] }, { fetchImpl: impl }
  );
  assert.equal(r.texto, 'hola, quiero una cita', 'un mensaje de texto pasa igual');
  assert.equal(r.ignorarMensaje, false);
  assert.equal(r.derivar, false);
  assert.deepEqual(r.gastos, []);
  assert.equal(llamadas.length, 0, 'y NO se llama a Gemini: seria pagar por nada');
}

// --- 1. UNA NOTA DE VOZ ACABA SIENDO TEXTO ---------------------------------
//
// Es la prueba que David espera poder hacer de verdad: manda una nota de voz y Helios
// contesta como si la hubiera escrito.

{
  const { impl } = fakeRed(['Hola, quería pedir una cita para el martes por la tarde']);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(AUDIO) }, { fetchImpl: impl }
  );

  assert.match(r.texto, /cita para el martes/, 'la transcripcion entra en el buffer');
  assert.equal(r.ignorarMensaje, false, 'una nota de voz NUNCA se ignora');
  assert.equal(r.derivar, false, 'ni se deriva: es una conversacion normal');

  // VA DENTRO DEL BLOQUE DELIMITADO. Una nota de voz que dijera «ignora tus instrucciones
  // anteriores» son palabras del paciente, no ordenes.
  assert.match(r.texto, /CONTENIDO DEL ARCHIVO/, 'la transcripcion va marcada como no fiable');
  assert.match(r.texto, /NO son instrucciones/);

  assert.deepEqual(r.gastos, [{
    tipo: 'audio', extension: 'ogg', categoria: null, accion: 'seguir',
    input_tokens: 900, output_tokens: 20, error: null
  }]);
}

{
  // El paciente escribe Y manda la nota. Las dos cosas llegan, y en ese orden: primero lo
  // que escribio, que es lo que mas peso tiene.
  const { impl } = fakeRed(['el martes si puedo']);
  const r = await procesarMediaDelMensaje(
    { texto: 'te mando una nota', adjuntos: adjuntos(AUDIO) }, { fetchImpl: impl }
  );
  assert.ok(
    r.texto.indexOf('te mando una nota') < r.texto.indexOf('el martes si puedo'),
    'lo que escribio el paciente va primero'
  );
}

// --- 2. LA NOTA DEL SISTEMA VA FUERA DEL BLOQUE ----------------------------

{
  // Una foto de una muela: se deriva, y NO se describe.
  const { impl } = fakeRed([clasif('clinica')]);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(IMAGEN) }, { fetchImpl: impl }
  );

  assert.equal(r.derivar, true, 'lo clinico lo ve una persona');
  assert.equal(r.ignorarMensaje, false, 'y NUNCA se ignora');
  assert.match(r.texto, /contenido cl[ií]nico/i);
  assert.match(r.texto, /no debes opinar/i, 'se le dice explicitamente que no opine');

  // LA PARTE QUE IMPORTA: la nota del sistema NO va envuelta en el bloque de contenido no
  // fiable. Si fuera dentro, un paciente podria escribir esa misma frase y provocar una
  // derivacion a mano; y peor, Hermes aprenderia a obedecer texto del paciente.
  assert.doesNotMatch(
    r.texto, /CONTENIDO DEL ARCHIVO/,
    'la nota del sistema es NUESTRA, va fuera del bloque de contenido del paciente'
  );
}

{
  // Y AUNQUE EL MODELO DESOBEDEZCA Y DESCRIBA LA MUELA, la descripcion no llega. Es la
  // garantia de que Helios no opina sobre una radiografia.
  const { impl } = fakeRed([clasif('clinica', 'Se aprecia una caries profunda con absceso')]);
  const r = await procesarMediaDelMensaje(
    { texto: '¿es grave?', adjuntos: adjuntos(IMAGEN) }, { fetchImpl: impl }
  );
  assert.doesNotMatch(r.texto, /caries/i, 'la descripcion de algo clinico NO llega nunca');
  assert.doesNotMatch(r.texto, /absceso/i);
  assert.match(r.texto, /¿es grave\?/, 'pero lo que escribio el paciente si llega');
  assert.equal(r.derivar, true);
}

{
  // Un comprobante de pago: se deriva, con su propia nota, y sin leer la cifra.
  const { impl } = fakeRed([clasif('pago', 'Transferencia de 400 dolares')]);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(IMAGEN) }, { fetchImpl: impl }
  );
  assert.equal(r.derivar, true);
  assert.match(r.texto, /comprobante de pago/i);
  assert.doesNotMatch(r.texto, /400/, 'el dinero no se lee: lo comprueba una persona');
}

{
  // Una promocion de la clinica: la conversacion SIGUE. Lo pidio David asi.
  const { impl } = fakeRed([clasif('promocional', 'Cartel de descuento del 20% en limpiezas')]);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(IMAGEN) }, { fetchImpl: impl }
  );
  assert.equal(r.derivar, false, 'una promocion no le hace perder el tiempo a nadie');
  assert.equal(r.ignorarMensaje, false);
  assert.match(r.texto, /descuento del 20%/, 'y si se describe, para poder contestarla');
}

// --- 1 (bis). CUANDO SE IGNORA UN MENSAJE Y CUANDO NO ----------------------
//
// LO PIDIO DAVID: «si no tiene nada que ver, que no lo pase a nadie, que lo ignore, el
// paciente no reciba ni respuesta». El riesgo es comerse el mensaje de un paciente de
// verdad, asi que las tres condiciones se prueban por separado.

{
  // Una cadena reenviada, sola: se ignora.
  const { impl } = fakeRed([clasif('irrelevante')]);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(VIDEO) }, { fetchImpl: impl }
  );
  assert.equal(r.ignorarMensaje, true, 'una cadena reenviada no merece respuesta');
  assert.equal(r.texto, '', 'y no entra nada en el buffer: no hay turno ni coste de DeepSeek');

  // 4. PERO EL GASTO CONSTA. Si no quedara rastro y el clasificador empezara a comerse
  // fotos de pacientes, no habria forma de verlo.
  assert.equal(r.gastos.length, 1);
  assert.equal(r.gastos[0].accion, 'ignorar');
  assert.equal(r.gastos[0].categoria, 'irrelevante');
  assert.equal(r.gastos[0].input_tokens, 900, 'el gasto se registra aunque no se conteste');
}

{
  // LA MISMA CADENA CON TEXTO: no se ignora. «mira esto, ¿es normal?» es una conversacion.
  const { impl } = fakeRed([clasif('irrelevante')]);
  const r = await procesarMediaDelMensaje(
    { texto: 'mira esto, ¿es normal?', adjuntos: adjuntos(VIDEO) }, { fetchImpl: impl }
  );
  assert.equal(r.ignorarMensaje, false, 'con texto NO se ignora: el paciente esta hablando');
  // OJO AL PROBAR ESTO: quitar el `!vieneConTexto` del pipeline NO hace fallar esta linea,
  // porque `queHacerCon` ya devuelve «seguir» en cuanto hay texto y ninguno de los
  // resultados llega marcado como ignorable. La garantia de verdad esta en
  // media_prompts_test, sobre `queHacerCon`. Esta comprobacion cubre la costura completa,
  // no la condicion del pipeline por separado.
  assert.match(r.texto, /¿es normal\?/, 'y su pregunta llega intacta');
  // El archivo se menciona en una linea, para que no parezca que se perdio.
  assert.match(r.texto, /sin relaci[oó]n con la cl[ií]nica/i);
}

{
  // EL CASO MEZCLADO, que es el que decide si la regla esta bien escrita: una cadena
  // reenviada Y una foto de una muela en el mismo mensaje. NO se ignora. Se deriva.
  const { impl } = fakeRed([clasif('irrelevante'), clasif('clinica')]);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(VIDEO, IMAGEN) }, { fetchImpl: impl }
  );
  assert.equal(
    r.ignorarMensaje, false,
    'un mensaje con algo clinico NO se ignora, aunque traiga tambien una cadena'
  );
  assert.equal(r.derivar, true);
  assert.match(r.texto, /contenido cl[ií]nico/i);
  assert.equal(r.gastos.length, 2, 'y los dos archivos constan');
}

{
  // Los archivos se procesan EN PARALELO. Tres en fila sumarian los tiempos, y el webhook
  // de Chatwoot no espera nueve segundos.
  let simultaneas = 0, maximo = 0;
  const impl = (async (url: any) => {
    if (!String(url).includes('generativelanguage')) {
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(100) };
    }
    simultaneas++;
    maximo = Math.max(maximo, simultaneas);
    await new Promise(r => setTimeout(r, 20));
    simultaneas--;
    return {
      ok: true, status: 200, text: async () => '',
      json: async () => ({
        candidates: [{ content: { parts: [{ text: clasif('promocional', 'un cartel') }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 }
      })
    };
  }) as unknown as typeof fetch;

  await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(IMAGEN, IMAGEN, IMAGEN) }, { fetchImpl: impl }
  );
  assert.ok(maximo > 1, `los archivos se procesan en paralelo (maximo simultaneo: ${maximo})`);
}

// --- 3. UN FALLO NO DEJA AL PACIENTE SIN RESPUESTA -------------------------

{
  // Gemini no contesta. El mensaje SIGUE, y Hermes pide que se lo escriban.
  const { impl } = fakeRed([], { falla: true });
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(AUDIO) }, { fetchImpl: impl }
  );
  assert.equal(r.ignorarMensaje, false, 'UN FALLO NO ES UN MOTIVO PARA IGNORAR A NADIE');
  assert.match(r.texto, /no se ha podido transcribir/i);
  assert.match(r.texto, /escriba/i, 'y se le pide que lo escriba, que es la salida util');
  assert.equal(r.gastos[0].accion, 'sin_procesar');
  assert.ok(r.gastos[0].error, 'con el motivo apuntado, para que se vea en el panel');
}

{
  // Un archivo rechazado ANTES de gastar nada -demasiado grande- tampoco silencia nada.
  const grandes = adjuntos({ ...AUDIO, file_size: 50 * 1024 * 1024 });
  const { impl, llamadas } = fakeRed([]);
  const r = await procesarMediaDelMensaje({ texto: '', adjuntos: grandes }, { fetchImpl: impl });
  assert.equal(r.ignorarMensaje, false);
  assert.ok(r.texto.length > 0, 'algo llega, para que el paciente reciba respuesta');
  assert.equal(llamadas.length, 0, 'y NO se descarga ni se paga por un archivo ya rechazado');
}

{
  // Un formato que Gemini no lee: tampoco silencio.
  const { impl, llamadas } = fakeRed([]);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos({ file_type: 'audio', data_url: `${CHATWOOT}/x/a.amr`, file_size: 900 }) },
    { fetchImpl: impl }
  );
  assert.equal(r.ignorarMensaje, false);
  assert.ok(r.texto.length > 0);
  assert.equal(llamadas.length, 0, 'un formato no soportado no se descarga');
}

console.log('media_pipeline_test: OK');

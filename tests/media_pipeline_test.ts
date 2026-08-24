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
import { readFileSync } from 'node:fs';

const CHATWOOT = 'https://chatwoot.app.escala365.com';
process.env.CHATWOOT_BASE_URL = CHATWOOT;
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios' }
});
process.env.GEMINI_API_KEY = 'clave-de-prueba';
process.env.GEMINI_MODEL = 'gemini-2.5-flash-lite';

const {
  procesarMediaDelMensaje, sinNotasDelSistema, PREFIJO_NOTA
} = await import('../src/media/pipeline.js');
const { detectSignals } = await import('../src/chatwoot/normalizer.js');
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

const clasif = (categoria: string, descripcion = '', seguridad = 'alta') =>
  JSON.stringify({ categoria, descripcion, seguridad });

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
  assert.match(r.texto, /No opines sobre ella/i, 'se le dice explicitamente que no opine');

  // «SE HA RECONOCIDO» Y NO «NO SE HA ANALIZADO». Lo señalo David al ver la primera foto de
  // una muela: «dice que Gemini no analizo la foto». No era verdad -si no la hubiera mirado
  // no sabria que es clinica- pero el texto lo daba a entender. Lo que NO se hace es
  // DESCRIBIRLA, y es deliberado, no un fallo.
  assert.match(r.texto, /se ha reconocido como contenido cl[ií]nico/i);
  assert.doesNotMatch(
    r.texto, /no se ha analizado/i,
    'el texto no puede dar a entender que el analisis fallo: se hizo, y a proposito no se describe'
  );

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
  // LA MISMA CADENA, PERO EL MODELO DUDANDO: no se ignora. Lo pidio David: «cuando se
  // vaya por ignorar es cuando este 100% seguro que es irrelevante». Sin ese 100%, el
  // paciente recibe respuesta.
  const { impl } = fakeRed([clasif('irrelevante', '', 'baja')]);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(VIDEO) }, { fetchImpl: impl }
  );
  assert.equal(r.ignorarMensaje, false, 'con duda NO se ignora, aunque diga «irrelevante»');
  assert.ok(r.texto.length > 0, 'algo llega, para que el paciente reciba respuesta');
}

{
  // Y si el modelo se olvida del campo, tampoco. El defecto es la duda.
  const { impl } = fakeRed([JSON.stringify({ categoria: 'irrelevante', descripcion: '' })]);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(VIDEO) }, { fetchImpl: impl }
  );
  assert.equal(
    r.ignorarMensaje, false,
    'sin el campo de seguridad NO se ignora: un modelo olvidadizo no puede callar a nadie'
  );
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
  assert.match(r.texto, /Nota del sistema/, 'y va marcada como nuestra');
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

// --- 5. EL GATEWAY NO PUEDE LEER SUS PROPIAS NOTAS COMO INTENCION DEL PACIENTE ---
//
// ESTO PASO. LO VIO DAVID EN EL PAYLOAD DEL 24 DE AGOSTO. La nota de una imagen clinica
// decia «tiene que verlo el PERSONAL de la clinica», y `detectSignals` busca /persona/
// para saber si alguien pide hablar con un humano. Resultado: cada foto de una muela
// levantaba `asks_for_human` sin que el paciente lo pidiera.
//
// Salio bien por casualidad -una foto clinica SI la tiene que ver alguien- pero era un
// acierto accidental, y con un comprobante de pago disparaba igual. Es la misma clase de
// problema que el bloque delimitado viene a evitar, solo que el que se confundia no era
// Hermes: era el propio Gateway leyendo su propio texto.

{
  // TODAS las notas llevan el prefijo. Si una se escapa, vuelve el fallo por esa via.
  const { impl } = fakeRed([clasif('clinica')]);
  const clinica = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(IMAGEN) }, { fetchImpl: impl }
  );
  assert.match(clinica.texto, new RegExp(PREFIJO_NOTA));

  const { impl: i2 } = fakeRed([clasif('pago')]);
  const pago = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(IMAGEN) }, { fetchImpl: i2 }
  );
  assert.match(pago.texto, new RegExp(PREFIJO_NOTA));

  const { impl: i3 } = fakeRed([], { falla: true });
  const fallo = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(AUDIO) }, { fetchImpl: i3 }
  );
  assert.match(fallo.texto, new RegExp(PREFIJO_NOTA), 'tambien la de un fallo');
}

{
  // LA EXPRESION Y EL PREFIJO NO PUEDEN SEPARARSE. La expresion esta escrita a mano -una
  // regex armada por concatenacion es donde se cuelan los escapes mal puestos- asi que
  // esto es lo que impide que se queden desincronizados.
  const inventada = '[' + PREFIJO_NOTA + 'cualquier cosa que se nos ocurra escribir aqui.]';
  assert.equal(
    sinNotasDelSistema('hola ' + inventada), 'hola',
    'la expresion tiene que reconocer cualquier nota hecha con el prefijo'
  );
}

{
  // EL TEXTO EXACTO QUE FALLO, con «personal» dentro. Se prueba con el texto viejo a
  // proposito: la nota nueva dice «el equipo» y ya no dispara, pero el filtro tiene que
  // funcionar igual sin depender de que las palabras esten bien elegidas. Son dos
  // cinturones, y este es el que no se rompe al reescribir una frase.
  const comoFallo = [
    'Creo que tengo carie',
    '[' + PREFIJO_NOTA + 'el paciente ha enviado una imagen. Tiene que verlo el personal de la clínica.]'
  ].join('\n');

  assert.equal(
    detectSignals(comoFallo).asks_for_human, true,
    'sin filtrar, la nota levanta la señal: ESTE es el fallo que se arregla'
  );
  assert.equal(
    detectSignals(sinNotasDelSistema(comoFallo)).asks_for_human, false,
    'filtrado, NO la levanta: el paciente no pidio hablar con nadie'
  );
  assert.equal(
    sinNotasDelSistema(comoFallo), 'Creo que tengo carie',
    'y lo que queda es exactamente lo que escribio el paciente'
  );
}

{
  // Y LO QUE NO SE PUEDE PERDER: una nota de voz que pide hablar con una persona. Eso lo
  // dijo el paciente, viaja dentro del bloque delimitado, y TIENE que levantar la señal.
  // Confundirlo con nuestras notas dejaria a alguien pidiendo ayuda sin que nadie se
  // enterara, que es peor que el fallo que esto arregla.
  const { impl } = fakeRed(['quiero hablar con una persona del equipo por favor']);
  const r = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(AUDIO) }, { fetchImpl: impl }
  );
  assert.equal(
    detectSignals(sinNotasDelSistema(r.texto)).asks_for_human, true,
    'lo que dice el paciente EN UNA NOTA DE VOZ si cuenta: el filtro no puede comerselo'
  );

  // Y lo mismo con una urgencia dicha en voz alta.
  const { impl: i2 } = fakeRed(['tengo mucha hinchazon y no puedo respirar bien']);
  const r2 = await procesarMediaDelMensaje(
    { texto: '', adjuntos: adjuntos(AUDIO) }, { fetchImpl: i2 }
  );
  assert.equal(
    detectSignals(sinNotasDelSistema(r2.texto)).possible_emergency, true,
    'una urgencia dicha en una nota de voz tiene que detectarse igual'
  );
}

{
  // Y LA COSTURA, que es donde estaba el fallo de verdad. Las comprobaciones de arriba
  // prueban que `sinNotasDelSistema` funciona; esta prueba que ALGUIEN LA USA.
  //
  // Es una comprobacion sobre el texto del archivo, y eso es debil -no ejecuta nada- pero
  // la alternativa era montar el orquestador entero con Supabase de mentira para
  // comprobar una linea. Se deja anotado: si algun dia hay una prueba que ejecute
  // processBufferEvent de verdad, esta se cambia por una de esas.
  const orquestador = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  assert.match(
    orquestador, /detectSignals\(\s*sinNotasDelSistema\(/,
    'el orquestador tiene que limpiar sus propias notas ANTES de detectar señales, o cada ' +
    'foto clinica vuelve a levantar asks_for_human sin que el paciente lo pida'
  );
  assert.doesNotMatch(
    orquestador, /detectSignals\(consolidatedText\)/,
    'y no puede quedar ninguna llamada sobre el texto crudo del lote'
  );
}

console.log('media_pipeline_test: OK');

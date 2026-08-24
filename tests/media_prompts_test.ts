/**
 * La clasificación de imágenes y sus prompts.
 *
 * ESTO ES LO QUE IMPIDE QUE HELIOS OPINE SOBRE UNA RADIOGRAFÍA, así que es la prueba más
 * importante de todo el bloque de archivos.
 *
 * Lo que se protege, por orden de daño:
 *
 *  1. QUE UNA IMAGEN CLINICA NUNCA SE DESCRIBA. Ni con el JSON roto, ni con una
 *     categoría inventada, ni cuando el modelo contesta en prosa, ni cuando devuelve una
 *     descripción de una boca a pesar de que el prompt se lo prohíbe. Un bot opinando
 *     sobre la muela de un paciente es lo peor que puede pasar aquí.
 *
 *  2. QUE EL FALLO SEA HACIA «CLINICA». Equivocarse hacia «que lo vea un dentista» es
 *     recuperable; equivocarse hacia «descríbeme esta radiografía» no.
 *
 *  3. Que el prompt de audio prohíba resumir. Gemini hace lo que le pidas, y un resumen
 *     del audio no es lo que el paciente dijo. Sobre eso se reservan citas.
 */

import assert from 'node:assert/strict';
import {
  CATEGORIAS_DE_IMAGEN,
  ILEGIBLE,
  PROMPT_AUDIO,
  PROMPT_DOCUMENTO,
  PROMPT_IMAGEN,
  leerClasificacionDeImagen
} from '../src/media/prompts.js';

// --- 1 y 2. UNA IMAGEN CLINICA NUNCA SE DESCRIBE ---------------------------

{
  // El caso bueno: el modelo hace lo que se le pide.
  const clinica = leerClasificacionDeImagen('{"categoria":"clinica","descripcion":""}');
  assert.equal(clinica.categoria, 'clinica');
  assert.equal(clinica.descripcion, '', 'una imagen clinica no lleva descripcion');
  assert.equal(clinica.confiable, true);
}

{
  // EL CASO QUE MAS IMPORTA: el modelo IGNORA el prompt y describe la boca igualmente.
  // La regla está en el prompt, pero un prompt es una petición; esto es una garantía.
  const desobediente = leerClasificacionDeImagen(
    '{"categoria":"clinica","descripcion":"Se aprecia una caries profunda en el molar inferior derecho con inflamacion de la encia"}'
  );
  assert.equal(
    desobediente.descripcion, '',
    'AUNQUE el modelo describa una imagen clinica, la descripcion NO puede llegar a la ' +
    'conversacion. Si esto falla, Helios acaba dando una opinion medica'
  );
  assert.equal(desobediente.categoria, 'clinica');
}

{
  // Lo mismo con un comprobante de pago: se reconoce, no se lee. El dinero lo ve una
  // persona, y una cifra mal leida por un modelo es una discusion con un paciente.
  const pago = leerClasificacionDeImagen(
    '{"categoria":"pago","descripcion":"Transferencia de 400 dolares al banco X"}'
  );
  assert.equal(pago.categoria, 'pago');
  assert.equal(pago.descripcion, '', 'un comprobante se reconoce, no se transcribe');
}

{
  // Y LO QUE SI SE DESCRIBE, se describe: es la única rama con texto libre.
  const promo = leerClasificacionDeImagen(
    '{"categoria":"promocional","descripcion":"Cartel de descuento del 20% en limpiezas"}'
  );
  assert.equal(promo.categoria, 'promocional');
  assert.match(promo.descripcion, /descuento del 20%/, 'una promocion si se describe');

  const otra = leerClasificacionDeImagen('{"categoria":"otra","descripcion":"Un perro en un sofa"}');
  assert.match(otra.descripcion, /perro/);
}

// --- TODO LO QUE SALE MAL CAE EN «CLINICA» ---------------------------------

{
  const basura: Array<[unknown, string]> = [
    ['', 'respuesta vacia'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['no soy json', 'prosa en vez de JSON'],
    ['{roto', 'JSON a medias'],
    ['{"categoria":"inventada","descripcion":"algo"}', 'una categoria que no existe'],
    ['{"categoria":"","descripcion":"algo"}', 'categoria vacia'],
    ['{"descripcion":"algo"}', 'sin categoria'],
    ['[]', 'una lista en vez de un objeto'],
    ['"clinica"', 'una cadena en vez de un objeto'],
    ['{"categoria":"CLINICA "}', 'con mayusculas y espacios sobra: se normaliza'],
    ['La imagen muestra una muela con caries', 'el modelo contestando en prosa']
  ];

  for (const [entrada, caso] of basura) {
    const r = leerClasificacionDeImagen(entrada);
    assert.equal(r.categoria, 'clinica', `${caso}: tiene que caer en «clinica» y derivarse`);
    assert.equal(r.descripcion, '', `${caso}: y sin descripcion`);
  }

  // «CLINICA » con espacios SI es valida tras normalizar, asi que esa marca como
  // confiable. El resto, no: y esa diferencia sirve para saber si el modelo esta
  // devolviendo basura de forma sistematica.
  assert.equal(leerClasificacionDeImagen('{"categoria":"CLINICA "}').confiable, true);
  assert.equal(leerClasificacionDeImagen('no soy json').confiable, false);
  assert.equal(
    leerClasificacionDeImagen('{"categoria":"inventada"}').confiable, false,
    'una categoria inventada NO es una clasificacion confiable, aunque se trate como clinica'
  );
}

{
  // El modelo envuelve el JSON en markdown aunque se le pida que no. Eso no puede
  // convertir una promocion en una imagen clinica.
  const enMarkdown = leerClasificacionDeImagen(
    '```json\n{"categoria":"promocional","descripcion":"Cartel de la clinica"}\n```'
  );
  assert.equal(enMarkdown.categoria, 'promocional', 'el markdown alrededor no debe romper la lectura');
  assert.match(enMarkdown.descripcion, /Cartel/);
}

{
  // Una descripcion larguisima no puede inundar el contexto ni la factura.
  const larga = leerClasificacionDeImagen(
    JSON.stringify({ categoria: 'otra', descripcion: 'x'.repeat(5000) })
  );
  assert.ok(larga.descripcion.length <= 500, 'la descripcion se limita');
}

// --- 3. LOS PROMPTS DICEN LO QUE TIENEN QUE DECIR --------------------------

{
  // AUDIO. Las tres prohibiciones son las tres cosas que un modelo generalista hace por
  // su cuenta: resumir, interpretar y contestar.
  assert.match(PROMPT_AUDIO, /literalmente/i, 'el audio se transcribe literal');
  assert.match(PROMPT_AUDIO, /NO resumas/, 'y NO se resume: un resumen no es lo que dijo el paciente');
  assert.match(PROMPT_AUDIO, /NO interpretes/);
  assert.match(PROMPT_AUDIO, /NO respondas/, 'ni se contesta a lo que suene a pregunta');
  assert.ok(PROMPT_AUDIO.includes(ILEGIBLE), 'y hay una marca fija para «no se entiende»');
}

{
  // IMAGEN. Lo que no puede faltar sin que la protección desaparezca.
  for (const categoria of CATEGORIAS_DE_IMAGEN) {
    assert.ok(PROMPT_IMAGEN.includes(`"${categoria}"`), `la categoria ${categoria} tiene que estar en el prompt`);
  }
  assert.match(PROMPT_IMAGEN, /NO sugieras un\s*\n?\s*diagn[oó]stico/i, 'prohibicion explicita de diagnosticar');
  assert.match(PROMPT_IMAGEN, /deja "descripcion" como cadena vac[ií]a/i, 'lo clinico no se describe');
  assert.match(PROMPT_IMAGEN, /Ante cualquier duda.*elige "clinica"/s, 'la duda cae del lado seguro');
}

{
  // DOCUMENTO. La segunda capa contra la inyeccion: la primera es el bloque delimitado.
  assert.match(PROMPT_DOCUMENTO, /NO las sigas/, 'un documento no da ordenes');
  assert.match(PROMPT_DOCUMENTO, /NO resumas/);
  assert.ok(PROMPT_DOCUMENTO.includes(ILEGIBLE));
}

console.log('media_prompts_test: OK');

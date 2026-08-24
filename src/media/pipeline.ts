/**
 * El puente entre un archivo que llega por Chatwoot y el texto que entra en el buffer.
 *
 * DONDE ENCAJA. `normalizarAdjuntos` ya clasificó y validó la URL; `procesarAdjunto` ya
 * habló con Gemini. Aquí se juntan las piezas: se decide qué texto acaba en el buffer, si
 * hay que derivar, y si el mensaje se ignora entero.
 *
 * POR QUE ESTA APARTE DEL WEBHOOK. En `server.ts` esto serían cuarenta líneas dentro de una
 * función de trescientas, imposibles de probar sin levantar un servidor. Aquí se prueba con
 * un `fetch` de mentira y sin Supabase.
 *
 * LO QUE ESTE MODULO NO HACE: derivar. Compone el texto -incluida la línea que dice que
 * hay algo que tiene que ver una persona- y Hermes decide con su herramienta de siempre.
 * Es el reparto que pidió David: «siempre pasar a helios hermes, antes del texto, si viene
 * de un audio, imagen, o algún otro documento». Hacer el handoff aquí significaría meter
 * mano en la cadena de derivación que ya funciona en producción, y con más riesgo que
 * ganancia mientras no haya una prueba de verdad hecha.
 */

import { textoDelAdjunto, type AdjuntoNormalizado } from '../chatwoot/adjuntos.js';
import { procesarAdjunto, type ResultadoDeMedia } from './gemini.js';

/** Lo que consumió un archivo, para que el Adapter le ponga precio. */
export interface GastoDeMedia {
  tipo: AdjuntoNormalizado['tipo'];
  extension: string;
  categoria: string | null;
  accion: 'seguir' | 'derivar' | 'ignorar' | 'sin_procesar';
  input_tokens: number;
  output_tokens: number;
  error: string | null;
}

export interface MensajeConMedia {
  /** El texto que entra en el buffer: lo que escribió el paciente más los archivos. */
  texto: string;
  /**
   * true si NO hay que contestar nada ni meter nada en el buffer. Solo puede pasar cuando
   * TODOS los archivos son irrelevantes y el paciente no escribió nada.
   */
  ignorarMensaje: boolean;
  /** true si algo de esto lo tiene que ver una persona. */
  derivar: boolean;
  /** Un apunte por archivo, para el panel de métricas. */
  gastos: GastoDeMedia[];
}

/**
 * El texto de un archivo derivado.
 *
 * SON NUESTRAS PALABRAS, NO LAS DEL MODELO, y van FUERA del bloque delimitado. Esa es la
 * diferencia que importa: dentro del bloque va material del paciente, que nunca son
 * órdenes; esto es una nota del sistema y sí lo es. Si estuviera dentro, un paciente podría
 * escribir la misma frase y provocar una derivación a mano.
 */
function textoDeDerivacion(adjunto: AdjuntoNormalizado, categoria: string | null): string {
  const que = adjunto.tipo === 'video' ? 'un vídeo' : 'una imagen';

  if (categoria === 'pago') {
    return `[El paciente ha enviado ${que} con lo que parece un comprobante de pago. ` +
      `No se ha leído su contenido a propósito. Tiene que verlo una persona del equipo.]`;
  }
  return `[El paciente ha enviado ${que} de contenido clínico. NO se ha analizado, y no ` +
    `debes opinar sobre ello ni preguntar por síntomas. Tiene que verlo el personal ` +
    `de la clínica.]`;
}

/** El texto de un archivo que no se pudo procesar. Dice qué pasó, sin detalle técnico. */
function textoDeFallo(adjunto: AdjuntoNormalizado, error: string): string {
  // El códec de WhatsApp es el único fallo con nombre propio, porque si aparece no es un
  // caso aislado: fallarían TODAS las notas de voz.
  if (error === 'gemini_rechaza_el_codec' || adjunto.tipo === 'audio') {
    return '[El paciente ha enviado una nota de voz que no se ha podido transcribir. ' +
      'Pídele con amabilidad que te lo escriba.]';
  }
  return textoDelAdjunto({ ...adjunto, rechazo: adjunto.rechazo ?? error }, null);
}

/** Compone el texto de un archivo ya procesado. */
export function textoDeMedia(
  adjunto: AdjuntoNormalizado,
  resultado: ResultadoDeMedia
): string {
  if (resultado.derivar) return textoDeDerivacion(adjunto, resultado.categoria);

  // UN ARCHIVO IRRELEVANTE SE NOMBRA, NO SE ESCONDE. Esta rama solo se alcanza cuando el
  // mensaje SI se contesta -porque el paciente escribio algo, o porque otro archivo del
  // mismo mensaje no era irrelevante-. Y tiene que decir POR QUE no aporta: con el texto
  // genérico de «sin contenido legible», Hermes creería que algo falló y se pondría a
  // disculparse por un meme.
  if (resultado.categoria === 'irrelevante') {
    return '[El paciente ha enviado un archivo sin relación con la clínica. No hace falta ' +
      'comentarlo ni disculparse por ello.]';
  }

  if (resultado.error && !resultado.texto) return textoDeFallo(adjunto, resultado.error);
  return textoDelAdjunto(adjunto, resultado.texto);
}

/**
 * Procesa todos los archivos de un mensaje y devuelve el texto final.
 *
 * LOS ARCHIVOS SE PROCESAN EN PARALELO. Son como mucho tres -lo limita
 * `normalizarAdjuntos`- y hacerlos en fila sumaría los tiempos: tres archivos de tres
 * segundos serían nueve, y el webhook de Chatwoot no espera tanto.
 */
export async function procesarMediaDelMensaje(
  entrada: {
    texto: string;
    adjuntos: AdjuntoNormalizado[];
  },
  opciones: { fetchImpl?: typeof fetch } = {}
): Promise<MensajeConMedia> {
  const textoDelPaciente = String(entrada.texto ?? '').trim();
  const adjuntos = entrada.adjuntos ?? [];

  if (adjuntos.length === 0) {
    return { texto: textoDelPaciente, ignorarMensaje: false, derivar: false, gastos: [] };
  }

  const vieneConTexto = textoDelPaciente.length > 0;

  const resultados = await Promise.all(
    adjuntos.map(adjunto => procesarAdjunto(adjunto, vieneConTexto, opciones.fetchImpl ?? fetch))
  );

  const gastos: GastoDeMedia[] = resultados.map((r, i) => ({
    tipo: adjuntos[i].tipo,
    extension: adjuntos[i].extension,
    categoria: r.categoria,
    accion: r.derivar ? 'derivar' : r.ignorar ? 'ignorar' : r.uso ? 'seguir' : 'sin_procesar',
    input_tokens: r.uso?.input_tokens ?? 0,
    output_tokens: r.uso?.output_tokens ?? 0,
    error: r.error
  }));

  // SE IGNORA EL MENSAJE ENTERO SOLO SI TODO ES IGNORABLE. Un mensaje con una cadena
  // reenviada Y una foto de una muela no se ignora: se deriva.
  //
  // EL `!vieneConTexto` DE AQUI ES UN SEGUNDO CINTURON, y conviene saberlo: la protección
  // de verdad está en `queHacerCon`, que ya devuelve «seguir» en cuanto el paciente escribe
  // algo, así que quitar esta condición no cambia el resultado hoy. Se queda porque es la
  // línea que decide el silencio de un paciente, y esa no depende de que la función de al
  // lado siga comportándose igual dentro de seis meses.
  const ignorarMensaje = !vieneConTexto && resultados.every(r => r.ignorar);
  if (ignorarMensaje) {
    return { texto: '', ignorarMensaje: true, derivar: false, gastos };
  }

  const partes: string[] = [];
  if (textoDelPaciente) partes.push(textoDelPaciente);

  resultados.forEach((resultado, i) => {
    partes.push(textoDeMedia(adjuntos[i], resultado));
  });

  return {
    texto: partes.join('\n\n'),
    ignorarMensaje: false,
    derivar: resultados.some(r => r.derivar),
    gastos
  };
}

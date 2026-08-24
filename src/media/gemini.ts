/**
 * Convierte el archivo de un paciente en texto, llamando a Gemini.
 *
 * DONDE ENCAJA ESTO. El paciente manda una nota de voz por WhatsApp; Chatwoot dispara el
 * webhook; el normalizador clasifica el adjunto y comprueba que su URL es de Chatwoot; y
 * aquí se descarga, se manda al modelo y se devuelve el texto. Desde ahí no cambia nada:
 * el buffer, Hermes, el contrato y las métricas siguen viendo texto.
 *
 * POR QUE ESTA EN EL GATEWAY Y NO EN EL PERFIL DE HERMES. El archivo solo existe aquí; el
 * turno de Hermes ya tarda entre 15 y 27 segundos y meterle esto dentro lo empeora; y
 * sobre todo, LA FRONTERA DE SEGURIDAD TIENE QUE ESTAR ANTES DE HERMES. Si Hermes marcara
 * el contenido del archivo como no fiable, ya sería tarde: el texto crudo estaría dentro
 * de su contexto.
 *
 * EL REPARTO, como lo pidió David: aquí se convierte el archivo en texto marcado y NO SE
 * DECIDE NADA. Hermes lee la marca y decide si continúa, deriva o pide que se lo escriban.
 * Lo único que este módulo decide es si la imagen es clínica, y eso porque la decisión
 * consiste precisamente en NO mirarla.
 */

import { config } from '../config.js';
import type { AdjuntoNormalizado, TipoDeAdjunto } from '../chatwoot/adjuntos.js';
import { urlDeAdjuntoEsSegura } from '../chatwoot/adjuntos.js';
import {
  ILEGIBLE,
  PROMPT_AUDIO,
  PROMPT_DOCUMENTO,
  PROMPT_IMAGEN,
  leerClasificacionDeImagen,
  queHacerCon,
  type CategoriaDeImagen
} from './prompts.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Tipos MIME que se declaran al modelo, por extensión. */
const MIME: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mp3', aiff: 'audio/aiff', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mpeg: 'video/mpeg', mpg: 'video/mpg', mov: 'video/mov',
  avi: 'video/avi', flv: 'video/x-flv', webm: 'video/webm', wmv: 'video/wmv',
  '3gp': 'video/3gpp', '3gpp': 'video/3gpp',
  pdf: 'application/pdf'
};

/**
 * Los tipos MIME que se aceptan de la cabecera `content-type`.
 *
 * ES UNA LISTA CERRADA A PROPOSITO, y no un «si empieza por audio/ vale». El content-type
 * lo pone Chatwoot -un host ya comprobado-, asi que fiarse no es descabellado, pero lo que
 * se le declara a Gemini tiene que salir de una lista nuestra: es lo que impide que una
 * cabecera raroa acabe convertida en un campo `mime_type` arbitrario en la llamada.
 *
 * Y SE COMPRUEBA QUE LA FAMILIA CUADRE con lo que dijo Chatwoot en `file_type`. Si el
 * webhook dice «audio» y la cabecera dice `image/png`, algo no encaja y no se manda: son
 * dos fuentes que deberian coincidir, y cuando no lo hacen lo prudente es no adivinar.
 */
const MIME_POR_CABECERA: Record<string, TipoDeAdjunto> = {
  'audio/wav': 'audio', 'audio/x-wav': 'audio', 'audio/wave': 'audio',
  'audio/mp3': 'audio', 'audio/mpeg': 'audio', 'audio/mpg': 'audio',
  'audio/aiff': 'audio', 'audio/x-aiff': 'audio',
  'audio/aac': 'audio', 'audio/flac': 'audio', 'audio/x-flac': 'audio',
  'audio/ogg': 'audio', 'audio/opus': 'audio', 'audio/mp4': 'audio', 'audio/m4a': 'audio',
  'image/png': 'imagen', 'image/jpeg': 'imagen', 'image/jpg': 'imagen',
  'image/webp': 'imagen', 'image/heic': 'imagen', 'image/heif': 'imagen',
  'video/mp4': 'video', 'video/mpeg': 'video', 'video/quicktime': 'video',
  'video/x-msvideo': 'video', 'video/x-flv': 'video', 'video/webm': 'video',
  'video/x-ms-wmv': 'video', 'video/3gpp': 'video',
  'application/pdf': 'documento'
};

/**
 * Lo que se le declara a Gemini cuando la cabecera es la unica pista.
 *
 * Gemini no acepta cualquier nombre: `audio/opus` y `audio/x-wav` son validos en HTTP
 * pero no estan en su lista. Se traducen al nombre que el si conoce.
 */
const NOMBRE_PARA_GEMINI: Record<string, string> = {
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
  'audio/mpeg': 'audio/mp3', 'audio/mpg': 'audio/mp3',
  'audio/x-aiff': 'audio/aiff', 'audio/x-flac': 'audio/flac',
  // OGG OPUS: el formato REAL de las notas de voz de WhatsApp. Google documenta «OGG
  // Vorbis» y no dice nada de Opus, asi que se declara como audio/ogg y se prueba. Si lo
  // rechaza, el error sale con nombre propio y la solucion es convertir con ffmpeg.
  'audio/opus': 'audio/ogg',
  'audio/m4a': 'audio/mp4',
  'image/jpg': 'image/jpeg',
  'video/quicktime': 'video/mov', 'video/x-msvideo': 'video/avi',
  'video/x-ms-wmv': 'video/wmv'
};

/**
 * Saca de la respuesta de error de Google lo que sirve para arreglarlo.
 *
 * Su formato es `{ error: { code, message, status } }`. `status` es un codigo corto y
 * estable -NOT_FOUND, PERMISSION_DENIED, RESOURCE_EXHAUSTED- que cabe en la columna del
 * panel; `message` es la frase larga que dice exactamente que pasa, y esa va al log.
 *
 * NO SE MANDA EL CUERPO ENTERO A LA COLUMNA. Puede traer cientos de caracteres y el panel
 * no es un visor de logs; y un texto largo del proveedor en un campo que se muestra es
 * una via de entrada de contenido que no controlamos.
 */
function leerErrorDeGoogle(cuerpo: string): { estado: string; mensaje: string } {
  try {
    const datos = JSON.parse(String(cuerpo || ''));
    return {
      // Solo letras, numeros y guion bajo: es un codigo, no texto libre.
      estado: String(datos?.error?.status ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40),
      mensaje: String(datos?.error?.message ?? '').slice(0, 400)
    };
  } catch {
    return { estado: '', mensaje: String(cuerpo || '').slice(0, 400) };
  }
}

function mimeAceptado(contentType: string, tipo: AdjuntoNormalizado['tipo']): string | null {
  const limpio = String(contentType || '').trim().toLowerCase();
  const familia = MIME_POR_CABECERA[limpio];
  if (!familia) return null;
  if (familia !== tipo) return null;
  return NOMBRE_PARA_GEMINI[limpio] || limpio;
}

export interface ResultadoDeMedia {
  /** El texto extraído, o null si no se pudo. */
  texto: string | null;
  /** Solo para imágenes. */
  categoria: CategoriaDeImagen | null;
  /** true si esto lo tiene que ver una persona y Hermes no debe seguir solo. */
  derivar: boolean;
  /**
   * true si NO hay que contestar nada: una cadena reenviada, un meme, publicidad de otro
   * negocio. NO significa «no enterarse»: se registra igual, con su clasificación y su
   * coste, para que se pueda comprobar que no se está comiendo mensajes de pacientes.
   */
  ignorar: boolean;
  /** Tokens que consumió, para que el Adapter le ponga precio. */
  uso: { input_tokens: number; output_tokens: number } | null;
  /** Por qué no se pudo, o null. */
  error: string | null;
}

const sinProcesar = (error: string): ResultadoDeMedia =>
  ({ texto: null, categoria: null, derivar: false, ignorar: false, uso: null, error });

/**
 * Descarga el archivo, con el tope de tamaño aplicado MIENTRAS se lee.
 *
 * NO BASTA CON MIRAR EL TAMAÑO DECLARADO. `file_size` viene del webhook y `content-length`
 * lo pone el servidor: los dos se pueden quedar cortos, a propósito o por error. Si solo
 * se comprobara antes de empezar, un archivo que declare 1 KB y mande 500 MB llenaría la
 * memoria del proceso. Se cuenta lo que llega de verdad y se corta.
 *
 * Y SE VUELVE A VALIDAR LA URL aquí, aunque el normalizador ya lo hizo. Es la línea que
 * de verdad protege: la comprobación de antes se hizo sobre otro objeto, en otro momento,
 * y entre medias el dato ha pasado por una tabla. La que cuenta es la que está pegada a
 * la llamada de red.
 */
async function descargar(
  url: string,
  fetchImpl: typeof fetch
): Promise<{ bytes: Uint8Array; contentType: string } | { error: string }> {
  if (!urlDeAdjuntoEsSegura(url, config.CHATWOOT_BASE_URL || '')) {
    return { error: 'url_no_es_de_chatwoot' };
  }

  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), config.MEDIA_TIMEOUT_MS);
  try {
    // El token de Chatwoot va porque algunos despliegues sirven los adjuntos detrás de
    // autenticación. Mandarlo SOLO es seguro porque el host ya está comprobado: sin esa
    // comprobación, esta línea le estaría entregando nuestra credencial a quien pusiera
    // una URL en el webhook.
    const respuesta = await fetchImpl(url, {
      signal: corte.signal,
      headers: config.CHATWOOT_API_TOKEN
        ? { api_access_token: config.CHATWOOT_API_TOKEN }
        : {}
    });
    if (!respuesta.ok) return { error: `descarga_${respuesta.status}` };

    // EL CONTENT-TYPE ES QUIEN SABE DE VERDAD QUE ES ESTO. La extension de la URL es una
    // pista y a veces no la hay: WhatsApp nombra las notas de voz con puntos en la fecha
    // -AUDIO-2026-08-24-14.47.31- y ActiveStorage sirve blobs sin nombre. Chatwoot si
    // guarda el tipo, y lo manda en esta cabecera.
    const contentType = String(respuesta.headers?.get?.('content-type') ?? '')
      .split(';')[0].trim().toLowerCase();

    const crudo = new Uint8Array(await respuesta.arrayBuffer());
    if (crudo.byteLength > 20 * 1024 * 1024) return { error: 'demasiado_grande_al_descargar' };
    if (crudo.byteLength === 0) return { error: 'archivo_vacio' };
    return { bytes: crudo, contentType };
  } catch (error: any) {
    return { error: error?.name === 'AbortError' ? 'descarga_agotó_el_tiempo' : 'descarga_fallida' };
  } finally {
    clearTimeout(reloj);
  }
}

/**
 * Procesa un adjunto y devuelve el texto que entrará en la conversación.
 *
 * EL VIDEO NO SE PROCESA, y es deliberado: un vídeo de una boca es más clínico que una
 * foto y en tokens es mucho más caro. Se reconoce y se deriva.
 */
export async function procesarAdjunto(
  adjunto: AdjuntoNormalizado,
  /**
   * ¿El paciente escribió algo además de mandar el archivo? Decide si una cadena
   * reenviada se puede ignorar: con texto es una conversación, no una cadena.
   */
  vieneConTexto: boolean = false,
  fetchImpl: typeof fetch = fetch
): Promise<ResultadoDeMedia> {
  if (adjunto.rechazo) return sinProcesar(adjunto.rechazo);
  if (!config.GEMINI_API_KEY) return sinProcesar('sin_clave_de_gemini');

  const bajada = await descargar(adjunto.url, fetchImpl);
  if ('error' in bajada) return sinProcesar(bajada.error);

  // EL ORDEN IMPORTA: primero la extension, que cuando existe es fiable y no depende de
  // como sirva el archivo Chatwoot; y si no dice nada, el content-type de la descarga.
  //
  // ANTES ESTO ERA SOLO LA EXTENSION, Y ANTES DE DESCARGAR. Es lo que dejo sin
  // transcribir la primera nota de voz de verdad, el 24 de agosto: se rechazaba sin
  // haberlo intentado, gastando cero y sin forma de saber que el archivo estaba bien.
  const mime = MIME[adjunto.extension] || mimeAceptado(bajada.contentType, adjunto.tipo);
  if (!mime) {
    return sinProcesar(
      bajada.contentType ? `formato_no_soportado_${bajada.contentType.replace('/', '_')}` : 'formato_no_soportado'
    );
  }

  // El video se clasifica con el MISMO prompt que la imagen: la pregunta es la misma
  // -¿es una boca, un pago, una promocion o una cadena?- y tener un prompt distinto
  // significaria mantener dos versiones de la misma regla de seguridad.
  const esVisual = adjunto.tipo === 'imagen' || adjunto.tipo === 'video';
  const prompt = adjunto.tipo === 'audio' ? PROMPT_AUDIO
    : esVisual ? PROMPT_IMAGEN
    : PROMPT_DOCUMENTO;

  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), config.MEDIA_TIMEOUT_MS);
  let datos: any;
  try {
    const respuesta = await fetchImpl(
      `${API}/${encodeURIComponent(config.GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        signal: corte.signal,
        headers: {
          'content-type': 'application/json',
          // La clave va en cabecera y NO en la query: una URL con la clave dentro acaba
          // en logs de acceso, en trazas y en mensajes de error.
          'x-goog-api-key': config.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              {
                inline_data: { mime_type: mime, data: Buffer.from(bajada.bytes).toString('base64') },
                // SOLO LOS PRIMEROS DIEZ SEGUNDOS DE UN VIDEO. Clasificar uno entero es
                // caro: uno de tres minutos son unos 46.000 tokens, como OCHO turnos de
                // texto, y para una cadena reenviada eso es tirar dinero. Para saber si es
                // una boca o un meme sobran diez segundos.
                ...(adjunto.tipo === 'video'
                  ? { video_metadata: { start_offset: '0s', end_offset: '10s' } }
                  : {})
              }
            ]
          }],
          generationConfig: {
            // Cero temperatura: se le pide transcribir y clasificar, no crear. Con
            // temperatura alta, la misma nota de voz daría transcripciones distintas.
            temperature: 0,
            maxOutputTokens: 2048
          }
        })
      }
    );

    if (!respuesta.ok) {
      const cuerpo = await respuesta.text().catch(() => '');

      // EL CUERPO DEL ERROR SE REGISTRA, y esto no es un detalle. Antes se pedia y se
      // TIRABA -habia un `${cuerpo ? '' : ''}` que siempre daba cadena vacia-, asi que
      // un 404 llegaba al panel como «gemini_404» y nada mas. Google explica en ese
      // cuerpo exactamente que modelo no encuentra y para que version de la API; tener
      // que averiguarlo desde fuera costo una prueba entera con un paciente esperando.
      const detalle = leerErrorDeGoogle(cuerpo);
      console.error(JSON.stringify({
        event: 'gemini_rechazo_la_llamada',
        http_status: respuesta.status,
        modelo: config.GEMINI_MODEL,
        estado_de_google: detalle.estado,
        mensaje_de_google: detalle.mensaje,
        tipo_de_archivo: adjunto.tipo,
        extension: adjunto.extension,
        mime_declarado: mime
      }));

      // UN 404 NO ES UN FALLO DE ESTE ARCHIVO: es que el modelo no existe para esta clave
      // o para esta version de la API, y entonces fallan TODAS las llamadas. Se marca
      // aparte por el mismo motivo que el codec: para que un problema sistematico no
      // parezca uno aislado en el panel.
      if (respuesta.status === 404) {
        return sinProcesar(`gemini_modelo_no_existe_${config.GEMINI_MODEL}`.slice(0, 80));
      }
      if (respuesta.status === 401 || respuesta.status === 403) {
        return sinProcesar(`gemini_clave_rechazada_${detalle.estado}`.slice(0, 80));
      }
      // EL CASO QUE HAY QUE DISTINGUIR: 400 con un audio ogg/opus significa que Gemini no
      // lee el codec de WhatsApp, y entonces NO es un fallo aislado: fallarían TODAS las
      // notas de voz. Se marca aparte para que se vea en el panel como lo que es, con su
      // solución conocida -convertir con ffmpeg antes de mandarlo-.
      if (respuesta.status === 400 && adjunto.soporte === 'probable') {
        return sinProcesar('gemini_rechaza_el_codec');
      }
      if (respuesta.status === 429) return sinProcesar('gemini_limite_de_frecuencia');
      return sinProcesar(
        detalle.estado ? `gemini_${respuesta.status}_${detalle.estado}`.slice(0, 80)
          : `gemini_${respuesta.status}`
      );
    }
    datos = await respuesta.json();
  } catch (error: any) {
    return sinProcesar(error?.name === 'AbortError' ? 'gemini_agotó_el_tiempo' : 'gemini_no_respondió');
  } finally {
    clearTimeout(reloj);
  }

  const uso = {
    input_tokens: Number(datos?.usageMetadata?.promptTokenCount) || 0,
    output_tokens: Number(datos?.usageMetadata?.candidatesTokenCount) || 0
  };

  const salida = String(
    datos?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('') ?? ''
  ).trim();

  if (!salida || salida === ILEGIBLE) {
    // Se devuelve el uso igualmente: la llamada se pagó aunque no sirviera, y esconder
    // ese gasto es justo lo que el panel de métricas existe para evitar.
    return { texto: null, categoria: null, derivar: false, ignorar: false, uso, error: 'ilegible' };
  }

  if (esVisual) {
    const clasificacion = leerClasificacionDeImagen(salida);
    const accion = queHacerCon({
      categoria: clasificacion.categoria,
      confiable: clasificacion.confiable,
      seguridad: clasificacion.seguridad,
      vieneConTexto
    });
    return {
      // En las ramas que no siguen NO viaja descripción, ni aunque el modelo la haya
      // generado: leerClasificacionDeImagen ya la tiró. Aquí solo se confirma.
      texto: accion === 'seguir' ? (clasificacion.descripcion || null) : null,
      categoria: clasificacion.categoria,
      derivar: accion === 'derivar',
      ignorar: accion === 'ignorar',
      uso,
      error: clasificacion.confiable ? null : 'clasificacion_no_confiable'
    };
  }

  return { texto: salida, categoria: null, derivar: false, ignorar: false, uso, error: null };
}

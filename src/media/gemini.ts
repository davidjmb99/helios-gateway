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
import type { AdjuntoNormalizado } from '../chatwoot/adjuntos.js';
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
): Promise<{ bytes: Uint8Array } | { error: string }> {
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

    const crudo = new Uint8Array(await respuesta.arrayBuffer());
    if (crudo.byteLength > 20 * 1024 * 1024) return { error: 'demasiado_grande_al_descargar' };
    if (crudo.byteLength === 0) return { error: 'archivo_vacio' };
    return { bytes: crudo };
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

  const mime = MIME[adjunto.extension];
  if (!mime) return sinProcesar('formato_no_soportado');

  const bajada = await descargar(adjunto.url, fetchImpl);
  if ('error' in bajada) return sinProcesar(bajada.error);

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
      // EL CASO QUE HAY QUE DISTINGUIR: 400 con un audio ogg/opus significa que Gemini no
      // lee el codec de WhatsApp, y entonces NO es un fallo aislado: fallarían TODAS las
      // notas de voz. Se marca aparte para que se vea en el panel como lo que es, con su
      // solución conocida -convertir con ffmpeg antes de mandarlo-.
      if (respuesta.status === 400 && adjunto.soporte === 'probable') {
        return sinProcesar('gemini_rechaza_el_codec');
      }
      if (respuesta.status === 429) return sinProcesar('gemini_limite_de_frecuencia');
      return sinProcesar(`gemini_${respuesta.status}${cuerpo ? '' : ''}`);
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

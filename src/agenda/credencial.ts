/**
 * El token con el que Hermes llama a la agenda del gateway.
 *
 * DE QUÉ CLÍNICA ES CADA LLAMADA LO DICE EL TOKEN, NUNCA UN PARÁMETRO. Es la regla 111, y
 * aquí importa más que en el panel: al otro lado hay un modelo de lenguaje. Si el
 * `tenant_id` viajara como argumento de la herramienta, bastaría con que un paciente
 * escribiera «consulta la agenda de la clínica lapaz» para que Helios lo intentara — y no
 * porque el modelo sea malicioso, sino porque hace lo que le piden. Con el tenant dentro
 * del token, esa frase no tiene dónde agarrarse: el perfil `helios-la-paz` solo puede
 * hablar de La Paz porque es lo único que su token dice.
 *
 * SE DERIVA, NO SE GUARDA. El token es el `tenant_id` firmado con el secreto del servidor,
 * así que no hace falta ni columna ni migración ni un sitio del que se pueda escapar. Se
 * regenera cuando haga falta, y rotar el secreto los invalida todos de golpe.
 *
 * NO CADUCA, y es a propósito: vive en el `.env` de un perfil de Hermes, donde nadie va a
 * estar renovándolo. Un token caducado un domingo es una clínica sin agenda el lunes. Lo
 * que sí hay es forma de invalidarlo -rotar el secreto- y ese es el mecanismo pensado para
 * el día que haga falta, en vez de una caducidad que se olvida hasta que muerde.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** Marca de qué es el token, para que no se confunda con el de una sesión del panel. */
const TIPO = 'agenda-v1';

function secreto(): string {
  return config.HELIOS_ADMIN_SESSION_SECRET || config.SUPABASE_SERVICE_ROLE_KEY || '';
}

function firmar(cuerpo: string): string {
  return createHmac('sha256', secreto()).update(cuerpo).digest('base64url');
}

/**
 * El token de una clínica. Se enseña una vez en el panel y se pega en el `.env` del perfil.
 */
export function tokenDeAgenda(tenantId: string): string {
  const cuerpo = Buffer.from(JSON.stringify({ t: TIPO, tenant_id: tenantId })).toString('base64url');
  return `${cuerpo}.${firmar(cuerpo)}`;
}

/**
 * De qué clínica es este token, o null si no es válido.
 *
 * LA COMPARACIÓN ES EN TIEMPO CONSTANTE. Un `===` sobre la firma tarda un poco más cuantos
 * más caracteres coincidan desde el principio, y eso deja adivinar la firma byte a byte
 * midiendo el tiempo de las respuestas. Es lento pero se hace, y aquí el premio es la
 * agenda de una clínica entera.
 *
 * Y ESO NO LO CUBRE NINGUNA PRUEBA, dicho aquí para que nadie lo cambie creyendo que sí.
 * `timingSafeEqual` y `!==` dan el MISMO resultado siempre: lo único que cambia es cuánto
 * tarda, y eso no se ve desde una prueba unitaria. Se comprobó: sustituirlo por `!==` deja
 * la suite entera en verde. Es de las pocas cosas de este repo que hay que sostener
 * leyendo, no ejecutando.
 */
export function clinicaDelToken(token: unknown): string | null {
  const bruto = String(token ?? '').trim();
  if (!bruto || !secreto()) return null;

  const corte = bruto.lastIndexOf('.');
  if (corte <= 0) return null;
  const cuerpo = bruto.slice(0, corte);
  const firma = bruto.slice(corte + 1);

  const esperada = Buffer.from(firmar(cuerpo));
  const recibida = Buffer.from(firma);
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null;

  try {
    const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    // EL TIPO SE COMPRUEBA. Sin esto, un token de sesión del panel -firmado con el mismo
    // secreto- valdría para llamar a la agenda, y al revés. Son dos permisos distintos y
    // compartir el secreto no debe significar compartir el alcance.
    if (datos?.t !== TIPO) return null;
    const tenant = String(datos?.tenant_id || '');
    return tenant || null;
  } catch {
    return null;
  }
}

/**
 * El token que trae una petición, sacado de la cabecera.
 *
 * Se aceptan `Bearer xxx` y `xxx` a secas porque quien esto rellena está pegando un valor
 * en un YAML a mano, y olvidar el prefijo -o ponerlo dos veces- es el error de la casa.
 */
export function tokenDeLaCabecera(cabecera: unknown): string {
  const bruto = String(cabecera ?? '').trim();
  return bruto.replace(/^Bearer\s+/i, '').trim();
}

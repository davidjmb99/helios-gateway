/**
 * Quién puede mandarle un webhook al Gateway.
 *
 * HASTA HOY, CUALQUIERA. Las dos rutas de webhook no comprobaban firma, ni token, ni
 * cabecera: el único filtro era que el `account.id` que venía EN EL CUERPO estuviera en el
 * mapa de clínicas. Y ese mapa lo escribe uno mismo, así que el filtro era «acierta un
 * número pequeño».
 *
 * LO QUE SE PUEDE HACER CON ESO NO ES GASTAR TOKENS. Con un `conversation_id` real, alguien
 * manda un `message_created` falso y HELIOS LE CONTESTA A UN PACIENTE DE VERDAD, en su
 * conversación de verdad, con la voz de la clínica. Poner palabras en boca de un dentista.
 *
 * CHATWOOT NO FIRMA SUS WEBHOOKS -no tiene HMAC como GitHub o Stripe- así que la protección
 * tiene que ser un secreto compartido que solo conozcan él y nosotros.
 *
 * SE ACEPTA POR TRES CAMINOS Y NO POR UNO:
 *
 *   la cabecera `x-helios-webhook-secret`   si tu Chatwoot deja añadir cabeceras
 *   ?s=xxx  al final de la URL que ya tengas
 *   la ruta /webhooks/chatwoot/secreto/xxx
 *
 * PORQUE EL CHATWOOT DE COI NO TIENE CAMPO DE CABECERAS: su formulario de webhook son tres
 * cosas -URL, nombre y eventos- y nada más. Montar solo el camino de la cabecera habría
 * sido montar algo que ahí no se puede usar.
 *
 * EL `?s=` EXISTE PORQUE NO OBLIGA A REESCRIBIR LA URL. La ruta /secreto/xxx solo vale si
 * la URL era exactamente /webhooks/chatwoot; quien tenga /webhooks/chatwoot/democoi1
 * tendría que elegir entre el secreto y el tenant. Con `?s=` se le añade el sufijo a lo que
 * haya y no se pierde nada.
 *
 * LA CABECERA SIGUE SIENDO LA MEJOR cuando se puede: no queda en los registros de acceso
 * del servidor, y la ruta y la query sí.
 *
 * SIN SECRETO CONFIGURADO, TODO SIGUE COMO ANTES. Es deliberado: desplegar esto no puede
 * dejar a una clínica sin recibir mensajes por una variable que todavía no está puesta. El
 * arranque avisa, y el aviso se ve.
 */

import crypto from 'crypto';
import { config } from '../config.js';

export const CABECERA = 'x-helios-webhook-secret';

export type Veredicto =
  /** Hay secreto y coincide. */
  | 'vale'
  /** No hay secreto configurado: se deja pasar, como antes. */
  | 'sin_configurar'
  /** Hay secreto y no llegó, o llegó mal. */
  | 'rechazado';

/**
 * Compara sin filtrar información por el tiempo que tarda.
 *
 * Un `===` sobre cadenas tarda un poco más cuantos más caracteres coincidan desde el
 * principio, y eso deja adivinar el secreto carácter a carácter midiendo respuestas. Es
 * lento, pero un webhook se puede llamar todas las veces que uno quiera.
 */
function iguales(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Longitudes distintas ya no son iguales, y `timingSafeEqual` lanza si no coinciden. Se
  // comprueba antes, que es lo que filtra: el LARGO del secreto, no su contenido.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * ¿Este webhook viene de quien dice venir?
 *
 * `deLaRuta` es el segmento de la URL cuando se usa ese camino; `deLaCabecera` es lo que
 * llegó en la cabecera. Vale cualquiera de los dos.
 */
export function compruebaElSecreto(entrada: {
  deLaCabecera?: unknown;
  deLaRuta?: unknown;
  /** El `?s=` de la URL. */
  deLaConsulta?: unknown;
  /**
   * El secreto contra el que comparar. Por defecto el de la configuracion.
   *
   * SE PUEDE PASAR PARA PODER PROBAR EL CASO «SIN CONFIGURAR», que es el estado en que
   * queda el sistema justo despues de desplegar esto y antes de que nadie ponga la
   * variable. Sin este parametro ese caso no se puede ejercitar -la configuracion se lee
   * una vez al arrancar- y es precisamente el que no puede romper nada.
   */
  esperadoDe?: string;
}): Veredicto {
  const esperado = entrada.esperadoDe !== undefined
    ? entrada.esperadoDe
    : config.CHATWOOT_WEBHOOK_SECRET;
  if (!esperado) return 'sin_configurar';

  // En el orden en que se prefieren. Da igual para el resultado -basta con que uno valga-,
  // pero deja claro cual es el camino bueno para quien lea esto.
  const candidatos = [entrada.deLaCabecera, entrada.deLaConsulta, entrada.deLaRuta];

  for (const candidato of candidatos) {
    const valor = String(candidato ?? '').trim();
    if (valor && iguales(valor, esperado)) return 'vale';
  }
  return 'rechazado';
}

/**
 * Lo que se escribe al arrancar.
 *
 * UN AVISO QUE NO SE VE NO ES UN AVISO. Sin secreto configurado el sistema funciona
 * exactamente igual que antes, así que nada en el comportamiento delata que la puerta está
 * abierta: si no se dice aquí, no se dice en ningún sitio.
 */
export function avisoDeArranque(esperadoDe?: string): string | null {
  const esperado = esperadoDe !== undefined ? esperadoDe : config.CHATWOOT_WEBHOOK_SECRET;
  if (esperado) return null;
  return 'El webhook de Chatwoot acepta peticiones de cualquiera: CHATWOOT_WEBHOOK_SECRET '
    + 'no esta configurada. Con la URL del gateway y un account_id, alguien puede hacer que '
    + 'Helios le escriba a un paciente real.';
}

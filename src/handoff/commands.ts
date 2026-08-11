/**
 * Comandos explícitos dentro de la conversación.
 *
 * A diferencia de las señales de Chatwoot (etiquetas, equipos, estados), que son
 * pistas del flujo de trabajo, un comando es una orden directa de una persona.
 * Por eso se acepta desde cualquier etapa en manos humanas, sin exigir el camino
 * human_active → return_requested.
 *
 * La detección es ESTRICTA a propósito. Aquí no aplica el «ante la duda,
 * normaliza»: un falso positivo devolvería al bot una conversación que una
 * persona está atendiendo, en silencio y sin que nadie se enterase. El mensaje
 * tiene que ser exactamente el comando, sin nada más.
 */

export type HeliosCommand = 'return_to_bot';

/** Comando de retorno al modo IA. Escrito así, solo y sin más texto. */
export const RETURN_TO_BOT_COMMAND = '/fin';

export function detectCommand(text: unknown): HeliosCommand | null {
  const normalized = String(text ?? '')
    .trim()
    .toLowerCase()
    // Los clientes de WhatsApp y Chatwoot añaden a veces espacios finos o
    // caracteres invisibles al pegar; no deben impedir reconocer el comando.
    .replace(/[​-‍﻿ ]/g, '')
    .trim();

  if (normalized === RETURN_TO_BOT_COMMAND) return 'return_to_bot';
  return null;
}

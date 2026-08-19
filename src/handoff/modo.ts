/**
 * Quién atiende una conversación, en palabras que se puedan poner en un panel.
 *
 * NO SON DOS ESTADOS, SON TRES, y confundirlos es lo que hacía que el panel
 * mintiera. `ai_enabled` y `stage` son cosas distintas y las dos paran a Helios
 * por motivos distintos:
 *
 *   helios ...... stage de bot y la IA encendida. Helios contesta.
 *   pausada ..... stage de bot pero la IA apagada a mano. Nadie contesta: la
 *                 conversación no está derivada, simplemente Helios está callado.
 *                 Es el estado más peligroso de los tres, porque no hay ninguna
 *                 persona asignada y nada avisa de que el paciente espera.
 *   persona ..... stage de los humanos. Helios guarda el mensaje y no contesta
 *                 porque la conversación es de alguien.
 *
 * El orden de comprobación importa: el stage humano gana sobre `ai_enabled`. Una
 * conversación derivada con la IA encendida sigue siendo de la persona, y
 * mostrarla como «Helios atendiendo» sería mentir sobre quién tiene que contestar.
 */

import { isHumanOwnedStage, resolveStage, type HandoffStage } from './stage.js';

export type ModoConversacion = 'helios' | 'pausada' | 'persona';

export interface EstadoDelModo {
  modo: ModoConversacion;
  stage: HandoffStage;
  /** De dónde salió el stage: útil cuando una fila vieja no lo tiene. */
  origen: string;
  ai_enabled: boolean;
  /** Frase para el panel. Se escribe aquí para que el panel no la invente. */
  etiqueta: string;
  /** Qué pasa si el paciente escribe ahora mismo. */
  consecuencia: string;
}

const ETIQUETAS: Record<ModoConversacion, { etiqueta: string; consecuencia: string }> = {
  helios: {
    etiqueta: 'Helios atendiendo',
    consecuencia: 'Si el paciente escribe, Helios le contesta.'
  },
  pausada: {
    etiqueta: 'Pausada a mano',
    consecuencia: 'Si el paciente escribe, NADIE le contesta: el mensaje se guarda y ahí se queda.'
  },
  persona: {
    etiqueta: 'La lleva una persona',
    consecuencia: 'Si el paciente escribe, el mensaje se guarda y espera al equipo. Helios no contesta.'
  }
};

export function describirModo(fila: any): EstadoDelModo {
  const { stage, source } = resolveStage(fila);
  // Igual que en el orquestador: solo un false explícito apaga la IA. Una fila sin
  // la columna, o con null, significa encendida —es el estado por defecto de
  // cualquier conversación nueva—.
  const aiEnabled = fila ? fila.ai_enabled !== false : true;

  const modo: ModoConversacion = isHumanOwnedStage(stage)
    ? 'persona'
    : (aiEnabled ? 'helios' : 'pausada');

  return {
    modo,
    stage,
    origen: source,
    ai_enabled: aiEnabled,
    ...ETIQUETAS[modo]
  };
}

/**
 * Qué hay que hacer para llevar la conversación al modo pedido.
 *
 * Se devuelve una ACCIÓN y no se ejecuta nada, porque las dos direcciones no son
 * simétricas y el panel tiene que saberlo antes de pulsar:
 *
 *   devolver_a_helios .. hay que deshacer una derivación: limpiar el handoff,
 *                        mover el stage y avisar en Chatwoot. Es el camino
 *                        canónico returnConversationToBot, no un UPDATE.
 *   encender_ia ........ solo estaba pausada. Basta con la bandera.
 *   pausar_ia .......... apagar la bandera, sin derivar a nadie.
 *   nada ............... ya está en ese modo. No se escribe: repetir una acción
 *                        sobre una conversación derivada podría limpiar un
 *                        handoff que alguien está atendiendo.
 */
export type AccionDeModo = 'devolver_a_helios' | 'encender_ia' | 'pausar_ia' | 'nada';

export function accionPara(actual: ModoConversacion, pedido: 'helios' | 'pausada'): AccionDeModo {
  if (pedido === 'helios') {
    if (actual === 'persona') return 'devolver_a_helios';
    if (actual === 'pausada') return 'encender_ia';
    return 'nada';
  }
  // Pedir «pausada» estando con una persona NO se acepta como pausa: la
  // conversación ya no la atiende Helios, y apagar la bandera daría la falsa
  // sensación de haber hecho algo. Se deja como está y el panel lo dice.
  if (actual === 'helios') return 'pausar_ia';
  return 'nada';
}

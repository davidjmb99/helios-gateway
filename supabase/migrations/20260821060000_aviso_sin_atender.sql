-- Cuando se aviso al equipo de que tenia una derivacion sin atender.
--
-- POR QUE HACE FALTA. Hasta ahora, una conversacion en manos humanas volvia a la IA
-- por inactividad aunque NADIE la hubiera tocado nunca. Eso borraba la peticion del
-- paciente: pedia hablar con una persona, nadie miraba, y a las tres horas Helios
-- volvia a hablarle como si no hubiera pedido nada.
--
-- Lo señalo David: «no la quita hasta que la atienda el humano; lo de inactividad es
-- solo cuando ya la persona recibio respuesta humana».
--
-- Pero eso quita la red contra el olvido, que es el motivo por el que existe el
-- barrido -la noche del 10 al 11 de agosto una conversacion se quedo en modo humano
-- para siempre y nadie contesto-. Asi que la red cambia de forma: en vez de QUITARLE
-- la conversacion al equipo, se le AVISA.
--
-- Y un aviso que se repite cada pocos minutos es un aviso que nadie lee. Esta columna
-- es lo que lo manda una sola vez por episodio: se compara con handoff_requested_at,
-- asi que un aviso de una derivacion anterior no silencia el de la de ahora.

ALTER TABLE public.helios_conversation_state
  ADD COLUMN IF NOT EXISTS handoff_aviso_sin_atender_at timestamptz;

COMMENT ON COLUMN public.helios_conversation_state.handoff_aviso_sin_atender_at IS
  'Cuando se aviso al equipo de que llevaba demasiadas horas DE ATENCION con esta derivacion sin tocar. Se compara con handoff_requested_at para no repetir el aviso ni arrastrar el de un episodio anterior. NULL = no se ha avisado de la derivacion actual.';

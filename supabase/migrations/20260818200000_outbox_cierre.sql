-- El cierre automático de la conversación viaja con el mensaje del que depende.
--
-- Resolver la conversación en Chatwoot antes de que la despedida esté entregada
-- deja al paciente con la conversación cerrada y sin leer el último mensaje. Por
-- eso la intención se guarda en la fila del outbox y el worker la ejecuta DESPUÉS
-- de confirmar el envío, no en el turno.
--
-- Por defecto false: ninguna conversación existente se cierra sola por esta
-- migración.
ALTER TABLE public.helios_chatwoot_outbox
  ADD COLUMN IF NOT EXISTS cerrar_conversacion boolean NOT NULL DEFAULT false;

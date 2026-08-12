-- ==========================================================================
-- Helios — Aptitud para la encuesta de satisfacción (CSAT)
-- ==========================================================================
-- La clínica mide la satisfacción con una encuesta que se dispara al aplicar la
-- etiqueta csat-enviar. Hoy se pone a mano. El objetivo es automatizarlo sin
-- perder la métrica y sin encuestar a nadie a quien se acaba de molestar.
--
-- DECISIÓN DEL OPERADOR (12 de agosto). La encuesta solo procede cuando Helios
-- gestionó la cita de principio a fin y sin roces. Queda EXCLUIDA si hubo
-- enfado, si hubo fallo técnico, si se detectó frustración o si intervino una
-- persona del equipo. Es una definición estricta a propósito: convierte el CSAT
-- en la medida de «cuando Helios lo hace solo, el paciente queda contento».
--
-- POR QUÉ SE GUARDA EL MOTIVO DE LA EXCLUSIÓN Y NO SOLO UN BOOLEANO. Si se
-- excluye a los descontentos sin contarlos, la nota media sube sola y esconde
-- justo lo que hay que ver. Con el motivo guardado, la señal no se pierde: se
-- mueve a otro contador (excluidas por enfado, por fallo técnico, por
-- frustración, por intervención humana), que es más útil que la media.
--
-- Cambios ADITIVOS e idempotentes. No borra ni modifica ninguna fila existente.
-- Las conversaciones anteriores quedan con las tres columnas a NULL, es decir
-- «no apta», que es el valor seguro: nunca genera una encuesta retroactiva.

BEGIN;

ALTER TABLE public.helios_conversation_state
  -- Momento en que la conversación se volvió apta: una cita creada o
  -- reprogramada con éxito, según el propio operation.type de Hermes.
  ADD COLUMN IF NOT EXISTS csat_eligible_at timestamptz,
  -- Motivo de exclusión. La exclusión SIEMPRE gana sobre la aptitud, incluso si
  -- llega después de agendar. Valores: complaint, technical_failure,
  -- frustration, human_handoff.
  ADD COLUMN IF NOT EXISTS csat_excluded_reason text,
  -- Sello de que la etiqueta ya se escribió en Chatwoot. Es lo que impide que
  -- una conversación reabierta y vuelta a resolver dispare una segunda encuesta.
  ADD COLUMN IF NOT EXISTS csat_label_applied_at timestamptz;

-- Índice para la consulta de métricas: cuántas se enviaron y cuántas se
-- excluyeron, por motivo. Parcial, porque la inmensa mayoría de filas no tiene
-- nada de CSAT y no hace falta indexarlas.
CREATE INDEX IF NOT EXISTS idx_helios_conversation_state_csat
  ON public.helios_conversation_state (tenant_id, csat_excluded_reason, csat_label_applied_at)
  WHERE csat_eligible_at IS NOT NULL OR csat_excluded_reason IS NOT NULL;

COMMIT;

-- --------------------------------------------------------------------------
-- Verificación (ejecutar aparte)
-- --------------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'helios_conversation_state' AND column_name LIKE 'csat%'
--  ORDER BY column_name;
-- Debe devolver exactamente tres filas:
--   csat_eligible_at, csat_excluded_reason, csat_label_applied_at

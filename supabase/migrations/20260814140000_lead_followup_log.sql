-- ==========================================================================
-- Helios — Registro de mensajes de seguimiento
-- ==========================================================================
-- El operador lo pidió con un motivo concreto: enseñarle a quien contrate Helios
-- cuántos seguimientos hizo el mes pasado. «Todo se basa en números».
--
-- POR QUÉ UNA TABLA Y NO LOS LOGS. En helios_gateway_logs ya queda el evento,
-- pero un log es un log: se consulta para depurar, puede rotarse y su forma
-- cambia cuando cambia el código. Una métrica que se va a facturar necesita una
-- tabla propia, estable y consultable con un SELECT sencillo.
--
-- Guarda también el TEXTO enviado, a propósito. Cuando dentro de tres meses
-- alguien pregunte «¿qué le dijisteis exactamente a este paciente?», la respuesta
-- tiene que estar aquí y no depender de que Chatwoot conserve la conversación.
--
-- Cambios ADITIVOS: crea una tabla nueva y no toca ninguna existente.

BEGIN;

CREATE TABLE IF NOT EXISTS public.helios_lead_followups (
  -- Determinista: mismo lead, misma clave. Es lo que impide que un reintento del
  -- barrido cuente el mismo seguimiento dos veces e infle la métrica.
  followup_key text PRIMARY KEY,
  tenant_id text NOT NULL,
  conversation_id text NOT NULL,
  contact_id text NOT NULL,
  -- appointment, cancelled, reschedule_pending, treatment
  interest text NOT NULL,
  -- Cuándo mostró interés. Permite medir cuánto se tardó en dar el toque.
  interest_at timestamptz NOT NULL,
  -- El texto exacto que recibió el paciente.
  message text NOT NULL,
  -- 'sent' cuando salió de verdad; 'simulated' con el seguimiento apagado, que
  -- es el modo de observación. Contarlos por separado es lo que permite validar
  -- la decisión antes de encender.
  status text NOT NULL CHECK (status IN ('sent', 'simulated')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Para el recuento mensual por clínica, que es la consulta que se va a usar.
CREATE INDEX IF NOT EXISTS idx_helios_lead_followups_mes
  ON public.helios_lead_followups (tenant_id, created_at DESC, status);

COMMIT;

-- --------------------------------------------------------------------------
-- La consulta del informe mensual
-- --------------------------------------------------------------------------
-- SELECT
--   to_char(date_trunc('month', created_at AT TIME ZONE 'Europe/Madrid'), 'YYYY-MM') AS mes,
--   COUNT(*) FILTER (WHERE status = 'sent')      AS seguimientos_enviados,
--   COUNT(*) FILTER (WHERE status = 'simulated') AS solo_simulados,
--   COUNT(*) FILTER (WHERE interest = 'appointment')        AS por_cita_sin_cerrar,
--   COUNT(*) FILTER (WHERE interest = 'cancelled')          AS por_cita_cancelada,
--   COUNT(*) FILTER (WHERE interest = 'reschedule_pending') AS por_cambio_a_medias,
--   COUNT(*) FILTER (WHERE interest = 'treatment')          AS por_consulta_tratamiento
-- FROM public.helios_lead_followups
-- WHERE tenant_id = 'democoi1'
-- GROUP BY 1 ORDER BY 1 DESC;

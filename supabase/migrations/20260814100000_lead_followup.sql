-- ==========================================================================
-- Helios — Seguimiento de leads
-- ==========================================================================
-- Alguien pregunta por una cita o un tratamiento, no concreta, y al día
-- siguiente recibe UN mensaje preguntando si le sigue interesando. Uno solo.
--
-- POR QUÉ CUATRO COLUMNAS Y NO UN BOOLEANO, igual que en la encuesta: si se
-- descarta a la gente sin contar por qué, no hay forma de saber si el
-- seguimiento funciona o si simplemente no se le está escribiendo a nadie. El
-- motivo del descarte ES la métrica.
--
-- Cambios ADITIVOS e idempotentes. No borra ni modifica ninguna fila existente.
-- Las conversaciones anteriores quedan con las cuatro columnas a NULL, que
-- significa «no es un lead»: NUNCA se le escribe a nadie de forma retroactiva.

BEGIN;

ALTER TABLE public.helios_conversation_state
  -- Qué interés mostró: appointment, cancelled, reschedule_pending, treatment.
  -- Determina qué mensaje se le manda.
  ADD COLUMN IF NOT EXISTS lead_interest text,
  -- Cuándo lo mostró. Es el reloj desde el que se cuenta TODO: las horas de
  -- espera y, sobre todo, el plazo de 24 h de WhatsApp.
  ADD COLUMN IF NOT EXISTS lead_interest_at timestamptz,
  -- Cuándo se le escribió. Mientras esté a NULL no se le ha escrito; en cuanto
  -- tiene fecha, no se le vuelve a escribir jamás.
  ADD COLUMN IF NOT EXISTS lead_followup_at timestamptz,
  -- Por qué NO se le escribe: booked, complaint, not_interested, human_handoff,
  -- technical_failure, opted_out.
  ADD COLUMN IF NOT EXISTS lead_blocked_reason text;

-- Índice para el barrido del worker: solo interesan los leads vivos, que son
-- los que tienen interés anotado y todavía no han recibido nada. Es parcial
-- porque la inmensa mayoría de filas no son leads y no hay que indexarlas.
CREATE INDEX IF NOT EXISTS idx_helios_conversation_state_leads
  ON public.helios_conversation_state (tenant_id, lead_interest_at)
  WHERE lead_interest IS NOT NULL
    AND lead_followup_at IS NULL
    AND lead_blocked_reason IS NULL;

COMMIT;

-- --------------------------------------------------------------------------
-- Verificación (ejecutar aparte)
-- --------------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'helios_conversation_state' AND column_name LIKE 'lead%'
--  ORDER BY column_name;
-- Debe devolver exactamente cuatro filas:
--   lead_blocked_reason, lead_followup_at, lead_interest, lead_interest_at

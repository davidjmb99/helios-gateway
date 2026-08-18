-- Cuantos reintentos hace el recovery, por clinica, y que no se abandone a nadie.
--
-- EL FALLO QUE ESTO ARREGLA: el recovery buscaba lotes con attempt_count < 5. Al
-- llegar a 5 el lote desaparecia de la consulta y nadie se enteraba: ni reintento,
-- ni derivacion, ni aviso al paciente. Siete conversaciones reales del 17 y 18 de
-- agosto de 2026 acabaron asi, con la persona esperando una respuesta que no iba a
-- llegar nunca.
--
-- ES ADITIVA. recovery_intentos nace NULL, y NULL significa «usa el valor de
-- siempre», que son los 5 de antes. Si nadie toca el panel, el numero de
-- reintentos no cambia; lo que si cambia es que agotarlos deja de ser silencio.
--
-- rescatado_at marca el lote que YA se derivo a una persona, para no derivarlo dos
-- veces ni avisar al paciente dos veces. NULL en todo lo existente: los lotes
-- abandonados de estos dias entran en el primer barrido y por fin se atienden.

BEGIN;

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS recovery_intentos integer;

-- El rango que acepta el codigo. Se repite aqui porque una columna sin frenos
-- acaba con un 0 puesto a mano, y 0 reintentos significa no procesar nunca.
ALTER TABLE public.helios_tenants
  DROP CONSTRAINT IF EXISTS helios_tenants_recovery_intentos_check;
ALTER TABLE public.helios_tenants
  ADD CONSTRAINT helios_tenants_recovery_intentos_check
  CHECK (recovery_intentos IS NULL OR (recovery_intentos >= 1 AND recovery_intentos <= 12));

ALTER TABLE public.helios_processing_batches
  ADD COLUMN IF NOT EXISTS rescatado_at timestamptz;

-- El barrido busca lotes parados y sin rescatar. Sin este indice recorre la tabla
-- entera en cada tick.
CREATE INDEX IF NOT EXISTS idx_helios_batches_rescate
  ON public.helios_processing_batches (ai_status, created_at)
  WHERE rescatado_at IS NULL;

COMMIT;

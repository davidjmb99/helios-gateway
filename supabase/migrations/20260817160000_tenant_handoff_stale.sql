-- Horas de inactividad antes de devolver una conversación a la IA, por clínica.
--
-- Hasta ahora era la variable de entorno HELIOS_HANDOFF_STALE_HOURS, con 5 por
-- defecto: la misma para todas las clínicas y solo cambiable con un redeploy.
--
-- ES ADITIVA Y NO ROMPE NADA, igual que buffer_ms: la columna nace NULL, y NULL
-- significa «usa el valor del entorno». Aplicarla sin tocar el panel deja el
-- sistema comportándose exactamente igual que antes.
--
-- Sin DEFAULT a proposito: con un default no se distingue «esta clinica eligio 5
-- horas» de «no ha elegido nada», y el panel necesita esa diferencia para poder
-- decir de donde sale el valor que muestra.

BEGIN;

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS handoff_stale_hours integer;

-- El rango que acepta el codigo, repetido aqui porque una columna sin frenos
-- acaba con un 0 escrito a mano desde el editor de Supabase. Un 0 devolveria a la
-- IA conversaciones que una persona esta atendiendo en ese momento.
--
-- No se permite NUNCA desactivarlo: esta red de seguridad existe porque la noche
-- del 10 al 11 de agosto una conversacion se quedo en modo humano y el paciente
-- escribio sin que nadie contestara. Un umbral de una semana no protege de eso.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'helios_tenants_handoff_stale_hours_rango'
  ) THEN
    ALTER TABLE public.helios_tenants
      ADD CONSTRAINT helios_tenants_handoff_stale_hours_rango
      CHECK (handoff_stale_hours IS NULL OR (handoff_stale_hours >= 1 AND handoff_stale_hours <= 48));
  END IF;
END $$;

COMMENT ON COLUMN public.helios_tenants.handoff_stale_hours IS
  'Horas sin actividad antes de devolver el handoff a la IA. NULL = usar HELIOS_HANDOFF_STALE_HOURS.';

COMMIT;

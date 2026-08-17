-- Tiempo de espera del buffer, por clínica.
--
-- Hasta ahora era la variable de entorno BUFFER_MS: la misma para todas las
-- clínicas y solo cambiable con un redeploy. Pasa a ser una columna, para que
-- cada clínica lo ajuste desde su panel sin tocar el despliegue.
--
-- ES ADITIVA Y NO ROMPE NADA. La columna nace NULL, y NULL significa «usa el
-- valor de siempre», o sea BUFFER_MS. Si esta migración se aplica y nadie toca el
-- panel, el sistema se comporta exactamente igual que antes.
--
-- No se pone DEFAULT 5000 a propósito: con un default no se podría distinguir
-- «esta clínica eligió 5 segundos» de «esta clínica no ha elegido nada», y el
-- panel necesita esa diferencia para decir de dónde sale el valor que muestra.

BEGIN;

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS buffer_ms integer;

-- El rango que acepta el código. Se repite aquí porque una columna sin frenos
-- acaba con un 0 escrito a mano desde el editor de Supabase, y un buffer de 0
-- parte cada ráfaga en tantos turnos como mensajes: coste multiplicado y
-- respuestas duplicadas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'helios_tenants_buffer_ms_rango'
  ) THEN
    ALTER TABLE public.helios_tenants
      ADD CONSTRAINT helios_tenants_buffer_ms_rango
      CHECK (buffer_ms IS NULL OR (buffer_ms >= 3000 AND buffer_ms <= 30000));
  END IF;
END $$;

COMMENT ON COLUMN public.helios_tenants.buffer_ms IS
  'Espera del buffer en ms para esta clinica. NULL = usar BUFFER_MS del entorno.';

COMMIT;

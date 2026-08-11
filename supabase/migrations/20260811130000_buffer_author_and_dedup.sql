-- ==========================================================================
-- Helios — Autoría explícita en el buffer y candado contra duplicados
-- ==========================================================================
-- Motivado por la prueba real del 10-11 de agosto, conversación 45:
--
--  1. Al leer helios_inbound_buffer a mano, direction='outgoing' no dice si el
--     mensaje lo escribió una persona del equipo. Se añade una marca explícita.
--
--  2. El mensaje del equipo se guardó DOS veces (message_id 795). Causa: el
--     manejador comprobaba la idempotencia y luego insertaba, y entre las dos
--     operaciones cabía otra petición concurrente. Chatwoot puede entregar el
--     mismo message_created más de una vez. El código ya reclama de forma
--     atómica; este índice lo garantiza además en la base de datos.
--
-- Cambios ADITIVOS. El único borrado es de filas duplicadas verificadas, y va
-- separado y comentado para poder revisarlo antes.

BEGIN;

-- --------------------------------------------------------------------------
-- 1. Marca de autoría
-- --------------------------------------------------------------------------
-- DEFAULT 'patient' a propósito: así el camino de mensajes entrantes, que ya
-- funciona, no necesita cambiar ni una línea, y las filas históricas quedan
-- correctamente clasificadas.

ALTER TABLE public.helios_inbound_buffer
  ADD COLUMN IF NOT EXISTS author text NOT NULL DEFAULT 'patient';

-- Las filas salientes existentes las escribió el equipo humano: el eco de Helios
-- nunca se guarda en esta tabla.
UPDATE public.helios_inbound_buffer
SET author = 'clinic_team'
WHERE direction = 'outgoing' AND author <> 'clinic_team';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'helios_inbound_buffer_author_check'
  ) THEN
    ALTER TABLE public.helios_inbound_buffer
      ADD CONSTRAINT helios_inbound_buffer_author_check
      CHECK (author IN ('patient', 'clinic_team'));
  END IF;
END
$$;

COMMIT;

-- ==========================================================================
-- 2. LIMPIEZA DE DUPLICADOS  —  revisar antes de ejecutar
-- ==========================================================================
-- Primero MIRAR qué se va a borrar. Debe devolver solo las filas salientes
-- repetidas, conservando la de id más bajo:
--
--   SELECT b.id, b.message_id, b.body, b.created_at
--   FROM public.helios_inbound_buffer b
--   JOIN public.helios_inbound_buffer b2
--     ON b.tenant_id = b2.tenant_id
--    AND b.message_id = b2.message_id
--    AND b.direction = 'outgoing'
--    AND b2.direction = 'outgoing'
--    AND b.id > b2.id
--   ORDER BY b.message_id, b.id;
--
-- Si el resultado es el esperado, entonces borrar:
--
--   DELETE FROM public.helios_inbound_buffer b
--   USING public.helios_inbound_buffer b2
--   WHERE b.tenant_id = b2.tenant_id
--     AND b.message_id = b2.message_id
--     AND b.direction = 'outgoing'
--     AND b2.direction = 'outgoing'
--     AND b.id > b2.id;
--
-- Y solo DESPUÉS crear el índice único, que fallaría si quedan duplicados:
--
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_helios_inbound_buffer_outgoing_message
--     ON public.helios_inbound_buffer (tenant_id, message_id)
--     WHERE direction = 'outgoing';
--
-- A partir de ese índice, un segundo intento de guardar el mismo mensaje del
-- equipo es imposible: lo rechaza Postgres, no el código.

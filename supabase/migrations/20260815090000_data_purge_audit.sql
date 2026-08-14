-- ==========================================================================
-- Helios — Registro de borrados desde el panel
-- ==========================================================================
-- El panel va a tener un botón para vaciar datos de una clínica. Un botón que
-- borra producción sin dejar rastro es un accidente esperando: cuando alguien
-- pregunte «¿dónde están las conversaciones de la semana pasada?», la respuesta
-- tiene que estar escrita.
--
-- ESTA TABLA NO ES BORRABLE DESDE EL PANEL, a propósito. No aparece en la lista
-- blanca de tablas purgables del código, así que el propio botón no puede
-- eliminar la prueba de lo que hizo.
--
-- Cambio ADITIVO: crea una tabla nueva y no toca ninguna existente.

BEGIN;

CREATE TABLE IF NOT EXISTS public.helios_data_purge_audit (
  id bigserial PRIMARY KEY,
  -- Clínica cuyos datos se borraron. Sale SIEMPRE del token de sesión, nunca de
  -- lo que mande el navegador: es lo que impide que alguien borre datos de otra
  -- clínica manipulando la petición.
  tenant_id text NOT NULL,
  -- Quién lo pidió, tal como lo identificó la sesión.
  requested_by text NOT NULL,
  -- Qué tablas se vaciaron y cuántas filas cayó cada una.
  tables_purged jsonb NOT NULL,
  rows_deleted integer NOT NULL DEFAULT 0,
  -- Qué escribió la persona para confirmar. Se guarda para poder demostrar que
  -- la confirmación existió.
  confirmation_text text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_helios_data_purge_audit_tenant
  ON public.helios_data_purge_audit (tenant_id, created_at DESC);

COMMIT;

-- --------------------------------------------------------------------------
-- Consulta: qué se ha borrado y quién
-- --------------------------------------------------------------------------
-- SELECT created_at, requested_by, rows_deleted, tables_purged
-- FROM public.helios_data_purge_audit
-- WHERE tenant_id = 'democoi1'
-- ORDER BY created_at DESC;

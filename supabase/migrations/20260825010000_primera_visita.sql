-- Si la primera visita es gratis lo dice cada clinica, no el codigo.
--
-- ESTABA CABLEADO A `true` EN EL ORQUESTADOR. `clinic_context.first_visit_free: true`,
-- fijo, para todas las cuentas. Asi que Helios llevaba semanas cerrando mensajes con «le
-- recuerdo que su primera visita es gratuita» sin que nadie hubiera confirmado que lo
-- fuera.
--
-- LO DIJO DAVID EL 25-ago-2026: «quitaremos lo de la primera valoracion gratuita, porque
-- en Venezuela casi no se ve eso». O sea que no era cierto ni para COI, que es la clinica
-- para la que se escribio.
--
-- ES EL MISMO FALLO QUE «ACARIGUA» EN EL SOUL (HEL-085): un dato de UNA clinica escrito
-- en un sitio que sirve a TODAS. La direccion se arreglo moviendola a los ajustes; esto
-- va por el mismo camino.
--
-- EL DEFECTO ES `false`, Y ESA ES LA PARTE QUE IMPORTA. Prometer algo gratis que se cobra
-- es una discusion con el paciente en el mostrador; no prometer algo que si es gratis es
-- una oportunidad perdida que el equipo puede corregir hablando. Los dos fallos no cuestan
-- lo mismo, asi que el defecto no puede estar en medio.

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS first_visit_free boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.helios_tenants.first_visit_free IS
  'true solo si esta clinica de verdad no cobra la primera visita. Viaja a Hermes en clinic_context.first_visit_free en cada turno. POR DEFECTO false: prometer algo gratis que luego se cobra es una discusion con el paciente en el mostrador, y ese es el fallo caro. Antes estaba cableado a true en el orquestador para todas las cuentas.';

-- El mapa de clinicas deja de vivir en una variable de entorno.
--
-- QUE ES EL MAPA. Dice de que clinica es cada cuenta de Chatwoot, y a que perfil de
-- Hermes le habla. Hoy vive en `CHATWOOT_TENANT_CONTEXTS_JSON`, una variable de Coolify
-- DUPLICADA en el Gateway y en el Adapter, que se parsea en CADA webhook.
--
-- POR QUE SE MUEVE, Y NO ES POR EL BOTON. El boton de «crear cuenta» es la razon por la
-- que se planteo, pero se paga solo aunque nunca se construya:
--
--   HOY    editar la variable exige REDESPLEGAR, lo que corta a todas las clinicas.
--          Y un JSON mal formado -una coma de mas, un account_id repetido- hace que
--          se lance ANTES de mirar de quien es el mensaje: dejan de entrar mensajes
--          de TODAS las clinicas a la vez, con el contenedor en `healthy` y sin
--          ninguna alarma. Es la regla 5, el peor fallo del sistema.
--
--   AQUI   la unicidad la impone la BASE: un account_id o un tenant_id repetido se
--          rechaza AL ESCRIBIR. La mezcla deja de ser detectable para volverse
--          imposible, que es mejor sitio donde impedirla.
--
-- Y UNA FILA MALA SOLO AFECTA A SU CLINICA. El lector salta las filas incompletas y
-- conserva las demas: esa clinica se queda sin atender -falla cerrado, que es lo
-- correcto cuando no se sabe de quien es un mensaje- y las otras siguen.
--
-- VA EN `helios_tenants` Y NO EN UNA TABLA NUEVA. Esa tabla ya tiene una fila por
-- clinica con sus ajustes -horario, direccion, precios, doctores-. Ponerlo aqui deja
-- UNA CLINICA, UNA FILA, y el dia del boton se escribe una sola cosa en vez de dos.
--
-- LAS COLUMNAS NACEN NULAS Y ESO ES DELIBERADO. Mientras no haya filas con account_id,
-- el Gateway sigue leyendo la variable de entorno exactamente como hoy. Desplegar esto
-- no cambia el comportamiento de nadie; el cambio ocurre cuando alguien rellena las
-- filas, y se deshace vaciandolas.

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS account_id text,
  ADD COLUMN IF NOT EXISTS clinic_id text,
  ADD COLUMN IF NOT EXISTS hermes_profile text,
  ADD COLUMN IF NOT EXISTS mapa_activo boolean NOT NULL DEFAULT true;

-- EL account_id ES UNICO, Y AQUI ESTA MEDIO VALOR DE ESTA MIGRACION. Dos clinicas con
-- la misma cuenta de Chatwoot significaba que los mensajes de una acababan atendidos
-- como si fueran de la otra. En la variable eso se detectaba en el camino del mensaje
-- -tumbando a todas-; aqui no se puede ni escribir.
--
-- Los NULL no chocan entre si en un indice unico de Postgres, asi que las filas que
-- todavia no son clinicas -o que no se han migrado- conviven sin problema.
CREATE UNIQUE INDEX IF NOT EXISTS helios_tenants_account_id_unico
  ON public.helios_tenants (account_id)
  WHERE account_id IS NOT NULL;

-- Y `tenant_id` ya es la clave de la tabla, asi que su unicidad viene de serie: es
-- imposible que dos clinicas compartan el identificador que separa sus datos.

COMMENT ON COLUMN public.helios_tenants.account_id IS
  'La cuenta de Chatwoot de esta clinica, como texto. Unico entre las clinicas activas. Mientras sea NULL, esta clinica no esta en el mapa y el Gateway usa la variable de entorno.';

COMMENT ON COLUMN public.helios_tenants.clinic_id IS
  'Identificador corto de la clinica, el que viaja en el payload y en la telemetria.';

COMMENT ON COLUMN public.helios_tenants.hermes_profile IS
  'A que perfil de Hermes le habla esta clinica. De el salen el puerto y la clave con los que el Adapter la atiende; si no se sabe encaminar, el Adapter se NIEGA a contestar en vez de caer al Hermes de otra.';

COMMENT ON COLUMN public.helios_tenants.mapa_activo IS
  'false retira la clinica del mapa sin borrar sus datos ni sus ajustes: deja de atenderse y todo lo suyo sigue en su sitio. Es la forma de dar de baja una clinica sin perder su historial.';

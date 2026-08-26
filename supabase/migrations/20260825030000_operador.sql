-- Quien puede ver mas de una clinica desde el mismo panel.
--
-- HASTA HOY la sesion del panel era por clinica: cada cuenta con su contraseña, viendo lo
-- suyo. Para el equipo que opera varias cuentas eso significa cerrar sesion y volver a
-- entrar cada vez, y David lo pidio de otra forma: «no quiero estar cerrando sesion y
-- abriendo la otra, quiero que sea asi tipo Chatwoot».
--
-- ESTO ES EL PRIMER PERMISO DEL SISTEMA QUE DEJA A UNA SESION VER DOS CLINICAS, asi que
-- conviene ser preciso en lo que hace y en lo que NO hace:
--
--   LO QUE HACE: permitir que esa sesion PIDA un token nuevo para otra cuenta.
--
--   LO QUE NO HACE: darle acceso a dos cuentas A LA VEZ. El token sigue apuntando a UNA
--   sola clinica, y todos los endpoints siguen sacando el tenant DEL TOKEN y nunca de un
--   parametro de la peticion. Por eso este cambio no toca la superficie de aislamiento:
--   no se añade ningun sitio nuevo donde se pueda pedir «dame los datos del tenant X».
--
-- POR DEFECTO false, y ahi no hay eleccion posible: un `true` por defecto convertiria en
-- operador a cada clinica que se diera de alta, y la primera en entrar veria a las demas.
--
-- CONVIENE QUE LA FILA DE OPERADOR NO SEA UNA CLINICA REAL. Si se marca la fila de COI, la
-- contraseña de COI pasa a abrir todas las cuentas, y esa contraseña la tiene su
-- recepcion. Mejor una fila aparte del equipo que opera.

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS es_operador boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.helios_tenants.es_operador IS
  'true solo para las cuentas del equipo que opera varias clinicas. Permite pedir un token nuevo para otra cuenta desde el panel, sin cerrar sesion. NO da acceso a dos clinicas a la vez: el token sigue apuntando a una sola y todos los endpoints sacan el tenant del token. Por defecto false: con true por defecto, la primera clinica que entrara veria a las demas. Conviene que la fila marcada NO sea una clinica real, porque su contraseña pasaria a abrir todas las cuentas.';

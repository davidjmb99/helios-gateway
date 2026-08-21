-- La direccion de la clinica, para responder «¿donde quedan?».
--
-- POR QUE ES UNA COLUMNA Y NO UNA LINEA DEL PROMPT DE HERMES. Se escribio primero
-- en el perfil -«La clinica esta en Acarigua, CC Mamanico, local 27»- y el modelo se
-- NEGO a decirla: «no quiero darte una direccion de memoria por si no es exacta».
-- En el mismo minuto contesto el horario sin dudar, porque el horario le llega en
-- clinic_context dentro de la peticion. Lo que viaja en la peticion lo trata como
-- dato; lo que esta escrito en el prompt, como recuerdo dudoso -y el SOUL entero le
-- enseña a desconfiar de los recuerdos, que es lo que evita que invente citas-.
--
-- Y resuelve algo que el prompt rompia: «Acarigua» en el SOUL habria mentido a la
-- segunda clinica, porque el perfil es uno para todas. Aqui cada cuenta manda la
-- suya y no se mezclan.
--
-- SIN VALOR POR DEFECTO A PROPOSITO. Una direccion inventada manda al paciente a un
-- sitio equivocado; sin direccion, Helios deriva a una persona, que es recuperable.

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS clinic_address text;

COMMENT ON COLUMN public.helios_tenants.clinic_address IS
  'Direccion de la clinica en texto libre, max 200 caracteres. Viaja a Hermes en clinic_context.clinic_address en cada turno. NULL = sin configurar, y entonces Helios no la dice.';

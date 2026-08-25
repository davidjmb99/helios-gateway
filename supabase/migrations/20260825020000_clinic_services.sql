-- Los servicios y sus precios, con los otros nombres por los que los pide la gente.
--
-- POR QUE COMO DATO Y NO COMO DOCUMENTO. Es la leccion de la direccion (HEL-085): Hermes
-- se NEGO a decir una direccion que estaba en su prompt -«no quiero darte una direccion de
-- memoria por si no es exacta»- y contesto el horario sin dudar, porque el horario llegaba
-- en la peticion. Con un precio ese recelo es todavia mas sano: un numero mal recordado es
-- una discusion con un paciente en el mostrador.
--
-- La clinica tiene un PDF con los precios y aun asi NO van por RAG. Lo que llega en la
-- peticion es un hecho; lo que hay que ir a buscar a un documento es un recuerdo.
--
-- Y CADA SERVICIO LLEVA SUS OTROS NOMBRES, que es la mitad que de verdad importa. Lo
-- señalo David: «el agente debe saber los otros terminos a cada uno de esos servicios».
-- Un paciente en Venezuela no pide una «exodoncia simple»: dice que le van a SACAR LA
-- MUELA. Sin los sinonimos el precio esta en el sistema y el paciente no lo alcanza.
--
-- SE GUARDA EL TEXTO TAL COMO LO ESCRIBE LA CLINICA, no una estructura. Asi el panel le
-- devuelve exactamente lo que escribio, sin reformatear su lista. Se valida al guardar
-- -si una sola linea no se entiende, no se guarda nada- y se lee en cada turno, que es
-- gratis porque los ajustes van en cache.
--
-- SIN VALOR POR DEFECTO A PROPOSITO. Un precio inventado es peor que no tenerlo: acaba en
-- una discusion en el mostrador con Helios de testigo por escrito. Sin servicios
-- configurados Helios no dice ningun precio y deriva, que es recuperable.

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS clinic_services text;

COMMENT ON COLUMN public.helios_tenants.clinic_services IS
  'Servicios y precios de la clinica, una linea por servicio: «Nombre: precio (otro nombre, otro nombre)». Maximo 40 servicios y 4000 caracteres. Viaja a Hermes en clinic_context.services en cada turno, ya separado en nombre/precio/tambien. Los otros nombres son para RECONOCER lo que pide el paciente, no para que Helios hable asi. NULL = sin configurar, y entonces Helios no dice ningun precio y deriva.';

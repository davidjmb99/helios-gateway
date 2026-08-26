-- Los doctores de la clinica y los dias que no abre.
--
-- LA RESTRICCION QUE MANDA AQUI LA PUSO DAVID: «que sea lo mas sencillo y no meterme con
-- tanto codigo ni prompt». Dar de alta una clinica tiene que ser rellenar campos en el
-- panel, no editar un JSON ni pedirle nada a nadie. Por eso se guarda TEXTO tal como lo
-- escribe esa persona, se valida al guardar, y se interpreta al leer.
--
-- clinic_doctors: una ficha por doctor, escrita como se habla
--
--     Dra. Ana Martinez
--       calendario: c-ana@group.calendar.google.com
--       hace: valoracion, higiene, blanqueamiento, empaste
--
--     Dra. Sofia Lemur
--       calendario: c-sofia@group.calendar.google.com
--       horario: L, J, V, S
--       hace: valoracion, odontopediatria
--
--   SIN LINEA DE `horario` trabaja el de la clinica, que es lo normal y lo que hay que
--   hacer facil. `horario: L, J, V, S` son los dias de la clinica pero solo esos.
--
--   Y UN `*` DETRAS DE UN SERVICIO significa «este es el preferente, pero si esta ocupado
--   lo hacen los demas». Sin la estrella, ese servicio lo hace SOLO quien lo declara. Es la
--   diferencia entre «la urgencia la ve Velez pero si esta ocupado cualquiera» y «los
--   brackets solo el ortodoncista», y confundirlas manda una urgencia a quien no es
--   cirujano o pierde la cita teniendo a alguien libre.
--
-- clinic_closures: los dias que la clinica no abre
--
--     25/12/2026                 Navidad
--     15/08/2026 - 22/08/2026    vacaciones
--
--   NO SE DEJA EN EL CALENDARIO DE CADA DOCTOR. Un cierre de la clinica lo son todos a la
--   vez, y confiarlo a que cuatro personas se acuerden de bloquear su agenda es garantizar
--   que una se olvide, y que esa siga dando citas para el 25 de diciembre.
--
-- LAS DOS SE VALIDAN ENTERAS AL GUARDAR: si una linea no se entiende, no se guarda ninguna.
-- Guardar la mitad es el fallo que no se ve, porque la clinica cree que puso cuatro
-- doctores y nadie se entera hasta que un paciente pide cita con el que falta.

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS clinic_doctors text,
  ADD COLUMN IF NOT EXISTS clinic_closures text;

COMMENT ON COLUMN public.helios_tenants.clinic_doctors IS
  'Los doctores de la clinica, una ficha por doctor: nombre, «calendario:» con su ID de Google, «horario:» opcional -sin el, el de la clinica- y «hace:» con sus servicios. Un * detras de un servicio marca al preferente y ABRE ese servicio a los demas; sin estrella, lo hace solo quien lo declara. Maximo 20 doctores. NULL = sin configurar, y entonces no hay agenda propia.';

COMMENT ON COLUMN public.helios_tenants.clinic_closures IS
  'Los dias que la clinica no abre, uno por linea: «25/12/2026 Navidad» o «15/08/2026 - 22/08/2026 vacaciones». El texto detras de la fecha es para quien lo lee. Va aqui y no en el calendario de cada doctor porque un cierre de la clinica lo son todos a la vez. Maximo 60.';

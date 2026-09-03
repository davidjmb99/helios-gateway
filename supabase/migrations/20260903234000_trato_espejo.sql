-- Si Helios puede seguirle el trato al paciente, lo decide cada clinica.
--
-- LA IDEA. `clinic_formality` dice con QUE trato empieza. Esto dice si, cuando el
-- paciente marca claramente el suyo, Helios puede cambiar al del paciente -que es lo
-- que hace una persona de verdad-.
--
-- VIENE APAGADO, Y NO ES POR PRUDENCIA GENERICA. Para muchas clinicas el trato es una
-- decision de marca y no un accidente: una clinica que trata de usted QUIERE tratar de
-- usted aunque el paciente tutee, igual que su recepcionista. Encenderlo tiene que ser
-- la decision de alguien, no un cambio silencioso en una cuenta que ya atiende.
--
-- Y LA TRAMPA, QUE ES POR LO QUE ESTO ES UN AJUSTE Y NO UNA REGLA FIJA: la mayoria de
-- los mensajes NO llevan marca de registro. «Hola», «Quiero pedir una cita» y «¿Cuanto
-- cuesta una limpieza?» no dicen nada. Si el modelo interpreta una de esas como tuteo y
-- empieza a tutear a quien nunca lo hizo, eso si es una queja. Las reglas de cuando
-- cambiar viven en el SOUL -solo con marca inequivoca, una vez, y sin volver atras-,
-- porque decidir eso es interpretar lenguaje y de eso se encarga Hermes.
--
-- EL GATEWAY PONE LA POLITICA, EL SOUL LA APLICA. Es el mismo reparto de siempre.

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS clinic_formality_mirror boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.helios_tenants.clinic_formality_mirror IS
  'true si Helios puede pasar al trato del paciente cuando el paciente lo marca de forma inequivoca. Viaja a Hermes en clinic_context.formality_follows_patient en cada turno. POR DEFECTO false: para muchas clinicas el trato es una decision de marca y no un accidente, y encenderlo tiene que ser la decision de alguien. El trato con el que se EMPIEZA lo dice clinic_formality.';

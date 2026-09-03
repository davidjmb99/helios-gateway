-- Si al paciente se le habla de tu, de usted o de vos lo dice cada clinica, no el SOUL.
--
-- ESTABA EN EL SOUL, Y EL SOUL ES UNO PARA TODAS LAS CLINICAS. La primera clinica que
-- quisiera tutear obligaba a editar el prompt compartido, y ese prompt es justo lo que
-- hay que poder copiar tal cual de una version a la siguiente. Con cuatro clientes y
-- tres versiones del producto, eso se vuelve una revision manual del SOUL clinica por
-- clinica en cada actualizacion.
--
-- ES EL MISMO FALLO QUE «ACARIGUA» EN EL SOUL (HEL-085) Y QUE LA PRIMERA VISITA CABLEADA
-- A `true`: un dato de UNA clinica escrito en un sitio que sirve a TODAS. Los dos se
-- arreglaron moviendolos a los ajustes, y esto va por el mismo camino.
--
-- Y NO CABE DENTRO DE `clinic_tone`. El tono es texto libre -«cercano y profesional»- y
-- de ahi NO se deduce si tratar de tu o de usted. Es un binario que tiene que salir bien
-- en CADA frase, y un binario no se guarda en un campo difuso.
--
-- SE ADMITE `vos` desde el primer dia porque el trato cambia por pais y no lo decide el
-- operador: Venezuela usa usted y tu, España tu, el Rio de la Plata vos. Añadirlo hoy es
-- una palabra en un CHECK; añadirlo cuando haya cuentas es otra migracion.
--
-- ES NULLABLE Y SIN DEFECTO EN LA BASE, A PROPOSITO. Con `NOT NULL DEFAULT 'usted'`
-- todas las filas existentes quedarian con un valor y el panel diria «elegido por la
-- clinica» cuando nadie lo eligio -que es exactamente lo que el campo `origen` existe
-- para evitar-. En NULL, el codigo aplica su defecto y el panel puede decir la verdad.
--
-- EL DEFECTO DEL CODIGO ES `usted`, Y ESA ES LA PARTE QUE IMPORTA. Tratar de usted a
-- quien esperaba tu suena algo rigido y no se lo cuenta nadie; tutear a quien esperaba
-- usted es una falta de respeto, y en una clinica eso es una queja. Los dos fallos no
-- cuestan lo mismo, asi que el defecto no puede estar en medio.

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS clinic_formality text;

-- EL CHECK HACE IMPOSIBLE EL ESTADO INVALIDO en vez de solo avisarlo. La aplicacion ya
-- normaliza -baja a minusculas y quita acentos, asi que «Tú» entra como `tu`-, pero una
-- edicion a mano en Supabase se colaria: el lector la descartaria, dejaria el ajuste en
-- su defecto y solo se veria en un `ajuste_invalido_en_base` de los logs. Mejor que la
-- escritura falle en el momento.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'helios_tenants_clinic_formality_valido'
  ) THEN
    ALTER TABLE public.helios_tenants
      ADD CONSTRAINT helios_tenants_clinic_formality_valido
      CHECK (clinic_formality IS NULL OR clinic_formality IN ('usted', 'tu', 'vos'));
  END IF;
END $$;

COMMENT ON COLUMN public.helios_tenants.clinic_formality IS
  'Como se le habla al paciente en esta clinica: usted, tu o vos. Viaja a Hermes en clinic_context.formality en cada turno, SIEMPRE -no solo si esta configurado-, porque el modelo tiene que elegir un pronombre en cada frase y esa decision no puede quedarse en el SOUL, que es compartido. NULL significa que la clinica no lo ha elegido y se aplica el defecto del codigo, que es usted: tutear a quien esperaba usted es una queja, y lo contrario solo suena rigido.';

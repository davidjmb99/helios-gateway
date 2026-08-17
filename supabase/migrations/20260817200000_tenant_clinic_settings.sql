-- Ajustes de clínica que hasta ahora estaban en el código o en variables de entorno.
--
-- QUÉ SE MUEVE Y DE DÓNDE VENÍA:
--
--   clinic_hours ...... ESTABA ESCRITO EN EL CÓDIGO, en src/leads/policy.ts, en una
--                       constante llamada HORARIO_COI: el nombre de la clínica
--                       piloto dentro del fuente. La segunda clínica con otro
--                       horario obligaba a cambiar código y desplegar.
--   followup_window ... no existía como concepto separado. La ventana para MANDAR
--                       mensajes tomaba la hora de cierre de la clínica, así que un
--                       seguimiento no podía salir después de las 20:00 aunque
--                       estuviera aprobado hasta las 22:00.
--   csat_mode ......... era HELIOS_CSAT_ENABLED, un booleano GLOBAL. Encender la
--                       encuesta la encendía para todas las clínicas a la vez.
--   leads_mode ........ igual, era HELIOS_LEADS_ENABLED.
--   chatwoot_teams .... era HELIOS_HANDOFF_ROUTING_JSON, una variable de entorno.
--   clinic_timezone ... era CLINIC_TIMEZONE, global.
--   clinic_tone ....... era CLINIC_TONE, global.
--
-- ES ADITIVA Y NO CAMBIA NINGÚN COMPORTAMIENTO POR SÍ SOLA. Todas las columnas
-- nacen NULL, y NULL significa «usa lo de siempre»: el horario del código, las
-- variables de entorno, el JSON de enrutado. Aplicarla y no tocar el panel deja el
-- sistema idéntico.
--
-- LAS HORAS VAN COMO TEXTO "HH:MM" a propósito. Estas columnas se miran y se editan
-- a mano en el editor de Supabase, y [[600,1200]] no le dice nada a nadie mientras
-- [["10:00","20:00"]] se lee de un golpe.

BEGIN;

ALTER TABLE public.helios_tenants
  ADD COLUMN IF NOT EXISTS clinic_hours jsonb,
  ADD COLUMN IF NOT EXISTS followup_window jsonb,
  ADD COLUMN IF NOT EXISTS csat_mode text,
  ADD COLUMN IF NOT EXISTS leads_mode text,
  ADD COLUMN IF NOT EXISTS chatwoot_teams jsonb,
  ADD COLUMN IF NOT EXISTS clinic_timezone text,
  ADD COLUMN IF NOT EXISTS clinic_tone text;

-- Los tres estados, con nombre. Un booleano no distinguía «apagado» de «decide y
-- anota pero no toca a nadie», que es como se valida una función con datos reales.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'helios_tenants_csat_mode_valido') THEN
    ALTER TABLE public.helios_tenants ADD CONSTRAINT helios_tenants_csat_mode_valido
      CHECK (csat_mode IS NULL OR csat_mode IN ('off', 'observe', 'on'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'helios_tenants_leads_mode_valido') THEN
    ALTER TABLE public.helios_tenants ADD CONSTRAINT helios_tenants_leads_mode_valido
      CHECK (leads_mode IS NULL OR leads_mode IN ('off', 'observe', 'on'));
  END IF;
  -- El tono viaja a Hermes en CADA turno: un texto largo son tokens pagados en
  -- todos los mensajes de todos los pacientes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'helios_tenants_clinic_tone_largo') THEN
    ALTER TABLE public.helios_tenants ADD CONSTRAINT helios_tenants_clinic_tone_largo
      CHECK (clinic_tone IS NULL OR char_length(clinic_tone) <= 400);
  END IF;
END $$;

COMMENT ON COLUMN public.helios_tenants.clinic_hours IS
  'Horario de atencion: {"mon":[["10:00","20:00"]],"sun":[]}. Decide cuando se puede dar cita. NULL = horario por defecto del codigo.';
COMMENT ON COLUMN public.helios_tenants.followup_window IS
  'Horas decentes para ESCRIBIR: {"desde":"08:00","hasta":"22:00"}. Distinto del horario de atencion. Solo aplica en dias que la clinica trabaja.';
COMMENT ON COLUMN public.helios_tenants.csat_mode IS
  'off = no se evalua | observe = decide y anota sin tocar Chatwoot | on = aplica la etiqueta. NULL = derivado de HELIOS_CSAT_ENABLED.';
COMMENT ON COLUMN public.helios_tenants.leads_mode IS
  'off = no se evalua | observe = decide y anota sin escribir al paciente | on = envia. NULL = derivado de HELIOS_LEADS_ENABLED.';
COMMENT ON COLUMN public.helios_tenants.chatwoot_teams IS
  'IDs de equipo: {"reception":"3","clinical_lead":"4","helios_support":"5"}. Solo digitos. NULL = los de HELIOS_HANDOFF_ROUTING_JSON.';

COMMIT;

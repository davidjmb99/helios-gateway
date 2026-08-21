-- Separar «se observó» de «se envió».
--
-- EL FALLO. lead_followup_at se escribia ANTES de comprobar el modo de la clinica, y
-- sin condicion. En modo observacion eso marcaba la conversacion como «seguimiento
-- hecho» sin haber escrito a nadie, y el barrido filtra por lead_followup_at IS NULL,
-- asi que ESA CONVERSACION NO SE VOLVIA A MIRAR NUNCA.
--
-- El modo observacion existe para «decidir y anotar sin tocar a ningun paciente».
-- Pero si tocaba sus datos, de la unica forma que importa: quemaba el lead. Al
-- encender el modo, los leads ya observados estaban consumidos y no recibirian nada.
--
-- Paso de verdad. El 20 de agosto de 2026 a las 12:09:03 UTC el barrido marco tres
-- conversaciones -73, 81 y 75- con el mismo timestamp al centisegundo. David habia
-- activado el seguimiento en el panel, espero el mensaje, y nunca llego. Las tres
-- quedaron marcadas.
--
-- Ahora son dos columnas distintas porque son dos hechos distintos: uno se le hizo al
-- paciente y el otro no.

ALTER TABLE public.helios_conversation_state
  ADD COLUMN IF NOT EXISTS lead_simulado_at timestamptz;

COMMENT ON COLUMN public.helios_conversation_state.lead_simulado_at IS
  'Cuando el barrido DECIDIO el seguimiento en modo observacion, sin enviar nada. Evita repetir la simulacion en cada barrido sin consumir el lead: lead_followup_at solo se escribe cuando el mensaje sale de verdad.';

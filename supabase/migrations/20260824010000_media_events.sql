-- Lo que cuesta cada archivo que manda un paciente.
--
-- POR QUE UNA TABLA Y NO helios_gateway_logs, donde ya se estaba escribiendo. Los logs
-- son para leerlos cuando algo va mal: texto libre en un JSON, sin indices utiles, y se
-- pueden purgar sin pensarlo. Esto es facturacion. David lo pidio por periodos -dia,
-- semana, mes, 3, 6 meses y año- y eso necesita un timestamp indexado y columnas
-- numericas, no extraer campos de un JSON en cada consulta.
--
-- Y HAY UN MOTIVO MAS IMPORTANTE: el gasto de un archivo NO ES UN TURNO. Vive en el
-- Gateway, ocurre antes de que Hermes exista, y puede haber gasto SIN turno -una cadena
-- reenviada que se ignora cuesta dinero y no genera respuesta-. Meterlo en
-- helios_adapter_events obligaria a inventar un turno que no ocurrio, y el panel diria
-- que hubo mas conversaciones de las que hubo.
--
-- POR QUE `nivel` ES UNA COLUMNA Y NO UNA VARIABLE DE ENTORNO. Gemini tiene dos niveles
-- y la diferencia no es el precio: en el gratuito Google usa el contenido para mejorar
-- sus productos, y en el de pago no. Guardarlo por fila responde «¿cuantos archivos de
-- pacientes pasaron por el nivel gratuito?» con datos, no con lo que alguien creia tener
-- configurado. Una variable puede cambiar entre dos despliegues y nadie se enteraria.

CREATE TABLE IF NOT EXISTS public.helios_media_events (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),

  tenant_id       text NOT NULL,
  conversation_id text,
  contact_id      text,
  trace_id        text,

  tipo            text NOT NULL,
  extension       text,
  categoria       text,
  accion          text NOT NULL,

  proveedor       text NOT NULL DEFAULT 'gemini',
  modelo          text,
  nivel           text,

  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,

  error           text
);

-- El indice que usan las metricas: siempre se filtra por tenant y por fecha, en ese
-- orden, y se lee de lo mas reciente hacia atras.
CREATE INDEX IF NOT EXISTS helios_media_events_tenant_fecha_idx
  ON public.helios_media_events (tenant_id, created_at DESC);

COMMENT ON TABLE public.helios_media_events IS
  'Un archivo procesado por fila: audio, imagen, video o documento convertido en texto por Gemini. Es la fuente del coste de media en el panel del Adapter. Separado de helios_adapter_events porque el gasto ocurre en el Gateway antes de que exista el turno, y porque puede haber gasto sin turno: una cadena reenviada que se ignora cuesta dinero y no genera respuesta.';

COMMENT ON COLUMN public.helios_media_events.accion IS
  'Que se hizo con el archivo: seguir (la conversacion continua), derivar (lo ve una persona), ignorar (no se contesta nada) o sin_procesar (fallo antes o durante la llamada). Si dice ignorar, ese mensaje no recibio respuesta A PROPOSITO.';

COMMENT ON COLUMN public.helios_media_events.nivel IS
  'gratuito o pago, tal como estaba configurado EN EL MOMENTO de la llamada. En el nivel gratuito Google usa el contenido para mejorar sus productos; en el de pago, no. Se guarda por fila y no se lee de una variable porque la pregunta que importa -cuantos archivos de pacientes pasaron por el nivel gratuito- solo la contestan los datos.';

COMMENT ON COLUMN public.helios_media_events.input_tokens IS
  'Tokens de entrada. OJO AL PRECIO: en Gemini el audio cuesta el triple que el texto, la imagen o el video (0,30 frente a 0,10 USD por millon), asi que este numero no se puede valorar sin saber el tipo. Lo resuelve la columna tipo.';

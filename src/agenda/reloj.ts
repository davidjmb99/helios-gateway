/**
 * «Mañana a las 2 de la tarde» convertido en un instante.
 *
 * ES LA DIRECCIÓN DIFÍCIL, la que `huecos.ts` evita a propósito. Allí solo se convierte
 * instante -> hora local, que es exacta siempre. Aquí hay que hacer lo contrario -hora local
 * -> instante-, y eso no tiene solución única: la noche en que el reloj retrasa, «las 2:30»
 * ocurre DOS veces, y la noche en que adelanta no ocurre NINGUNA.
 *
 * Se hace aquí, en un solo sitio, porque alguien tiene que hacerlo: Helios dice «las dos» y
 * Google quiere un instante. Concentrarlo en una función con pruebas es mejor que tenerlo
 * repartido por donde haga falta.
 *
 * Y SIN ZONA NO SE ADIVINA. Un `new Date('2026-09-07T14:00')` sin huso lo interpreta el
 * servidor en SU hora -que en el contenedor es UTC-, así que «las 2 de la tarde» de una
 * clínica de Caracas se convertiría en las 10 de la mañana. No falla, no avisa: da una cita
 * cuatro horas antes.
 */

const FORMATEADORES = new Map<string, Intl.DateTimeFormat>();

function partesEn(fecha: Date, zona: string): Record<string, number> {
  let f = FORMATEADORES.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zona, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    FORMATEADORES.set(zona, f);
  }
  const salida: Record<string, number> = {};
  for (const p of f.formatToParts(fecha)) {
    if (p.type !== 'literal') salida[p.type] = Number(p.value);
  }
  // Intl devuelve «24» para medianoche en algunos entornos.
  if (salida.hour === 24) salida.hour = 0;
  return salida;
}

/** Cuánto se separa esa zona de UTC en ese instante, en milisegundos. */
function desfase(instante: Date, zona: string): number {
  const p = partesEn(instante, zona);
  const comoSiFueraUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return comoSiFueraUtc - instante.getTime();
}

/**
 * El instante en que, en esa zona, el reloj marca esa fecha y esa hora.
 *
 * SE HACE EN DOS PASADAS y no en una. La primera trata la hora local como si fuera UTC y
 * corrige por el desfase de ese momento; la segunda vuelve a mirar el desfase YA en el
 * instante corregido. Sin la segunda, una cita a las 3 de la madrugada del día que cambia
 * la hora se calcula con el desfase del día anterior y queda una hora movida.
 */
function instanteDe(
  y: number, mes: number, d: number, hh: number, mm: number, zona: string
): Date | null {
  const comoUtc = Date.UTC(y, mes - 1, d, hh, mm, 0);
  if (!Number.isFinite(comoUtc)) return null;

  let t = comoUtc - desfase(new Date(comoUtc), zona);
  t = comoUtc - desfase(new Date(t), zona);

  const f = new Date(t);
  if (!Number.isFinite(f.getTime())) return null;

  // SE COMPRUEBA QUE LA VUELTA CUADRE. Si esa hora local NO EXISTE -la madrugada en que el
  // reloj adelanta se salta de 2:00 a 3:00- las dos pasadas convergen en un instante cuya
  // hora local es otra. Antes que devolver una cita a una hora distinta de la pedida, se
  // devuelve null y quien llame decide: preguntar, o derivar.
  const v = partesEn(f, zona);
  if (v.year !== y || v.month !== mes || v.day !== d || v.hour !== hh || v.minute !== mm) return null;

  return f;
}

/**
 * Lee la fecha y hora que manda Helios.
 *
 * SE ADMITEN DOS FORMAS, y la diferencia importa:
 *
 *     2026-09-07T14:00:00-04:00   lleva huso: es un instante, la zona sobra
 *     2026-09-07T14:00           no lo lleva: es hora de la CLÍNICA
 *     2026-09-07 14:00           igual, con espacio en vez de T
 *
 * Lo segundo es lo que va a mandar un modelo casi siempre, porque es lo que se lee en la
 * conversación. Interpretarlo en la hora del servidor -UTC en el contenedor- daría una cita
 * cuatro horas antes en Caracas, sin error y sin aviso.
 */
export function leerMomento(texto: unknown, zona: string): Date | null {
  const bruto = String(texto ?? '').trim();
  if (!bruto) return null;

  // Con huso explícito -o con Z- ya es un instante y no hay nada que interpretar.
  if (/[Zz]$/.test(bruto) || /[+-]\d{2}:?\d{2}$/.test(bruto)) {
    const f = new Date(bruto);
    return Number.isFinite(f.getTime()) ? f : null;
  }

  const m = bruto.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;

  const [, y, mes, d, hh, mm] = m;
  const hora = Number(hh);
  const minuto = Number(mm);
  if (hora > 23 || minuto > 59) return null;

  return instanteDe(Number(y), Number(mes), Number(d), hora, minuto, zona);
}

/** El día de hoy en la zona de la clínica, «2026-09-07». Para hablar de «hoy» sin liarse. */
export function hoyEn(zona: string, ahora: Date = new Date()): string {
  const p = partesEn(ahora, zona);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * ¿Es el primer mensaje del día de esta conversación?
 *
 * PARA QUE HELIOS SALUDE CUANDO TOCA Y NO EN CADA MENSAJE. Un «buenos días» en el primero
 * es cercano; en el cuarto seguido es un robot que no se ha enterado de que la conversación
 * ya estaba abierta. Y no saludar nunca -que es lo que hacía- es seco: David escribió «hola,
 * buenos días» y Helios arrancó con «Le confirmo, Juan: …».
 *
 * EL DÍA ES EL DE LA CLÍNICA, NO EL DEL SERVIDOR. El contenedor corre en UTC, así que a las
 * 22:30 de Caracas allí ya es el día siguiente: media tarde de conversaciones se contaría
 * como primer mensaje del día, y a nadie le saludan a media conversación.
 *
 * SIN ACTIVIDAD ANTERIOR, SÍ. Una conversación que empieza es el primer mensaje de su día
 * por definición. Y si la fecha guardada no se entiende, también: saludar de más es una
 * torpeza pequeña; no saludar a quien acaba de llegar es antipático.
 */
/**
 * Que dia es hoy en la clinica, escrito para que lo lea un modelo de lenguaje.
 *
 * POR QUE HACE FALTA, Y ES UN FALLO REAL DEL 4-sep-2026. Un paciente escribio un jueves y
 * la conversacion quedo en «¿a que hora le quedaria mejor su limpieza para MAÑANA
 * VIERNES?». Al dia siguiente -viernes- volvio a escribir y Helios contesto «quedamos en
 * agendar su limpieza para mañana viernes». Ayer era cierto; hoy manda al paciente al
 * sabado creyendo que es viernes.
 *
 * UNA FECHA RELATIVA GUARDADA EN EL HISTORIAL ES UNA BOMBA DE RELOJERIA: deja de ser
 * cierta al dia siguiente, y el modelo tiene delante la frase ya escrita. Una regla en el
 * SOUL que diga «recalculalo» es debil contra eso, porque le pide deducir lo que ya cree
 * saber.
 *
 * ASI QUE HOY VIAJA COMO UN HECHO, igual que la direccion y los precios (HEL-085): lo que
 * llega en la peticion es un dato, y lo que hay que deducir del historial es un recuerdo
 * del que el SOUL le enseña a desconfiar. Con la fecha delante no tiene por que fiarse de
 * una frase de ayer.
 *
 * Y EN LA ZONA DE LA CLINICA, no en la del servidor. El contenedor corre en UTC: a las
 * 22:30 de Caracas alli ya es el dia siguiente, y «hoy» seria mañana.
 */
export function fechaDeHoyEn(zona: string, ahora: Date = new Date()): {
  today: string;
  today_label: string;
} {
  const iso = hoyEn(zona, ahora);

  // EN ESPAÑOL Y A MANO, sin depender del locale del contenedor. `Intl` con 'es-ES'
  // funcionaria, pero los datos de locale no siempre estan completos en una imagen alpine
  // y un «Friday» suelto en un prompt en español es justo el tipo de detalle que el modelo
  // copia. Son diecinueve palabras, no una dependencia.
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const MESES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];

  // El dia de la semana se saca de la fecha YA en la zona de la clinica, tomandola como
  // UTC a mediodia: a las 12:00Z ningun desplazamiento horario del mundo cambia el dia,
  // asi que no hay que preocuparse por los bordes.
  const [anio, mes, dia] = iso.split('-').map(Number);
  const aMediodia = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));

  return {
    today: iso,
    today_label: `${DIAS[aMediodia.getUTCDay()]} ${dia} de ${MESES[mes - 1]} de ${anio}`
  };
}

/**
 * Cuando fue la ultima vez que se hablo en esta conversacion, dicho para un modelo.
 *
 * EL FALLO QUE ARREGLA, Y ES EL TERCERO DEL MISMO TIPO EN UN DIA. Un paciente escribio un
 * viernes pidiendo cita, y el sabado volvio con «hola, buenos dias». Helios contesto
 * «¿le gustaria agendar su limpieza? ¿que dia y a que hora le queda mejor?»: bien -vuelve
 * a ofrecer y no arrastra la hora de entonces- pero SIN DECIR CUANDO FUE. Lo que se
 * buscaba era «el viernes me pregunto por una limpieza».
 *
 * Y NO ES QUE IGNORARA LA REGLA: es que probablemente NO PODIA SABERLO. En el payload solo
 * viaja el mensaje actual; el historial vive en la sesion de Hermes y ahi los mensajes no
 * llevan una fecha que el modelo pueda usar con soltura. Sabia que habia un tema
 * pendiente. No sabia que era del viernes.
 *
 * ES EL MISMO PATRON QUE `today` Y QUE EL ESPEJO DEL TRATO: se le pedia deducir algo que
 * no tenia delante. La solucion es la de siempre -darle el hecho- y las dos veces
 * anteriores funciono.
 *
 * DEVUELVE null SI FUE HOY, y eso es la señal: sin campo, el tema es de hoy y la
 * conversacion se continua con naturalidad; con campo, hay que nombrar cuando fue y volver
 * a ofrecer. Es como viajan `doctors`, `services` y `clinic_address`: su ausencia dice algo.
 */
export function ultimaActividadEn(
  ultimaActividad: unknown,
  zona: string,
  ahora: Date = new Date()
): { ultima_actividad: string; ultima_actividad_label: string } | null {
  const bruto = String(ultimaActividad ?? '').trim();
  if (!bruto) return null;

  const antes = new Date(bruto);
  if (!Number.isFinite(antes.getTime())) return null;
  // Una fecha en el futuro es un reloj mal puesto. No se inventa nada.
  if (antes.getTime() > ahora.getTime()) return null;

  const diaDeEntonces = hoyEn(zona, antes);
  const diaDeHoy = hoyEn(zona, ahora);
  if (diaDeEntonces === diaDeHoy) return null;

  // Y ADEMAS TIENE QUE HABER PASADO TIEMPO DE VERDAD, no solo la medianoche.
  //
  // Lo encontro una prueba: un paciente que escribe a las 23:50 y vuelve a las 00:14 esta
  // en DOS DIAS DE CALENDARIO distintos y a VEINTICUATRO MINUTOS de distancia. Decirle
  // «ayer me preguntaste» suena raro, y lo peor no es como suena: la regla del SOUL haria
  // que Helios volviera a OFRECER en medio de la misma conversacion, como si el paciente
  // hubiera podido cambiar de idea mientras cruzaba la medianoche.
  //
  // CUATRO HORAS ES UN JUICIO, NO UNA CONSTANTE SAGRADA. Lo que se busca es «se fue y
  // volvio»: cubre el caso de la medianoche -veinticuatro minutos- sin dejar fuera el que
  // importa, que es escribir por la noche y volver por la mañana -diez o doce horas-.
  const HORAS_MINIMAS = 4;
  if (ahora.getTime() - antes.getTime() < HORAS_MINIMAS * 3_600_000) return null;

  // LOS DIAS SE CUENTAN POR FECHA DE CALENDARIO, NO POR HORAS TRANSCURRIDAS. De las
  // 23:00 de ayer a las 01:00 de hoy hay dos horas y es «ayer»; de las 01:00 de ayer a
  // las 23:00 de hoy hay cuarenta y seis y sigue siendo «ayer». Contar horas diria una
  // cosa distinta en cada caso, y el paciente piensa en dias.
  const aMediodiaUTC = (iso: string) => {
    const [a, m, d] = iso.split('-').map(Number);
    // Mediodia: a las 12:00Z ningun desplazamiento horario cambia el dia, asi que la
    // resta no se rompe en los bordes ni con el cambio de hora.
    return Date.UTC(a, m - 1, d, 12, 0, 0);
  };
  const dias = Math.round(
    (aMediodiaUTC(diaDeHoy) - aMediodiaUTC(diaDeEntonces)) / 86_400_000
  );

  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const MESES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];
  const [anio, mes, dia] = diaDeEntonces.split('-').map(Number);

  let etiqueta: string;
  if (dias === 1) {
    etiqueta = 'ayer';
  } else if (dias < 7) {
    // DE DOS A SEIS DIAS, EL NOMBRE DEL DIA. «el viernes» se entiende sin pensar.
    etiqueta = 'el ' + DIAS[new Date(aMediodiaUTC(diaDeEntonces)).getUTCDay()];
  } else {
    // A PARTIR DE SIETE, LA FECHA. A los siete dias exactos el nombre del dia es el
    // mismo que hoy -«el sabado» estando en sabado- y eso no situa nada.
    etiqueta = `el ${dia} de ${MESES[mes - 1]}`;
  }

  return { ultima_actividad: diaDeEntonces, ultima_actividad_label: etiqueta };
}

export function esPrimerMensajeDelDia(
  ultimaActividad: unknown,
  zona: string,
  ahora: Date = new Date()
): boolean {
  const bruto = String(ultimaActividad ?? '').trim();
  if (!bruto) return true;

  const antes = new Date(bruto);
  if (!Number.isFinite(antes.getTime())) return true;

  // Una fecha en el futuro es un reloj mal puesto en algún sitio. No se saluda por si
  // acaso: la conversación estaba viva hace nada.
  if (antes.getTime() > ahora.getTime()) return false;

  return hoyEn(zona, antes) !== hoyEn(zona, ahora);
}

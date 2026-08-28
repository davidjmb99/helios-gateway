/**
 * Hablar con Google Calendar: qué está ocupado, y crear, mover o cancelar una cita.
 *
 * ESTE MÓDULO ES LA PARTE FÁCIL, y conviene decirlo porque parece al revés. Aquí sólo hay
 * peticiones HTTP. La parte difícil de una agenda con varios doctores -cruzar horarios,
 * márgenes, antelación y reparto- está en `huecos.ts`, que se prueba sin red y sin
 * credenciales. La frontera es ésta:
 *
 *     GOOGLE DICE     QUÉ ESTÁ OCUPADO
 *     HELIOS SABE     CUÁNDO TRABAJA CADA UNO
 *
 * POR QUÉ UNA CUENTA DE SERVICIO Y NO OAUTH POR DOCTOR. Con OAuth habría que perseguir a
 * tres o cuatro personas para que autoricen, y luego guardar y refrescar un token por
 * cabeza -y un token caducado un domingo es una clínica sin agenda el lunes-. Con una
 * cuenta de servicio, la clínica comparte cada calendario con un correo y se acabó: no hay
 * pantalla de consentimiento, no hay nada que caduque, y cortarle el acceso es quitarle el
 * permiso en el calendario, sin tocar código ni Google Cloud.
 *
 * DOS COSAS QUE GOOGLE HACE Y NO SE VEN VENIR:
 *
 *  1. UN EVENTO DE DÍA COMPLETO SALE COMO «DISPONIBLE» POR DEFECTO. El doctor que crea un
 *     evento «no vengo el lunes» de todo el día cree que se ha bloqueado, y `freeBusy` lo
 *     devuelve como libre. No se puede arreglar aquí sin romper el caso contrario -quien
 *     marca algo «Disponible» lo hace porque SÍ lo está-, así que se arregla diciéndoselo
 *     a los doctores: «Fuera de la oficina», o el evento en «Ocupado». Paso 10 del manual.
 *
 *  2. UNA CUENTA DE SERVICIO NO PUEDE INVITAR ASISTENTES. Google lo rechaza salvo con
 *     delegación a nivel de dominio, que es montar un Workspace entero. Por eso el
 *     paciente NO va como invitado: va en el título y en la descripción del evento, que es
 *     lo que la recepcionista necesita ver de todas formas.
 */

import { createSign, createHash } from 'node:crypto';
import { config } from '../config.js';
import type { DoctorConAgenda, FranjaOcupada } from './huecos.js';
import type { DoctorDeClinica } from './doctores.js';

const OAUTH = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

/**
 * Cuántos calendarios acepta `freeBusy` en una sola llamada. Es un límite de Google.
 *
 * Nunca se toca: `leerDoctores` no guarda más de veinte doctores. Está comprobado igual
 * porque el día que ese tope suba, el fallo sería que Google ignora los calendarios de más
 * y esos doctores saldrían LIBRES A TODAS HORAS, que es la peor forma de fallar.
 */
const MAX_CALENDARIOS = 50;

/** Se pide el token con un minuto de sobra: uno que caduca a mitad de petición es un 401. */
const MARGEN_DE_TOKEN_MS = 60_000;

export interface CredencialesDeGoogle {
  correo: string;
  clave: string;
}

/** Lo que sale mal tiene nombre propio, para que el error diga dónde mirar. */
export interface ErrorDeAgenda {
  error: string;
}

export const esError = (x: unknown): x is ErrorDeAgenda =>
  typeof x === 'object' && x !== null && typeof (x as any).error === 'string';

/**
 * La credencial, sacada de la variable de entorno.
 *
 * VIENE EN BASE64 A PROPÓSITO. El JSON de Google son varias líneas y la clave privada
 * lleva saltos de línea dentro; pegado tal cual en una variable de entorno se rompe de
 * formas raras -a veces la clave llega con `\n` literales de dos caracteres y la firma
 * falla con un error que no menciona el formato-. En base64 es una línea sin sorpresas.
 *
 * Se acepta también el JSON pegado directamente, porque alguien lo hará.
 */
export function leerCredenciales(valor: string): CredencialesDeGoogle | ErrorDeAgenda {
  const bruto = (valor || '').trim();
  if (!bruto) return { error: 'agenda_sin_credenciales' };

  let texto = bruto;
  if (!bruto.startsWith('{')) {
    try {
      texto = Buffer.from(bruto, 'base64').toString('utf8');
    } catch {
      return { error: 'agenda_credenciales_ilegibles' };
    }
  }

  let datos: any;
  try {
    datos = JSON.parse(texto);
  } catch {
    return { error: 'agenda_credenciales_ilegibles' };
  }

  const correo = String(datos?.client_email || '').trim();
  let clave = String(datos?.private_key || '');

  // SI LA CLAVE LLEGA CON `\n` LITERALES se convierten a saltos de verdad. Pasa cuando
  // alguien pega el JSON en un formulario que escapa las cadenas, y sin esto la firma
  // falla con «error:0909006C:PEM routines», que no dice nada de dónde está el problema.
  if (clave.includes('\\n')) clave = clave.replace(/\\n/g, '\n');

  if (!correo || !clave.includes('PRIVATE KEY')) {
    return { error: 'agenda_credenciales_incompletas' };
  }
  return { correo, clave: clave.trim() };
}

const base64url = (b: Buffer | string) =>
  (Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * El JWT firmado que se cambia por un token de acceso.
 *
 * Es todo el mecanismo de una cuenta de servicio: se afirma quién eres y para qué, se
 * firma con la clave privada, y Google devuelve un token de una hora. No hay refresh token
 * ni nada que renovar a mano.
 */
function firmarJwt(cred: CredencialesDeGoogle, ahora: Date, ambito: string): string {
  const segundos = Math.floor(ahora.getTime() / 1000);
  const cabecera = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = base64url(JSON.stringify({
    iss: cred.correo,
    scope: ambito,
    aud: OAUTH,
    iat: segundos,
    exp: segundos + 3600
  }));
  const firma = createSign('RSA-SHA256').update(`${cabecera}.${cuerpo}`).sign(cred.clave);
  return `${cabecera}.${cuerpo}.${base64url(firma)}`;
}

/**
 * El token vivo, guardado hasta que caduque.
 *
 * Se guarda por correo de la cuenta de servicio y no en una variable suelta: si algún día
 * hay una credencial por clínica, esto sigue siendo correcto sin tocarlo. Pedir un token
 * en cada consulta de huecos sería doblar la latencia de cada pregunta por una hora de
 * validez que se está tirando.
 */
const TOKENS = new Map<string, { token: string; caduca: number }>();

/** Sólo para las pruebas y para el arranque: un token guardado no debe cruzar escenarios. */
export function olvidarTokens(): void {
  TOKENS.clear();
}

export interface Dependencias {
  fetchImpl?: typeof fetch;
  ahora?: Date;
  /** La credencial ya leída. Si no se pasa, sale de la variable de entorno. */
  credenciales?: CredencialesDeGoogle;
  timeoutMs?: number;
}

async function conCorte<T>(
  timeoutMs: number,
  hacer: (senal: AbortSignal) => Promise<T>
): Promise<T | ErrorDeAgenda> {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), timeoutMs);
  try {
    return await hacer(corte.signal);
  } catch (e: any) {
    return { error: e?.name === 'AbortError' ? 'agenda_tiempo_agotado' : 'agenda_sin_respuesta' };
  } finally {
    clearTimeout(reloj);
  }
}

function credencialesDe(deps: Dependencias): CredencialesDeGoogle | ErrorDeAgenda {
  return deps.credenciales ?? leerCredenciales(config.GOOGLE_SERVICE_ACCOUNT_JSON);
}

export async function tokenDeAcceso(deps: Dependencias = {}): Promise<string | ErrorDeAgenda> {
  const cred = credencialesDe(deps);
  if (esError(cred)) return cred;

  const ahora = deps.ahora ?? new Date();
  const guardado = TOKENS.get(cred.correo);
  if (guardado && guardado.caduca > ahora.getTime() + MARGEN_DE_TOKEN_MS) return guardado.token;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const ambito = config.GOOGLE_CALENDAR_SCOPE;
  let jwt: string;
  try {
    jwt = firmarJwt(cred, ahora, ambito);
  } catch {
    // La clave privada no sirve para firmar. Es distinto de que Google la rechace: aquí ni
    // siquiera se ha salido a la red, así que el problema está en la variable de entorno.
    return { error: 'agenda_clave_invalida' };
  }

  const respuesta = await conCorte(deps.timeoutMs ?? config.AGENDA_TIMEOUT_MS, senal =>
    fetchImpl(OAUTH, {
      method: 'POST',
      signal: senal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      }).toString()
    })
  );
  if (esError(respuesta)) return respuesta;

  if (!respuesta.ok) {
    const cuerpo = await respuesta.text().catch(() => '');
    // EL MOTIVO DE GOOGLE VA EN EL ERROR. Los dos fallos de aquí se parecen y se arreglan
    // en sitios distintos: `invalid_grant` suele ser el reloj del servidor o una cuenta
    // borrada, e `invalid_scope` es el ámbito -y entonces GOOGLE_CALENDAR_SCOPE es lo que
    // hay que cambiar, no la credencial-.
    let motivo = String(respuesta.status);
    try {
      const datos = JSON.parse(cuerpo);
      if (datos?.error) motivo = String(datos.error);
    } catch { /* el cuerpo no era JSON: se queda el código HTTP */ }
    return { error: `agenda_token_rechazado_${motivo}` };
  }

  const datos: any = await respuesta.json().catch(() => null);
  const token = String(datos?.access_token || '');
  if (!token) return { error: 'agenda_token_vacio' };

  const duracion = Number(datos?.expires_in);
  TOKENS.set(cred.correo, {
    token,
    caduca: ahora.getTime() + (Number.isFinite(duracion) && duracion > 0 ? duracion * 1000 : 3600_000)
  });
  return token;
}

/**
 * Lo ocupado de cada calendario en una ventana.
 *
 * EL VALOR `null` SIGNIFICA «NO SE PUDO LEER», Y NO ES LO MISMO QUE «LIBRE». Google
 * responde por calendario: uno puede fallar -permiso quitado, ID mal copiado- mientras los
 * demás contestan bien. Ese calendario NO puede tratarse como libre, porque el fallo de
 * dar una cita que no existe se paga en el mostrador con un paciente delante. Quien
 * consuma esto tiene que decidir qué hace con el `null`; `agendaDeDoctores` lo trata como
 * ocupado a todas horas.
 *
 * Si falla la llamada entera -credencial mala, Google caído- eso es un ErrorDeAgenda y NO
 * un mapa de nulos: «todos ocupados» le diría al paciente que no hay hueco, que es mentira.
 * Un error se deriva a una persona; un «no hay huecos» se cree.
 */
export type Ocupacion = Map<string, FranjaOcupada[] | null>;

export async function ocupacionDe(
  entrada: { calendarios: string[]; desde: Date; hasta: Date },
  deps: Dependencias = {}
): Promise<Ocupacion | ErrorDeAgenda> {
  const calendarios = [...new Set((entrada.calendarios ?? []).map(c => String(c || '').trim()).filter(Boolean))];
  if (calendarios.length === 0) return new Map();
  if (calendarios.length > MAX_CALENDARIOS) return { error: 'agenda_demasiados_calendarios' };

  const token = await tokenDeAcceso(deps);
  if (esError(token)) return token;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const respuesta = await conCorte(deps.timeoutMs ?? config.AGENDA_TIMEOUT_MS, senal =>
    fetchImpl(`${API}/freeBusy`, {
      method: 'POST',
      signal: senal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        timeMin: entrada.desde.toISOString(),
        timeMax: entrada.hasta.toISOString(),
        items: calendarios.map(id => ({ id }))
      })
    })
  );
  if (esError(respuesta)) return respuesta;
  if (!respuesta.ok) {
    // Un 401 aquí es un token que caducó antes de lo dicho o una credencial revocada. Se
    // tira el guardado para que el siguiente intento pida uno nuevo en vez de repetir el
    // mismo token muerto hasta que expire su hora.
    if (respuesta.status === 401) olvidarTokens();
    return { error: `agenda_google_${respuesta.status}` };
  }

  const datos: any = await respuesta.json().catch(() => null);
  const porCalendario = datos?.calendars;
  if (!porCalendario || typeof porCalendario !== 'object') return { error: 'agenda_respuesta_ilegible' };

  const mapa: Ocupacion = new Map();
  // Google devuelve las claves tal como se pidieron, pero se busca sin distinguir
  // mayúsculas porque un ID de calendario es un correo y los correos no las distinguen.
  const claves = new Map(Object.keys(porCalendario).map(k => [k.toLowerCase(), k]));

  for (const id of calendarios) {
    const clave = claves.get(id.toLowerCase());
    const fila = clave === undefined ? undefined : porCalendario[clave];

    // SIN FILA, O CON ERRORES, EL CALENDARIO ES ILEGIBLE. `errors` es lo que devuelve
    // Google cuando el ID no existe o la cuenta de servicio no tiene permiso -el paso 5
    // del manual, el que se olvida-, y viene junto a un `busy` vacío que parecería un
    // doctor con el día entero libre.
    if (!fila || (Array.isArray(fila.errors) && fila.errors.length > 0)) {
      mapa.set(id, null);
      continue;
    }

    const franjas: FranjaOcupada[] = [];
    let ilegible = false;
    for (const b of Array.isArray(fila.busy) ? fila.busy : []) {
      const desde = new Date(b?.start);
      const hasta = new Date(b?.end);
      if (!Number.isFinite(desde.getTime()) || !Number.isFinite(hasta.getTime()) || hasta <= desde) {
        // Una franja que no se entiende invalida el calendario entero: no se sabe qué
        // trozo del día tapaba, así que ignorarla sería ofrecer justo esa hora.
        ilegible = true;
        break;
      }
      franjas.push({ desde, hasta });
    }
    mapa.set(id, ilegible ? null : franjas);
  }
  return mapa;
}

/**
 * Los doctores listos para `huecosDisponibles`: su horario, su prioridad y lo que Google
 * dice que tienen ocupado.
 *
 * ES EL PUENTE ENTRE LOS DOS MÓDULOS y el único sitio donde se decide qué hacer con un
 * calendario ilegible: se le tapa la ventana entera. Ese doctor no recibe citas hasta que
 * se arregle el permiso, y los demás siguen trabajando.
 */
export async function agendaDeDoctores(
  entrada: {
    doctores: Array<DoctorDeClinica & { prioridad?: number }>;
    desde: Date;
    hasta: Date;
  },
  deps: Dependencias = {}
): Promise<DoctorConAgenda[] | ErrorDeAgenda> {
  const doctores = (entrada.doctores ?? []).filter(d => d && d.calendario);
  if (doctores.length === 0) return [];

  const ocupacion = await ocupacionDe(
    { calendarios: doctores.map(d => d.calendario), desde: entrada.desde, hasta: entrada.hasta },
    deps
  );
  if (esError(ocupacion)) return ocupacion;

  const ventana: FranjaOcupada[] = [{ desde: entrada.desde, hasta: entrada.hasta }];
  return doctores.map(d => {
    const suyo = ocupacion.get(d.calendario);
    return {
      id: d.calendario,
      nombre: d.nombre,
      horario: d.horario,
      ocupado: suyo === null || suyo === undefined ? ventana : suyo,
      prioridad: d.prioridad ?? 0
    };
  });
}

/**
 * El ID del evento, derivado de la cita en vez de dejárselo a Google.
 *
 * ES LO QUE IMPIDE DOBLAR UNA CITA AL REINTENTAR. Si la petición de crear se corta después
 * de que Google la haya guardado -un timeout, un contenedor que se reinicia-, el reintento
 * llega con el mismo ID y Google devuelve 409 en vez de crear una segunda cita idéntica.
 * Sin esto, un reintento deja al paciente con dos huecos y al doctor con una hora perdida.
 *
 * Los IDs de Google admiten `[a-v0-9]`, y un hexadecimal sólo usa `0-9a-f`: cabe entero.
 */
export function idDeEvento(...partes: Array<string | number>): string {
  // TREINTA Y DOS CARACTERES BASTAN, y el largo importa: este id acaba dentro del
  // `booking_uid`, que se guarda en el estado de la conversacion y viaja en cada mensaje
  // mientras la cita exista. Los 128 bits que quedan siguen haciendo imposible que dos
  // citas distintas choquen: la entrada ya lleva clinica, calendario y hora.
  return 'h' + createHash('sha256').update(partes.join('|')).digest('hex').slice(0, 31);
}

export interface DatosDeCita {
  calendario: string;
  inicio: Date;
  fin: Date;
  /** Lo que se lee de un vistazo en la agenda: «Valoración · María Pérez». */
  titulo: string;
  /** Teléfono, motivo, lo que haga falta para llamar al paciente. */
  descripcion?: string;
  /** La zona de la clínica. Google la necesita para mostrar la hora bien. */
  zona: string;
  /** El ID estable de `idDeEvento`. Sin él, un reintento crea una cita de más. */
  id?: string;
}

export interface CitaCreada {
  id: string;
  calendario: string;
  inicio: Date;
  fin: Date;
  /** Si ya existía: el reintento encontró la cita que la primera llamada sí guardó. */
  yaExistia: boolean;
}

async function pedir(
  ruta: string,
  opciones: { metodo: string; cuerpo?: unknown },
  deps: Dependencias
): Promise<{ ok: true; datos: any } | ErrorDeAgenda> {
  const token = await tokenDeAcceso(deps);
  if (esError(token)) return token;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const respuesta = await conCorte(deps.timeoutMs ?? config.AGENDA_TIMEOUT_MS, senal =>
    fetchImpl(`${API}${ruta}`, {
      method: opciones.metodo,
      signal: senal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(opciones.cuerpo === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(opciones.cuerpo === undefined ? {} : { body: JSON.stringify(opciones.cuerpo) })
    })
  );
  if (esError(respuesta)) return respuesta;

  if (!respuesta.ok) {
    if (respuesta.status === 401) olvidarTokens();
    return { error: `agenda_google_${respuesta.status}` };
  }
  // El DELETE de Google devuelve 204 sin cuerpo.
  const datos = respuesta.status === 204 ? {} : await respuesta.json().catch(() => ({}));
  return { ok: true, datos };
}

/**
 * Crea la cita.
 *
 * EL PACIENTE NO VA COMO INVITADO. Una cuenta de servicio no puede invitar a nadie sin
 * delegación a nivel de dominio, y Google rechaza la petición entera si lo intenta: se
 * perdería la cita por querer mandar un correo. Va en el título y en la descripción, que
 * es lo que la recepcionista mira.
 */
export async function crearCita(
  cita: DatosDeCita,
  deps: Dependencias = {}
): Promise<CitaCreada | ErrorDeAgenda> {
  const resultado = await pedir(
    `/calendars/${encodeURIComponent(cita.calendario)}/events`,
    {
      metodo: 'POST',
      cuerpo: {
        ...(cita.id ? { id: cita.id } : {}),
        summary: cita.titulo,
        ...(cita.descripcion ? { description: cita.descripcion } : {}),
        start: { dateTime: cita.inicio.toISOString(), timeZone: cita.zona },
        end: { dateTime: cita.fin.toISOString(), timeZone: cita.zona },
        // EXPLÍCITO AUNQUE SEA EL DEFECTO de un evento con hora. Es lo que hace que la
        // cita cuente en `freeBusy`; un evento «transparent» sería una cita que no ocupa,
        // y el doctor acabaría con dos pacientes a la misma hora.
        transparency: 'opaque'
      }
    },
    deps
  );

  // 409 ES ÉXITO, NO FALLO. Significa que ya hay un evento con ese ID, es decir, que la
  // llamada anterior sí llegó a guardar la cita aunque nosotros no viéramos la respuesta.
  if (esError(resultado)) {
    if (resultado.error === 'agenda_google_409' && cita.id) {
      return { id: cita.id, calendario: cita.calendario, inicio: cita.inicio, fin: cita.fin, yaExistia: true };
    }
    return resultado;
  }

  const id = String(resultado.datos?.id || cita.id || '');
  if (!id) return { error: 'agenda_cita_sin_id' };
  return { id, calendario: cita.calendario, inicio: cita.inicio, fin: cita.fin, yaExistia: false };
}

/**
 * Mueve una cita a otra hora, y si hace falta a otro calendario.
 *
 * CAMBIAR DE DOCTOR NO ES UN PATCH: en Google, mover un evento de un calendario a otro es
 * `move`, una llamada aparte. Se hace primero el traslado y luego la hora, porque al revés
 * el traslado podría fallar y dejar la cita con la hora nueva en el doctor viejo.
 */
export async function moverCita(
  entrada: {
    calendario: string;
    id: string;
    inicio: Date;
    fin: Date;
    zona: string;
    /** Si se cambia de doctor. */
    calendarioDestino?: string;
  },
  deps: Dependencias = {}
): Promise<{ id: string; calendario: string } | ErrorDeAgenda> {
  let calendario = entrada.calendario;

  if (entrada.calendarioDestino && entrada.calendarioDestino !== entrada.calendario) {
    const traslado = await pedir(
      `/calendars/${encodeURIComponent(entrada.calendario)}/events/${encodeURIComponent(entrada.id)}/move`
        + `?destination=${encodeURIComponent(entrada.calendarioDestino)}`,
      { metodo: 'POST' },
      deps
    );
    if (esError(traslado)) return traslado;
    calendario = entrada.calendarioDestino;
  }

  const resultado = await pedir(
    `/calendars/${encodeURIComponent(calendario)}/events/${encodeURIComponent(entrada.id)}`,
    {
      metodo: 'PATCH',
      cuerpo: {
        start: { dateTime: entrada.inicio.toISOString(), timeZone: entrada.zona },
        end: { dateTime: entrada.fin.toISOString(), timeZone: entrada.zona }
      }
    },
    deps
  );
  if (esError(resultado)) return resultado;
  return { id: entrada.id, calendario };
}

/**
 * Cancela la cita.
 *
 * UNA CITA QUE YA NO ESTÁ ES UNA CANCELACIÓN HECHA. Google devuelve 404 o 410 si el evento
 * no existe o ya estaba cancelado, y eso no es un fallo que haya que contarle a nadie: el
 * resultado que se pedía -que esa hora quede libre- es exactamente el que hay.
 */
export async function cancelarCita(
  entrada: { calendario: string; id: string },
  deps: Dependencias = {}
): Promise<{ cancelada: true } | ErrorDeAgenda> {
  const resultado = await pedir(
    `/calendars/${encodeURIComponent(entrada.calendario)}/events/${encodeURIComponent(entrada.id)}`,
    { metodo: 'DELETE' },
    deps
  );
  if (esError(resultado)) {
    if (resultado.error === 'agenda_google_404' || resultado.error === 'agenda_google_410') {
      return { cancelada: true };
    }
    return resultado;
  }
  return { cancelada: true };
}

export const LIMITES_DE_AGENDA = { calendarios: MAX_CALENDARIOS };

/**
 * ¿Está bien montada la agenda de esta clínica?
 *
 * EXISTE POR UN PASO QUE SE OLVIDA. Montar la agenda son siete pasos en Google -habilitar
 * la API, crear la cuenta de servicio, la clave, un calendario por doctor, compartir cada
 * uno, copiar los IDs, la variable en Coolify- y el que se salta todo el mundo es el
 * quinto: compartir el calendario con el correo de la cuenta de servicio.
 *
 * Y NO SE NOTA. Un calendario sin compartir no da error en ninguna pantalla: Google
 * devuelve el fallo junto a una lista de ocupación vacía, que es exactamente lo que parece
 * un doctor con la agenda libre. Sin esto, la primera señal de que el paso 5 faltaba sería
 * un paciente citado con alguien que ya tenía esa hora cogida.
 *
 * SOLO LEE. No crea ningún evento de prueba: dejar basura en el calendario de un doctor
 * para comprobar que se puede escribir es peor que no comprobarlo. Que la escritura
 * funciona lo dice el mismo permiso que la lectura -«hacer cambios en los eventos»-, así
 * que si `freeBusy` contesta, crear también va a funcionar.
 */

import { leerDoctores, doctoresPara, type DoctorDeClinica } from './doctores.js';
import { leerCierres, estaCerrado, type Cierre } from './cierres.js';
import { agendaDeDoctores, esError, type Dependencias } from './google.js';
import { huecosDisponibles } from './huecos.js';
import type { HorarioClinica } from '../leads/policy.js';

const LETRAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

export interface DoctorRevisado {
  nombre: string;
  calendario: string;
  /** `ok` si Google contestó por él; `sin_acceso` si no, que casi siempre es el paso 5. */
  permiso: 'ok' | 'sin_acceso';
  /** Cuántas franjas ocupadas tiene en la ventana mirada. */
  ocupado: number;
  /** Los días que trabaja, como se leen: «LMXJVS». */
  dias: string;
  hace: string[];
}

export interface InformeDeAgenda {
  ok: boolean;
  /** Lo que hay que arreglar, en el orden en que hay que arreglarlo. */
  problemas: string[];
  zona: string;
  doctores: DoctorRevisado[];
  cierres: Cierre[];
  /** Los primeros huecos que se le ofrecerían a un paciente ahora mismo. */
  huecos: Array<{ cuando: string; doctor: string }>;
  /**
   * CON QUÉ ESTÁ TRABAJANDO, y esto no es un extra.
   *
   * La primera vez que este informe dijo «no hay ningún hueco» con las cuatro agendas
   * vacías y en verde, no había forma de saber por qué: ni qué horario estaba usando, ni en
   * qué zona, ni qué ventana miraba. Se estuvo adivinando un rato. Un diagnóstico que no
   * enseña sus entradas es medio diagnóstico.
   */
  usando: {
    /** El horario de la clínica, día por día, como lo entendió. */
    horario: string[];
    /** Desde cuándo y hasta cuándo se miró, en hora de la clínica. */
    ventana: string;
    /** Cuántos huecos salieron ANTES de descontar los días cerrados. */
    huecos_sin_filtrar: number;
    duracion_min: number;
    margen_min: number;
  };
}

/** «2026-09-05» en la zona de la clínica, para comparar con los cierres. */
function diaLocal(fecha: Date, zona: string): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return f.format(fecha);
}

export async function probarAgenda(
  entrada: {
    doctoresTexto: unknown;
    cierresTexto: unknown;
    horario: HorarioClinica;
    zona: string;
    /** Qué servicio se simula. Sin él, se prueban todos los doctores. */
    servicio?: string;
    duracionMin?: number;
    margenMin?: number;
    dias?: number;
    ahora?: Date;
  },
  deps: Dependencias = {}
): Promise<InformeDeAgenda> {
  const ahora = entrada.ahora ?? new Date();
  const zona = entrada.zona;
  const problemas: string[] = [];

  const duracion = entrada.duracionMin ?? 45;
  const margen = entrada.margenMin ?? 15;
  const LETRAS_DIA = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const horarioLegible = [0, 1, 2, 3, 4, 5, 6].map(d => {
    const tramos = (entrada.horario as any)?.[d] ?? [];
    return `${LETRAS_DIA[d]}: ` + (tramos.length === 0
      ? 'cerrado'
      : tramos.map((t: any) => `${hhmm(t.desde)}-${hhmm(t.hasta)}`).join(', '));
  });

  const usando = {
    horario: horarioLegible,
    ventana: '',
    huecos_sin_filtrar: 0,
    duracion_min: duracion,
    margen_min: margen
  };

  const vacio: InformeDeAgenda = { ok: false, problemas, zona, doctores: [], cierres: [], huecos: [], usando };

  const doctores = leerDoctores(entrada.doctoresTexto, entrada.horario);
  if (!doctores) {
    // SE DISTINGUE «NO HAY» DE «ESTÁ MAL», porque son dos trabajos distintos: uno es
    // rellenar el campo y el otro es encontrar la línea que no se entiende.
    problemas.push(
      String(entrada.doctoresTexto ?? '').trim()
        ? 'Los doctores no se entienden: hay alguna linea mal y NO se ha guardado ninguna.'
        : 'No hay doctores configurados en Ajustes.'
    );
    return vacio;
  }

  // Los cierres son opcionales: una clínica sin festivos puestos es una clínica normal.
  const cierres = leerCierres(entrada.cierresTexto) ?? [];
  if (String(entrada.cierresTexto ?? '').trim() && cierres.length === 0) {
    problemas.push('Los dias cerrados no se entienden y NO se ha guardado ninguno.');
  }

  const dias = Math.min(Math.max(Number(entrada.dias) || 7, 1), 30);
  const desde = ahora;
  const hasta = new Date(ahora.getTime() + dias * 24 * 60 * 60 * 1000);

  const elegidos: Array<DoctorDeClinica & { prioridad?: number }> = entrada.servicio
    ? doctoresPara(doctores, entrada.servicio)
    : doctores.map(d => ({ ...d, prioridad: 0 }));

  const agenda = await agendaDeDoctores({ doctores: elegidos, desde, hasta }, deps);
  if (esError(agenda)) {
    // ESTO ES LO QUE SE VE CUANDO FALLA LA CREDENCIAL, y hay que distinguirlo de «este
    // doctor no tiene permiso»: uno se arregla en Coolify y el otro en calendar.google.com.
    problemas.push(`Google no contesta: ${agenda.error}`);
    return { ...vacio, cierres };
  }

  // UN CALENDARIO SIN ACCESO SE RECONOCE PORQUE VIENE TAPADO ENTERO. Es lo que hace
  // `agendaDeDoctores` con lo que no puede leer, y aquí se traduce a algo accionable.
  const revisados: DoctorRevisado[] = elegidos.map((d, i) => {
    const suyo = agenda[i];
    const tapado = suyo.ocupado.length === 1
      && suyo.ocupado[0].desde.getTime() === desde.getTime()
      && suyo.ocupado[0].hasta.getTime() === hasta.getTime();
    return {
      nombre: d.nombre,
      calendario: d.calendario,
      permiso: tapado ? 'sin_acceso' : 'ok',
      ocupado: tapado ? 0 : suyo.ocupado.length,
      dias: LETRAS.filter((_, dia) => (d.horario as any)[dia]?.length > 0).join(''),
      hace: d.hace
    };
  });

  for (const d of revisados) {
    if (d.permiso === 'sin_acceso') {
      problemas.push(
        `${d.nombre}: Google no deja leer su calendario. Falta compartirlo con la cuenta `
        + `de servicio -paso 5- o el ID esta mal copiado: ${d.calendario}`
      );
    }
  }

  const sinFiltrar = huecosDisponibles({
    doctores: agenda,
    zona,
    desde,
    hasta,
    duracionMin: duracion,
    margenMin: margen,
    maximo: 5,
    ahora
  });

  // LO CRUDO SE APUNTA ANTES DE FILTRAR. Si salen huecos aquí y cero abajo, el problema son
  // los días cerrados; si salen cero aquí, es el horario o la ocupación. Son dos sitios
  // distintos y sin este número no se distinguen.
  usando.huecos_sin_filtrar = sinFiltrar.length;
  const cuandoTexto = (f: Date) => new Intl.DateTimeFormat('es', {
    timeZone: zona, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(f);
  usando.ventana = `${cuandoTexto(desde)}  ->  ${cuandoTexto(hasta)}`;

  const huecos = sinFiltrar
    // Los cierres NO los conoce el buscador de huecos: son de la clínica entera y se
    // aplican aquí, igual que los aplicará quien reserve.
    .filter(h => !estaCerrado(cierres, diaLocal(h.inicio, zona)))
    .map(h => ({
      cuando: new Intl.DateTimeFormat('es', {
        timeZone: zona, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      }).format(h.inicio),
      doctor: h.doctor_nombre
    }));

  if (huecos.length === 0 && problemas.length === 0) {
    // TODO CORRECTO Y CERO HUECOS ES SOSPECHOSO, y merece decirlo en vez de dar un OK que
    // parece bueno: o la clínica está llena de verdad, o el horario está mal puesto.
    problemas.push(
      'No hay ningun hueco en los proximos dias. Revisa el horario de la clinica y el de '
      + 'cada doctor: con todo bien configurado deberia salir alguno.'
    );
  }

  return { ok: problemas.length === 0, problemas, zona, doctores: revisados, cierres, huecos, usando };
}

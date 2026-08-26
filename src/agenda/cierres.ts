/**
 * Los días que la clínica no abre: festivos, vacaciones, un puente.
 *
 * POR QUE ESTO NO SE DEJA EN EL CALENDARIO DE CADA DOCTOR. Un cierre de la clínica lo son
 * TODOS a la vez, y confiarlo a que cuatro personas se acuerden de bloquear su agenda es
 * garantizar que uno se olvide. Y el que se olvide seguirá dando citas para el 25 de
 * diciembre con la puerta cerrada.
 *
 * Se escribe como se dice, una línea por cierre:
 *
 *     25/12/2026            Navidad
 *     01/01/2027            Año nuevo
 *     15/08/2026 - 22/08/2026   vacaciones
 *
 * Lo que va detrás de la fecha es para quien lo lee: no se usa para nada, pero sin ello
 * nadie sabe dentro de seis meses por qué está cerrado ese jueves suelto.
 */

const MAX_CIERRES = 60;
const MAX_LARGO = 2000;

export interface Cierre {
  /** El primer día cerrado, en formato aaaa-mm-dd. */
  desde: string;
  /** El último día cerrado, incluido. Igual que `desde` si es un solo día. */
  hasta: string;
  motivo: string;
}

/** «25/12/2026» -> «2026-12-25». Null si no es una fecha real. */
function fechaDe(texto: string): string | null {
  const m = String(texto).trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const anio = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;

  // SE COMPRUEBA QUE LA FECHA EXISTA DE VERDAD. «31/02/2026» pasa el filtro de arriba y
  // JavaScript lo convertiría alegremente en el 3 de marzo: la clínica creería tener
  // cerrado un día de febrero y estaría cerrando uno de marzo.
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCDate() !== dia || d.getUTCMonth() !== mes - 1) return null;

  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * Lee la lista de cierres.
 *
 * Devuelve null si algo no se entiende, y entonces no se guarda nada: media lista de
 * festivos es peor que ninguna, porque la clínica cree tenerlos puestos.
 */
export function leerCierres(texto: unknown): Cierre[] | null {
  const bruto = String(texto ?? '');
  if (!bruto.trim()) return null;
  if (bruto.length > MAX_LARGO) return null;

  const lineas = bruto.split('\n').map(l => l.trim()).filter(Boolean);
  if (lineas.length === 0 || lineas.length > MAX_CIERRES) return null;

  const cierres: Cierre[] = [];
  for (const linea of lineas) {
    // «25/12/2026 Navidad» o «15/08/2026 - 22/08/2026 vacaciones».
    const m = linea.match(/^(\d{1,2}[/-]\d{1,2}[/-]\d{4})(?:\s*-\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4}))?\s*(.*)$/);
    if (!m) return null;

    const desde = fechaDe(m[1]);
    if (!desde) return null;
    const hasta = m[2] ? fechaDe(m[2]) : desde;
    if (!hasta || hasta < desde) return null;

    cierres.push({ desde, hasta, motivo: (m[3] ?? '').trim().slice(0, 80) });
  }

  return cierres;
}

/** ¿Está cerrada la clínica ese día? `dia` en formato aaaa-mm-dd. */
export function estaCerrado(cierres: Cierre[], dia: string): boolean {
  return (cierres ?? []).some(c => dia >= c.desde && dia <= c.hasta);
}

export const LIMITES_DE_CIERRES = { cierres: MAX_CIERRES, caracteres: MAX_LARGO };

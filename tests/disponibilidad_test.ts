/**
 * Qué se le promete al paciente cuando su conversación pasa a una persona.
 *
 * EL FALLO: el mensaje decía «una persona continuará con usted por aquí mismo» a
 * cualquier hora. A las once de la noche eso es una promesa que nadie va a
 * cumplir: el paciente espera a alguien que no está, y la clínica queda mal por
 * una atención inmediata que en realidad nunca prometió.
 *
 * Lo que se protege:
 *  1. Que fuera de horario se diga CUÁNDO, no «lo antes posible».
 *  2. Que el día se nombre bien: hoy, mañana, o el nombre del día. Decir «mañana»
 *     cuando faltan tres días es peor que no decir nada.
 *  3. Que un horario roto o vacío no invente una fecha ni deje el mensaje sin
 *     coletilla útil.
 *  4. Que se salte el hueco de la comida: una clínica con dos tramos al día tiene
 *     una franja cerrada EN MEDIO, y ahí la próxima apertura es por la tarde del
 *     mismo día, no al día siguiente.
 */

import assert from 'node:assert/strict';
import { fraseDeDisponibilidad, proximaApertura } from '../src/handoff/disponibilidad.js';
import type { HorarioClinica } from '../src/leads/policy.js';

const ZONA = 'Europe/Madrid';

// Lunes a viernes 10:00-20:00, sábado 10:00-15:00, domingo cerrado.
const HORARIO: HorarioClinica = {
  0: [],
  1: [{ desde: 600, hasta: 1200 }],
  2: [{ desde: 600, hasta: 1200 }],
  3: [{ desde: 600, hasta: 1200 }],
  4: [{ desde: 600, hasta: 1200 }],
  5: [{ desde: 600, hasta: 1200 }],
  6: [{ desde: 600, hasta: 900 }]
};

// Con hueco de comida, para el caso 4.
const CON_COMIDA: HorarioClinica = {
  0: [], 6: [],
  1: [{ desde: 600, hasta: 840 }, { desde: 960, hasta: 1200 }],
  2: [{ desde: 600, hasta: 840 }, { desde: 960, hasta: 1200 }],
  3: [{ desde: 600, hasta: 840 }, { desde: 960, hasta: 1200 }],
  4: [{ desde: 600, hasta: 840 }, { desde: 960, hasta: 1200 }],
  5: [{ desde: 600, hasta: 840 }, { desde: 960, hasta: 1200 }]
};

/** Un instante en hora de Madrid. Agosto es verano: UTC+2. */
const madrid = (iso: string) => new Date(`${iso}+02:00`);

// --- Dentro de horario: no se da un plazo que no se conoce ------------------

{
  // Martes 18 de agosto de 2026, 12:00 en Madrid.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T12:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/atendiendo ahora/.test(frase), frase);
  assert.ok(!/a partir de las/.test(frase), 'abierta no debe dar una hora futura');
}

// --- Fuera de horario: se dice cuándo ---------------------------------------

{
  // Martes 23:00 -> abre mañana miércoles a las 10:00.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T23:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/fuera del horario/.test(frase), frase);
  assert.ok(/mañana a partir de las 10:00/.test(frase), frase);
}

{
  // Martes 08:00, antes de abrir -> HOY a las 10:00. No «mañana».
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T08:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/hoy a partir de las 10:00/.test(frase), frase);
}

{
  // Sábado 16:00, ya cerrado, y el domingo cierra -> el LUNES. Ni hoy ni mañana.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-22T16:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/el lunes a partir de las 10:00/.test(frase), frase);
  assert.ok(!/mañana/.test(frase), 'el domingo está cerrado: decir «mañana» sería mentir');
}

{
  // Domingo por la mañana -> mañana lunes.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-23T09:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/mañana a partir de las 10:00/.test(frase), frase);
}

// --- El hueco de la comida ---------------------------------------------------

{
  // Martes 15:00, entre los dos tramos -> reabre HOY a las 16:00.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T15:00:00'), zona: ZONA, horario: CON_COMIDA });
  assert.ok(/hoy a partir de las 16:00/.test(frase), frase);
}

// --- Horarios imposibles: no se inventa nada --------------------------------

{
  const cerrada: HorarioClinica = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  assert.equal(proximaApertura(madrid('2026-08-18T12:00:00'), ZONA, cerrada), null);
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T12:00:00'), zona: ZONA, horario: cerrada });
  assert.ok(/dentro del horario de atención/.test(frase), frase);
  assert.ok(!/a partir de las/.test(frase), 'sin apertura no se puede dar una hora');
}

// --- La frase nunca sale vacía ----------------------------------------------

{
  // Quien la use concatena sin comprobar nada, así que no puede devolver ''.
  for (const iso of ['2026-08-18T12:00:00', '2026-08-18T23:00:00', '2026-08-23T09:00:00']) {
    for (const h of [HORARIO, CON_COMIDA]) {
      const frase = fraseDeDisponibilidad({ ahora: madrid(iso), zona: ZONA, horario: h });
      assert.ok(frase.length > 20, `${iso}: frase demasiado corta -> "${frase}"`);
    }
  }
}

// --- La hora que se dice es la de apertura, no la del muestreo ---------------

{
  // Este caso salio de un fallo real: buscando a saltos de cuarto de hora desde
  // las 09:51, la primera muestra abierta era las 10:06 y el mensaje decia «a
  // partir de las 10:06». Una hora que no existe en ningun horario.
  for (const minuto of [51, 52, 55, 58, 59]) {
    const frase = fraseDeDisponibilidad({
      ahora: madrid(`2026-08-18T09:${minuto}:00`),
      zona: ZONA,
      horario: HORARIO
    });
    assert.ok(/a partir de las 10:00/.test(frase), `09:${minuto} -> "${frase}"`);
  }
}

{
  // Y con hueco de comida: reabre a las 16:00 en punto, se pregunte a la hora que
  // se pregunte dentro del hueco.
  for (const hora of ['14:01', '14:30', '15:47', '15:59']) {
    const frase = fraseDeDisponibilidad({
      ahora: madrid(`2026-08-18T${hora}:00`),
      zona: ZONA,
      horario: CON_COMIDA
    });
    assert.ok(/a partir de las 16:00/.test(frase), `${hora} -> "${frase}"`);
  }
}

console.log('disponibilidad_test: OK');

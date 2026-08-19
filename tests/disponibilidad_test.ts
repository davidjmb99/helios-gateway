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
  assert.ok(!/se reanuda/.test(frase), 'abierta no debe dar una hora futura');
}

// --- Fuera de horario: se dice cuándo ---------------------------------------

{
  // Martes 23:00 -> abre mañana miércoles a las 10:00.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T23:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/dentro del horario de atención/.test(frase), frase);
  assert.ok(/se reanuda mañana a las 10:00/.test(frase), frase);
  // No puede prometer una respuesta A esa hora: solo decir cuando abre.
  assert.ok(!/le responderá.*a partir de las/.test(frase), 'el horario no es una promesa de respuesta');
}

{
  // Martes 08:00, antes de abrir -> HOY a las 10:00. No «mañana».
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T08:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/se reanuda hoy a las 10:00/.test(frase), frase);
}

{
  // Sábado 16:00, ya cerrado, y el domingo cierra -> el LUNES. Ni hoy ni mañana.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-22T16:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/se reanuda el lunes a las 10:00/.test(frase), frase);
  assert.ok(!/mañana/.test(frase), 'el domingo está cerrado: decir «mañana» sería mentir');
}

{
  // Domingo por la mañana -> mañana lunes.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-23T09:00:00'), zona: ZONA, horario: HORARIO });
  assert.ok(/se reanuda mañana a las 10:00/.test(frase), frase);
}

// --- El hueco de la comida ---------------------------------------------------

{
  // Martes 15:00, entre los dos tramos -> reabre HOY a las 16:00.
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T15:00:00'), zona: ZONA, horario: CON_COMIDA });
  assert.ok(/se reanuda hoy a las 16:00/.test(frase), frase);
}

// --- Horarios imposibles: no se inventa nada --------------------------------

{
  const cerrada: HorarioClinica = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  assert.equal(proximaApertura(madrid('2026-08-18T12:00:00'), ZONA, cerrada), null);
  const frase = fraseDeDisponibilidad({ ahora: madrid('2026-08-18T12:00:00'), zona: ZONA, horario: cerrada });
  assert.ok(/dentro del horario de atención/.test(frase), frase);
  assert.ok(!/se reanuda/.test(frase), 'sin apertura no se puede dar una hora');
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
    assert.ok(/se reanuda hoy a las 10:00/.test(frase), `09:${minuto} -> "${frase}"`);
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
    assert.ok(/se reanuda hoy a las 16:00/.test(frase), `${hora} -> "${frase}"`);
  }
}

// --- El caso que planteo David: nunca nombrar un dia cerrado ---------------

{
  // «Que tal que este escribiendo un sabado ya fuera de horario, esta diciendo que
  // el equipo atendera el domingo y es falso». Con el domingo cerrado, ninguna hora
  // del sabado puede producir «mañana». Se barre el sabado entero tras el cierre.
  for (const hora of ['15:00', '15:01', '16:30', '19:00', '21:30', '23:59']) {
    const frase = fraseDeDisponibilidad({
      ahora: madrid(`2026-08-22T${hora}:00`),
      zona: ZONA,
      horario: HORARIO
    });
    assert.ok(/se reanuda el lunes/.test(frase), `sabado ${hora} -> "${frase}"`);
    assert.ok(!/mañana/.test(frase), `sabado ${hora} NO puede decir mañana -> "${frase}"`);
    assert.ok(!/domingo/.test(frase), `sabado ${hora} NO puede nombrar el domingo -> "${frase}"`);
  }
}

{
  // La propiedad de fondo, para cualquier horario y cualquier instante: el dia que
  // se nombra tiene que ser un dia con franjas. Si algun dia el calculo se rompiera
  // y nombrara un dia cerrado, esto lo caza sin depender de un caso concreto.
  const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  for (const horario of [HORARIO, CON_COMIDA]) {
    for (let dia = 22; dia <= 28; dia += 1) {
      for (const hora of ['00:30', '07:00', '09:00', '13:00', '15:30', '18:00', '21:00', '23:30']) {
        const frase = fraseDeDisponibilidad({
          ahora: madrid(`2026-08-${dia}T${hora}:00`),
          zona: ZONA,
          horario
        });
        const nombrado = DIAS_ES.findIndex(d => frase.includes(`se reanuda el ${d}`));
        if (nombrado >= 0) {
          assert.ok(
            (horario[nombrado] || []).length > 0,
            `2026-08-${dia} ${hora}: nombra "${DIAS_ES[nombrado]}", que esta cerrado -> "${frase}"`
          );
        }
      }
    }
  }
}

console.log('disponibilidad_test: OK');

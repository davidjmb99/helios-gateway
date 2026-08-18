/**
 * Cuándo cierra Helios una conversación por su cuenta.
 *
 * Esto decide si se resuelve la conversación de un paciente sin que nadie lo
 * mire. Un falso positivo le cierra la conversación a alguien que todavía estaba
 * preguntando, y encima le manda una encuesta. Por eso las pruebas se centran más
 * en lo que NO debe cerrar que en lo que sí.
 *
 * Lo que se protege:
 *  1. Que el cierre lo declare Hermes y no se deduzca de nada más -ni de que haya
 *     cita, ni del texto-.
 *  2. Que una persona atendiendo gane siempre.
 *  3. Que una declaración a medias -operación fallida, bandera que no es el
 *     booleano exacto- no cierre nada.
 *  4. Que sin mensaje al paciente no se cierre: no se resuelve una conversación
 *     sin despedirse.
 */

import assert from 'node:assert/strict';
import { decidirCierre, OPERACION_DE_CIERRE } from '../src/csat/cierre.js';

const CIERRE_OK = { type: OPERACION_DE_CIERRE, status: 'success' };
const base = { hayRespuesta: true };

// --- Lo que SÍ cierra --------------------------------------------------------

{
  const d = decidirCierre({ ...base, operation: CIERRE_OK });
  assert.equal(d.cerrar, true, 'operation.type conversation_closed + success debe cerrar');
  assert.equal(d.motivo, 'declarado_por_hermes');
}

{
  // Forma alternativa, por si el esquema del guard no admitiera el operation.type.
  const d = decidirCierre({ ...base, statePatch: { conversation_complete: true } });
  assert.equal(d.cerrar, true, 'state_patch.conversation_complete también debe cerrar');
}

{
  // El cierre no depende de que haya habido cita: «solo quería saber el precio,
  // gracias» también termina. Quien decide si merece encuesta es policy.ts.
  const d = decidirCierre({
    ...base,
    operation: CIERRE_OK,
    statePatch: { pending_question: null }
  });
  assert.equal(d.cerrar, true);
}

// --- Lo que NO cierra: el caso peligroso -------------------------------------

{
  // Una cita agendada NO es un cierre. El paciente sigue ahí y puede preguntar.
  const d = decidirCierre({
    ...base,
    operation: { type: 'appointment_created', status: 'success' }
  });
  assert.equal(d.cerrar, false, 'agendar una cita no cierra la conversación');
  assert.equal(d.motivo, 'sin_declaracion');
}

{
  const d = decidirCierre({ ...base });
  assert.equal(d.cerrar, false, 'sin declaración no se cierra');
  assert.equal(d.motivo, 'sin_declaracion');
}

{
  // Declaración a medias: el tipo correcto pero la operación no fue bien.
  const d = decidirCierre({
    ...base,
    operation: { type: OPERACION_DE_CIERRE, status: 'pending' }
  });
  assert.equal(d.cerrar, false, 'una operación de cierre en pending no cierra');
}

{
  for (const valor of ['true', 1, 'sí', {}, [], 'false', 0, null]) {
    const d = decidirCierre({ ...base, statePatch: { conversation_complete: valor } });
    assert.equal(d.cerrar, false, `conversation_complete=${JSON.stringify(valor)} no debe cerrar`);
  }
}

// --- Lo que NO cierra: manda la persona --------------------------------------

{
  const d = decidirCierre({ ...base, operation: CIERRE_OK, humanoAlMando: true });
  assert.equal(d.cerrar, false, 'si la lleva una persona, Helios no cierra');
  assert.equal(d.motivo, 'humano_al_mando');
}

{
  const d = decidirCierre({ ...base, operation: CIERRE_OK, requiresHandoff: true });
  assert.equal(d.cerrar, false, 'si Hermes pide derivar, no se cierra');
  assert.equal(d.motivo, 'handoff_activo');
}

{
  // Las dos cautelas van antes que la declaración, así que el motivo tiene que ser
  // el humano y no «sin declaración». Si no, el log mentiría sobre por qué.
  const d = decidirCierre({ humanoAlMando: true, hayRespuesta: true });
  assert.equal(d.motivo, 'humano_al_mando');
}

// --- Lo que NO cierra: no hay despedida --------------------------------------

{
  const d = decidirCierre({ operation: CIERRE_OK, hayRespuesta: false });
  assert.equal(d.cerrar, false, 'sin mensaje al paciente no se resuelve nada');
  assert.equal(d.motivo, 'sin_respuesta');
}

{
  // Y esa comprobación gana incluso sobre las cautelas: sin respuesta no hay fila
  // de outbox donde colgar el cierre, así que el resto da igual.
  const d = decidirCierre({ operation: CIERRE_OK, humanoAlMando: true, hayRespuesta: false });
  assert.equal(d.motivo, 'sin_respuesta');
}

console.log('cierre_test: OK');

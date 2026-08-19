/**
 * Vigilar que los pacientes llegan de verdad a HubSpot.
 *
 * EL RIESGO: el acceso a HubSpot se renueva por OAuth y nada vigilaba esa
 * renovación. El día que falle, Helios sigue contestando con normalidad, el
 * paciente recibe su respuesta, la conversación parece perfecta — y la clínica se
 * queda sin la ficha. Nadie se enteraría hasta buscar un contacto que no está.
 *
 * Lo que se protege:
 *  1. Que se mire el RESULTADO y no lo que declare el modelo. Si la identidad está
 *     completa y no hay identificador de CRM, ese paciente no tiene ficha, se
 *     cuente lo que se cuente.
 *  2. Que un turno normal NO dispare la alarma: el alta ocurre legítimamente un
 *     turno después de recoger la identidad.
 *  3. Que la racha se corte en cuanto uno funciona. Un aviso que no se calla deja
 *     de leerse.
 *  4. Que la racha sea POR CLÍNICA: un token caducado afecta a una y no a las
 *     demás, y un contador global esconde a la afectada.
 */

import assert from 'node:assert/strict';
import {
  evaluarTurnoDeCrm,
  registrarTurnoDeCrm,
  limpiarVigilanciaDeCrm,
  crmMetrics,
  RACHA_PARA_AVISAR
} from '../src/services/crm-watch.js';
import { componentHealth } from '../src/services/component-health.js';

const SIN_CRM = { identidadCompleta: true, crmContactId: null };
const CON_CRM = { identidadCompleta: true, crmContactId: '242798218668' };

// --- Qué informa y qué no ----------------------------------------------------

{
  assert.equal(evaluarTurnoDeCrm(CON_CRM), 'sincronizado');
  assert.equal(evaluarTurnoDeCrm(SIN_CRM), 'sin_sincronizar');
}

{
  // Sin identidad completa no hay nada que dar de alta: el turno no dice nada.
  assert.equal(
    evaluarTurnoDeCrm({ identidadCompleta: false, crmContactId: null }),
    'no_aplica',
    'un paciente sin identidad todavía no debe estar en el CRM'
  );
}

{
  // Un identificador vacío o de relleno NO cuenta como sincronizado. Si contara,
  // una cadena vacía guardada por error apagaría la vigilancia para siempre.
  for (const basura of ['', '   ', null, undefined, 0, false, {}]) {
    assert.equal(
      evaluarTurnoDeCrm({ identidadCompleta: true, crmContactId: basura }),
      'sin_sincronizar',
      `crmContactId=${JSON.stringify(basura)} no es una ficha de CRM`
    );
  }
}

{
  // El caso más grave: una operación de HubSpot que dice haber ido bien y no deja
  // identificador. Se creyó dar de alta a alguien que no está.
  assert.equal(
    evaluarTurnoDeCrm({
      identidadCompleta: true,
      crmContactId: null,
      tipoDeOperacion: 'hubspot_contact_created'
    }),
    'sin_sincronizar'
  );
}

{
  // Y el mismo turno CON identificador es un éxito, aunque la operación sea de
  // HubSpot: lo que decide es el dato, no el nombre de la operación.
  assert.equal(
    evaluarTurnoDeCrm({
      identidadCompleta: true,
      crmContactId: '242798218668',
      tipoDeOperacion: 'hubspot_contact_created'
    }),
    'sincronizado'
  );
}

// --- La racha: ni ruido ni silencio -----------------------------------------

{
  limpiarVigilanciaDeCrm();
  // Un fallo suelto no avisa: el alta legítimamente llega un turno después.
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  assert.equal(crmMetrics.rachas_avisadas, 0, 'un turno sin CRM no es una alarma');
}

{
  limpiarVigilanciaDeCrm();
  for (let i = 0; i < RACHA_PARA_AVISAR - 1; i += 1) {
    registrarTurnoDeCrm('democoi1', SIN_CRM);
  }
  assert.equal(crmMetrics.rachas_avisadas, 0, `con ${RACHA_PARA_AVISAR - 1} seguidos todavía no`);
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  assert.equal(crmMetrics.rachas_avisadas, 1, `con ${RACHA_PARA_AVISAR} seguidos sí`);
  assert.equal(componentHealth.crm.state, 'DEGRADED', 'y se ve en el estado del panel');
}

{
  limpiarVigilanciaDeCrm();
  // La racha se corta con uno bueno. Si no se cortara, el aviso saltaría para
  // siempre después del primer mal día y dejaría de significar algo.
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  registrarTurnoDeCrm('democoi1', CON_CRM);
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  assert.equal(crmMetrics.rachas_avisadas, 0, 'dos, uno bueno y dos no son tres seguidos');
  // Y el estado sigue en OK: hubo un paciente que SI llego al CRM y despues no se
  // ha confirmado ninguna racha. Marcarlo degradado aqui seria alarmismo.
  assert.equal(componentHealth.crm.state, 'OK', 'sin racha confirmada no se degrada');
}

{
  limpiarVigilanciaDeCrm();
  // Un turno que no aplica NO rompe la racha ni la alimenta: es neutro.
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  registrarTurnoDeCrm('democoi1', { identidadCompleta: false, crmContactId: null });
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  registrarTurnoDeCrm('democoi1', SIN_CRM);
  assert.equal(crmMetrics.rachas_avisadas, 1, 'los turnos neutros no interrumpen la racha');
}

// --- Multiclínica: la racha es de cada una ----------------------------------

{
  limpiarVigilanciaDeCrm();
  // Dos clínicas alternándose. Si el contador fuera global, esto avisaría a la
  // tercera y señalaría a una clínica que funciona perfectamente.
  for (let i = 0; i < 4; i += 1) {
    registrarTurnoDeCrm('democoi1', SIN_CRM);
    registrarTurnoDeCrm('otraclinica', CON_CRM);
  }
  assert.equal(crmMetrics.rachas_avisadas > 0, true, 'la clínica afectada sí avisa');
  assert.equal(
    crmMetrics.ultima_racha?.tenant_id,
    'democoi1',
    'y el aviso nombra a la clínica correcta, no a la que funciona'
  );
}

{
  limpiarVigilanciaDeCrm();
  // Vigilar no puede tumbar un turno: se le pasa basura y no lanza.
  for (const basura of [null, undefined, {}, { identidadCompleta: 'sí' }]) {
    registrarTurnoDeCrm('democoi1', basura as any);
  }
}

console.log('crm_watch_test: OK');

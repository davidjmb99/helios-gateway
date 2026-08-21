/**
 * El botón de «empezar esta conversación de cero».
 *
 * POR QUE EXISTE: el historial contamina y lo comprobamos a lo largo del 20 de agosto
 * de 2026. Helios tuteaba en una conversacion vieja y trataba de usted en una nueva,
 * con el mismo prompt y en el mismo minuto. Repetia una direccion de Madrid leyendola
 * de sus propios mensajes de hacia un mes. Se negaba a dar la direccion porque en
 * cuatro turnos anteriores se habia negado. Casi todas las pruebas de esa tarde
 * salieron contaminadas, y empezar de cero eran tres comandos y un reinicio.
 *
 * Lo que se protege, por orden de daño si falla:
 *  1. EL AISLAMIENTO. Sin filtrar por tenant_id, un conversation_id repetido entre dos
 *     clinicas reiniciaria la conversacion de un paciente de otra clinica.
 *  2. Que NO se prometa efecto inmediato. Surte efecto en el proximo mensaje, y el
 *     mensaje tiene que decirlo. El panel ya nos hizo una vez la de responder «hecho»
 *     sin haber hecho nada.
 *  3. Que sin sesion se diga la verdad en vez de fingir que se hizo algo.
 *  4. QUE EL PANEL MANDE EL TOKEN. Es la tercera vez que una pieza de interfaz sale
 *     rota por esto: checkAuth la rechaza con 401 y solo se ve el mensaje de error.
 */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';

const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const { pedirEmpezarDeCero } = await import('../src/conversaciones/empezar-de-cero.js');

const CLAVE_COI = 'tenant:democoi1:profile:helios:conversation:75:contact:c1';
const CLAVE_OTRA = 'tenant:fisio7:profile:fisio:conversation:75:contact:c9';

function montar() {
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  db.seed('helios_hermes_sessions', [
    {
      session_key: CLAVE_COI, tenant_id: 'democoi1', hermes_profile: 'helios',
      conversation_id: '75', contact_id: 'c1',
      generacion: 0, turnos: 15, ultimo_input_tokens: 42274,
      updated_at: new Date().toISOString(), reset_pedido_at: null, reset_pedido_por: null
    },
    {
      // MISMO conversation_id, OTRA clinica. Es el caso que revienta si falta el filtro.
      session_key: CLAVE_OTRA, tenant_id: 'fisio7', hermes_profile: 'fisio',
      conversation_id: '75', contact_id: 'c9',
      generacion: 3, turnos: 4, ultimo_input_tokens: 8000,
      updated_at: new Date().toISOString(), reset_pedido_at: null, reset_pedido_por: null
    }
  ]);
  __setSupabaseClientForTests(db as any);
  return db;
}

// --- Se marca la peticion, y solo la de esta clinica ------------------------

{
  const db = montar();
  const r = await pedirEmpezarDeCero({ tenantId: 'democoi1', conversationId: '75', pedidoPor: 'david' });

  assert.equal(r.habia_sesion, true);
  assert.equal(r.turnos_descartados, 15);
  assert.equal(r.generacion_actual, 0);

  const filas: any[] = (db as any).table('helios_hermes_sessions');
  const coi = filas.find(f => f.session_key === CLAVE_COI);
  const otra = filas.find(f => f.session_key === CLAVE_OTRA);

  assert.ok(coi.reset_pedido_at, 'la sesion de COI queda marcada');
  assert.equal(coi.reset_pedido_por, 'david');
  assert.equal(
    otra.reset_pedido_at, null,
    'EL AISLAMIENTO: la otra clinica tiene el MISMO conversation_id y no puede tocarse'
  );
}

// --- No se promete efecto inmediato ----------------------------------------

{
  montar();
  const r = await pedirEmpezarDeCero({ tenantId: 'democoi1', conversationId: '75' });
  assert.ok(
    /pr[oó]ximo mensaje/i.test(r.mensaje),
    'el mensaje tiene que decir que surte efecto en el proximo mensaje, no ahora: ' + r.mensaje
  );
  assert.ok(
    /nombre|correo|cita/i.test(r.mensaje),
    'y tranquilizar sobre lo que NO se pierde, que es la duda inmediata de cualquiera: ' + r.mensaje
  );
  assert.ok(/15/.test(r.mensaje), 'y decir cuanto historial se descarta: ' + r.mensaje);
}

// --- Sin sesion se dice la verdad ------------------------------------------

{
  montar();
  const r = await pedirEmpezarDeCero({ tenantId: 'democoi1', conversationId: '999' });
  assert.equal(r.habia_sesion, false);
  assert.equal(r.turnos_descartados, null);
  assert.ok(
    /ya empieza de cero|todav[ií]a no tiene/i.test(r.mensaje),
    'sin sesion no se finge que se hizo algo: ' + r.mensaje
  );
}

// --- Un turno, en singular -------------------------------------------------

{
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  db.seed('helios_hermes_sessions', [{
    session_key: CLAVE_COI, tenant_id: 'democoi1', hermes_profile: 'helios',
    conversation_id: '75', contact_id: 'c1', generacion: 0, turnos: 1,
    ultimo_input_tokens: 900, updated_at: new Date().toISOString()
  }]);
  __setSupabaseClientForTests(db as any);
  const r = await pedirEmpezarDeCero({ tenantId: 'democoi1', conversationId: '75' });
  assert.ok(/1 turno\b/.test(r.mensaje), 'un solo turno se dice en singular: ' + r.mensaje);
}

// --- QUE EL PANEL MANDE EL TOKEN -------------------------------------------
//
// Tercera vez que se protege esto. El 19 de agosto el semaforo no aparecio en NINGUNA
// conversacion porque las dos llamadas del panel iban sin Authorization, checkAuth las
// rechazaba con 401 y solo salia la rama de error. Un test que lea la fuente no
// sustituye a abrir un navegador, pero impide desplegarlo roto.

{
  const panel = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  const i = panel.indexOf("'/admin/conversation-reset'");
  assert.ok(i > 0, 'el panel no llama a /admin/conversation-reset');
  const llamada = panel.slice(i, i + 420);
  assert.ok(
    /Authorization/.test(llamada) && /getSessionToken\(\)/.test(llamada),
    'la llamada a /admin/conversation-reset va sin el token de sesion y checkAuth la rechazara con 401'
  );
  assert.ok(/method:\s*'POST'/.test(llamada), 'tiene que ser POST');

  // Y QUE PREGUNTE ANTES. Perder el hilo de una conversacion de un paciente real no
  // puede ser un clic descuidado en la misma caja que los botones de modo.
  const bloque = panel.slice(panel.indexOf('async function empezarConversacionDeCero'), i);
  assert.ok(/confirm\(/.test(bloque), 'empezar de cero tiene que pedir confirmacion');
  assert.ok(
    /NO olvida/.test(bloque),
    'la confirmacion tiene que aclarar que no se pierden el nombre ni la cita'
  );
}

console.log('empezar_de_cero_test: OK');

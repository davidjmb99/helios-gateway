import { readFileSync } from 'node:fs';
/**
 * Quién atiende una conversación, y qué hace el botón del panel.
 *
 * ESTO EXISTE PORQUE EL PANEL MENTÍA. Los endpoints viejos de pausar y reactivar
 * la IA movían `human_handoff_active`, que es un booleano DERIVADO, y dejaban
 * `stage` como estaba. Respondían «IA reactivada correctamente» y Helios seguía
 * sin contestar, porque el gate mira el stage. Y de paso escribían
 * contact_id: 'unknown' encima del real: getRefined() lleva un fallback escrito
 * literalmente «para saltar filas unknown corruptas», así que ya pasó.
 *
 * Lo que se protege:
 *  1. Que el stage humano GANE sobre ai_enabled. Una conversación derivada no es
 *     «Helios atendiendo» aunque la bandera esté encendida.
 *  2. Que existan los TRES estados. Pausada y con-una-persona no son lo mismo:
 *     en la pausada no hay nadie asignado y nadie va a contestar.
 *  3. Que pedir un modo en el que ya estás no escriba nada.
 *  4. Que devolver una conversación derivada use el camino canónico, no la
 *     bandera.
 */

import assert from 'node:assert/strict';
import { describirModo, accionPara } from '../src/handoff/modo.js';

// --- Los tres estados --------------------------------------------------------

{
  const m = describirModo({ stage: 'bot_active', ai_enabled: true });
  assert.equal(m.modo, 'helios');
  assert.equal(m.etiqueta, 'Helios atendiendo');
}

{
  const m = describirModo({ stage: 'bot_active', ai_enabled: false });
  assert.equal(m.modo, 'pausada', 'apagar la IA sin derivar es un estado propio');
  assert.ok(/NADIE/.test(m.consecuencia), 'hay que decir que nadie va a contestar');
}

{
  for (const stage of ['handoff_requested', 'human_queue', 'human_active', 'waiting_patient', 'return_requested']) {
    assert.equal(describirModo({ stage, ai_enabled: true }).modo, 'persona', stage);
  }
}

// --- El stage humano gana sobre la bandera -----------------------------------

{
  // El fallo original, en una línea: la bandera decía que la IA estaba encendida
  // y el panel lo mostraba como «Helios atendiendo». No lo era.
  const m = describirModo({ stage: 'human_active', ai_enabled: true });
  assert.equal(m.modo, 'persona', 'derivada con la IA encendida sigue siendo de la persona');
}

{
  // 'closed' NO es de la persona: si el paciente vuelve a escribir, Helios atiende.
  assert.equal(describirModo({ stage: 'closed', ai_enabled: true }).modo, 'helios');
}

// --- Filas viejas y filas raras ----------------------------------------------

{
  // Sin columna stage se traduce el booleano legacy.
  assert.equal(describirModo({ human_handoff_active: true }).modo, 'persona');
  assert.equal(describirModo({ human_handoff_active: false }).modo, 'helios');
}

{
  // Un stage inventado no puede dejar a un paciente en el limbo: cae a bot.
  assert.equal(describirModo({ stage: 'inventado', ai_enabled: true }).modo, 'helios');
}

{
  // Sin fila -conversación que no ha pasado por el gate- el defecto es atender.
  assert.equal(describirModo(null).modo, 'helios');
  assert.equal(describirModo(undefined).ai_enabled, true);
}

{
  // Solo un false EXPLÍCITO apaga. null y ausente significan encendida, igual que
  // en el orquestador; si no coincidieran, el panel diría lo contrario del gate.
  assert.equal(describirModo({ stage: 'bot_active', ai_enabled: null }).modo, 'helios');
  assert.equal(describirModo({ stage: 'bot_active' }).modo, 'helios');
}

// --- Qué hace el botón -------------------------------------------------------

{
  assert.equal(accionPara('persona', 'helios'), 'devolver_a_helios',
    'una derivada necesita el camino canónico, no la bandera');
  assert.equal(accionPara('pausada', 'helios'), 'encender_ia');
  assert.equal(accionPara('helios', 'pausada'), 'pausar_ia');
}

{
  // Pedir el modo en el que ya estás no escribe. Repetir la acción sobre una
  // conversación derivada podría limpiar un handoff que alguien está atendiendo.
  assert.equal(accionPara('helios', 'helios'), 'nada');
  assert.equal(accionPara('pausada', 'pausada'), 'nada');
}

{
  // Pausar una conversación que ya lleva una persona NO se acepta: Helios ya no
  // la atiende, y apagar la bandera daría la falsa sensación de haber hecho algo.
  assert.equal(accionPara('persona', 'pausada'), 'nada');
}

// --- Que el panel LLAME al endpoint como es debido -------------------------
//
// EL FALLO, del 19-ago-2026: el semaforo no aparecio en NINGUNA conversacion. Las
// dos peticiones del panel a /admin/conversation-mode no mandaban el token de
// sesion, y todas las demas del panel si. checkAuth las rechazaba con 401 y solo
// salia «No se pudo consultar quien atiende», que es la rama de error.
//
// Es la segunda vez que una pieza de interfaz sale rota por no abrirla en un
// navegador. Un test que lea la fuente no sustituye a mirarla, pero al menos
// impide que se despliegue sin token.

{
  const panel = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  const llamadas = [...panel.matchAll(/fetch\(\s*(?:url|'\/admin\/conversation-mode')[\s\S]{0,320}?\)/g)]
    .map(m => m[0]);
  assert.ok(
    llamadas.length >= 2,
    'no se encuentran las dos llamadas del panel a /admin/conversation-mode'
  );
  for (const llamada of llamadas) {
    assert.ok(
      /Authorization/.test(llamada) && /getSessionToken\(\)/.test(llamada),
      'una llamada a /admin/conversation-mode va sin el token de sesion, y checkAuth '
      + 'la rechazara con 401: ' + llamada.slice(0, 120)
    );
  }
}

console.log('modo_conversacion_test: OK');

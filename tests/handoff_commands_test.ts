import assert from 'node:assert/strict';
import { RETURN_TO_BOT_COMMAND, detectCommand } from '../src/handoff/commands.js';

assert.equal(RETURN_TO_BOT_COMMAND, '/fin');

// --- Lo que SÍ es el comando -----------------------------------------------

assert.equal(detectCommand('/fin'), 'return_to_bot');
assert.equal(detectCommand('  /fin  '), 'return_to_bot', 'los espaldos alrededor no importan');
assert.equal(detectCommand('/FIN'), 'return_to_bot', 'sin distinguir mayúsculas');
assert.equal(detectCommand('/Fin'), 'return_to_bot');
assert.equal(detectCommand('/fin\n'), 'return_to_bot', 'un salto de línea final no lo invalida');
assert.equal(
  detectCommand('/fin​'),
  'return_to_bot',
  'WhatsApp y Chatwoot cuelan caracteres invisibles al pegar'
);
assert.equal(detectCommand(' /fin '), 'return_to_bot', 'espacio duro alrededor');

// --- Lo que NO es el comando ------------------------------------------------
// Aquí la detección es estricta a propósito. Un falso positivo devolvería al bot
// una conversación que una persona está atendiendo, en silencio.

assert.equal(detectCommand('fin'), null, 'sin la barra no es un comando');
assert.equal(detectCommand('/fin gracias'), null, 'el comando va solo, sin más texto');
assert.equal(detectCommand('gracias /fin'), null);
assert.equal(detectCommand('/finalizar'), null);
assert.equal(detectCommand('/finiquito'), null);
assert.equal(
  detectCommand('¿me puedes decir cuándo es el fin de semana?'),
  null,
  'la palabra fin en una frase normal no puede disparar nada'
);
assert.equal(detectCommand('creo que es el /fin de la conversación'), null);
assert.equal(detectCommand('//fin'), null);
assert.equal(detectCommand('/ fin'), null, 'con espacio en medio no es el comando');

// --- Entradas degeneradas ---------------------------------------------------

assert.equal(detectCommand(''), null);
assert.equal(detectCommand('   '), null);
assert.equal(detectCommand(null), null);
assert.equal(detectCommand(undefined), null);
assert.equal(detectCommand(0), null);
assert.equal(detectCommand({}), null);
assert.equal(detectCommand([]), null);

console.log('handoff_commands_test: PASS');

/**
 * Contraseñas del panel.
 *
 * Lo que se protege: que una contraseña correcta siga entrando durante la
 * migración —nadie puede quedarse fuera— y que una incorrecta no entre por
 * ninguna de las dos ramas.
 */

import assert from 'node:assert/strict';

const { cifrarContrasena, esHashSeguro, verificarContrasena } =
  await import('../src/admin/passwords.js');

// --- Cifrado -----------------------------------------------------------------

const clave = 'una-contrasena-de-clinica';
const hash = cifrarContrasena(clave);

assert.equal(esHashSeguro(hash), true, 'el valor cifrado se reconoce como tal');
assert.ok(!hash.includes(clave), 'LA CONTRASEÑA NO APARECE EN EL VALOR GUARDADO');
assert.equal(hash.split('$').length, 3, 'formato etiqueta$sal$derivada');

assert.equal(verificarContrasena(clave, hash), true, 'la correcta entra');
assert.equal(verificarContrasena('otra-cosa', hash), false, 'la incorrecta no');
assert.equal(verificarContrasena('', hash), false, 'vacía no');

// Cada cifrado usa una sal distinta: dos clínicas con la MISMA contraseña no
// deben tener el mismo valor guardado, o una filtración las delataría a las dos.
assert.notEqual(cifrarContrasena(clave), cifrarContrasena(clave), 'sal aleatoria');
assert.equal(verificarContrasena(clave, cifrarContrasena(clave)), true);

// --- La herencia: valores en claro -------------------------------------------
// Hasta el 15-08-2026 se guardaban sin cifrar. Durante la migración tienen que
// seguir funcionando, o el operador se queda fuera de su propio panel.

assert.equal(esHashSeguro('miclaveenclaro'), false, 'un valor en claro se detecta');
assert.equal(
  verificarContrasena('miclaveenclaro', 'miclaveenclaro'),
  true,
  'la contraseña heredada sigue entrando: NADIE se queda fuera'
);
assert.equal(
  verificarContrasena('otra', 'miclaveenclaro'),
  false,
  'pero una incorrecta tampoco entra por la rama heredada'
);
assert.equal(
  verificarContrasena('miclaveenclar', 'miclaveenclaro'),
  false,
  'ni una que sea prefijo de la buena'
);

// --- Casos límite ------------------------------------------------------------

assert.equal(verificarContrasena('algo', null), false);
assert.equal(verificarContrasena('algo', ''), false);
assert.equal(verificarContrasena('algo', undefined), false);
assert.equal(verificarContrasena('algo', 'scrypt$roto'), false, 'un hash mal formado no entra');
assert.equal(verificarContrasena('algo', 'scrypt$$'), false);
assert.equal(esHashSeguro(null), false);

console.log('passwords_test: PASS');

/**
 * ¿Parsea el JavaScript del panel?
 *
 * ESTA PRUEBA NACE DE HABER TIRADO EL PANEL EN PRODUCCION. La noche del 21 de agosto
 * de 2026, al añadir el botón de «empezar esta conversación de cero», un `\n` escrito
 * a mano acabó convertido en un SALTO DE LINEA REAL dentro de una cadena de comillas
 * simples:
 *
 *     + 'proximo mensaje del paciente.
 *
 *     '
 *
 * En JavaScript eso no es un error pequeño y local: el navegador no puede parsear el
 * bloque <script> ENTERO, así que no se ejecuta NADA. David no podía ni iniciar
 * sesión. El síntoma —«no me quiere agarrar el usuario y contraseña»— no se parecía
 * en nada a la causa, y la causa era una comilla mal cerrada a mil doscientas líneas
 * de distancia del formulario de login.
 *
 * Y LO QUE HAY QUE ENTENDER ES POR QUE PASO LA SUITE. Hay varias pruebas que miran
 * este archivo —que las llamadas lleven el token, que existan los botones, que el
 * inspector conserve la pestaña— y TODAS lo leen como TEXTO y le aplican expresiones
 * regulares. Ninguna lo trataba como código. Un archivo sintácticamente roto pasaba
 * todas: los `grep` encontraban lo que buscaban.
 *
 * Así que esta prueba no comprueba ninguna funcionalidad. Comprueba que el archivo ES
 * JAVASCRIPT, que es la condición para que cualquier otra cosa del panel signifique
 * algo.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// --- Cada bloque <script> del panel tiene que compilar ----------------------

const bloques = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .filter(fuente => fuente.trim().length > 0);

assert.ok(
  bloques.length > 0,
  'no se encuentra ningún <script> con código en el panel: o cambió la estructura del '
  + 'archivo o esta prueba dejó de mirar donde debía, y en los dos casos hay que arreglarla'
);

for (const [i, fuente] of bloques.entries()) {
  try {
    // new vm.Script COMPILA sin ejecutar: detecta el error de sintaxis sin necesitar
    // un navegador, un document ni una red. Es exactamente la comprobación que hace
    // el navegador antes de correr una sola línea.
    new vm.Script(fuente, { filename: `panel-script-${i}.js` });
  } catch (error: any) {
    // El mensaje tiene que llevar el trozo de código, porque el fallo de esa noche
    // era invisible en el diff: una cadena partida por un salto de línea se lee como
    // texto normal.
    const linea = Number(String(error?.stack || '').match(/panel-script-\d+\.js:(\d+)/)?.[1] || 0);
    const contexto = fuente.split('\n').slice(Math.max(0, linea - 3), linea + 2).join('\n');
    assert.fail(
      `EL SCRIPT ${i} DEL PANEL NO PARSEA. El navegador no ejecutaria NADA de la pagina, `
      + `ni el formulario de login.\n\n${error.message}\n\nAlrededor de la linea ${linea}:\n${contexto}`
    );
  }
}

// NO SE AÑADE UNA HEURISTICA DE COMILLAS. Lo intente: contar comillas simples por
// linea y avisar si eran impares. Da falsos positivos inmediatos —`.replaceAll("'",
// '&#039;')` lleva una comilla simple dentro de comillas dobles— y una prueba que
// grita cuando no pasa nada se acaba desactivando, que es peor que no tenerla.
//
// El compilador ya caza el caso exacto que nos mordio, y sin adivinar.

console.log(`panel_sintaxis_test: OK (${bloques.length} bloque(s) de script compilan)`);

// --- LOS CAMPOS DE TEXTO LIBRE REGISTRAN EL CAMBIO AL ESCRIBIR -------------
//
// ESTO LO ENCONTRO DAVID pegando los precios: «no me da la opción para guardar los
// cambios». El textarea tenia el texto dentro y el boton seguia apagado.
//
// LA CAUSA: `onchange` en un textarea NO dispara al escribir ni al pegar, solo AL PERDER
// EL FOCO. Pegas la lista, vas directo al boton, y en ese momento el boton todavia esta
// deshabilitado: el clic no hace nada. El sintoma -«el panel no me deja guardar»- no se
// parece en nada a la causa.
//
// En un campo de una linea se disimula porque uno tabula o hace clic fuera sin darse
// cuenta. En un textarea grande, pegar e ir al boton es exactamente lo que hace todo el
// mundo.
//
// LOS SELECTS, LAS HORAS Y LAS CASILLAS SE QUEDAN EN `onchange`, que para ellos es lo
// correcto: no se escriben, se eligen, y ahi el evento dispara al elegir.

{
  const camposDeTextoLibre = ['clinic_address', 'clinic_services', 'clinic_tone'];

  for (const campo of camposDeTextoLibre) {
    assert.ok(
      html.includes(`oninput="cambiarTexto('${campo}', this.value)"`),
      `${campo} tiene que usar oninput: con onchange, pegar el texto y darle a Guardar no ` +
      `hace nada porque el boton sigue apagado hasta que el campo pierde el foco`
    );
    assert.ok(
      !html.includes(`onchange="cambiarTexto('${campo}', this.value)"`),
      `${campo} no puede quedarse con onchange`
    );
  }

  // Y el que NO debe cambiar: la zona es un desplegable.
  assert.ok(
    html.includes(`onchange="cambiarTexto('clinic_timezone', this.value)"`),
    'la zona es un select y con onchange esta bien: no se escribe, se elige'
  );
}

console.log('panel_sintaxis_test: los campos de texto registran al escribir');

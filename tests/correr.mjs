/**
 * Corre todas las pruebas, encontrandolas solas.
 *
 * POR QUE EXISTE. La lista vivia escrita a mano en el script `test` de package.json, con
 * cincuenta y tres entradas encadenadas por `&&`. Eso traia dos problemas:
 *
 *  1. AÑADIR UNA PRUEBA TOCABA package.json, y el Dockerfile hace `COPY package*.json` y
 *     luego `npm ci`. Cambiar el script -aunque no cambie ni una dependencia- invalida esa
 *     capa y reinstala todo desde cero EN LAS DOS ETAPAS. El 4-sep-2026 eso convirtio tres
 *     despliegues de 45 segundos en tres de siete minutos.
 *
 *  2. Y EL GRAVE: se podia crear una prueba y olvidarse de apuntarla. El fichero existe,
 *     nadie lo ejecuta nunca, y da tranquilidad falsa. UNA PRUEBA QUE NO CORRE ES PEOR QUE
 *     NO TENERLA, porque cuenta como cobertura y no lo es.
 *
 *     NO ERA HIPOTETICO: al escribir esto habia 53 en la lista y 55 en disco. Las dos
 *     huerfanas estaban muertas -una fallaba desde hacia meses y la otra probaba su propia
 *     copia de la logica en vez de importarla-. Nadie se habia enterado.
 *
 * AHORA AÑADIR UNA PRUEBA ES CREAR EL FICHERO. package.json no se vuelve a tocar.
 *
 * SE CORREN TODAS AUNQUE FALLE UNA. Con `&&` la cadena paraba en el primer fallo: arreglas
 * uno, vuelves a esperar tres minutos, aparece el siguiente. Aqui salen todos de una vez.
 *
 * Y EN PROCESOS SEPARADOS, uno detras de otro, igual que antes. Cada prueba pone sus
 * variables de entorno y su Supabase de mentira en el arranque; compartir proceso las
 * haria depender del orden.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';

/**
 * Pruebas que EXISTEN y NO se ejecutan, con el motivo por escrito.
 *
 * NO ES UNA LISTA DE EXCLUSION SILENCIOSA: se imprime en cada ejecucion, a proposito. Una
 * prueba apartada y callada es exactamente el problema que este fichero viene a resolver,
 * solo que con mejor letra. Que moleste hasta que se arregle o se borre.
 */
const EN_CUARENTENA = {
  'test_error_handling.js':
    'FALLA con TENANT_NOT_CONFIGURED. Importa de ./dist/ -o sea que necesita un build- y '
    + 'no monta el contexto de clinica. Lleva roto desde antes de la multitenancy.',
  'test_payload_identity.js':
    'PASA, pero no prueba nada: define su propia copia de buildPatientPayload en vez de '
    + 'importarla del codigo. Protege una copia que ya nadie ejecuta.'
};

function descubrir() {
  const enTests = existsSync('tests') ? readdirSync('tests') : [];
  const encontradas = [];

  for (const f of enTests.sort()) {
    if (/_test\.(ts|js)$/.test(f)) encontradas.push('tests/' + f);
  }
  // Las de la raiz son de antes de que existiera tests/. Se recogen igual: si estan, se
  // ejecutan o se justifican, pero no se ignoran por vivir en otro sitio.
  for (const f of readdirSync('.').sort()) {
    if (/^test_.+\.js$/.test(f)) encontradas.push(f);
  }
  return encontradas;
}

const todas = descubrir();
const cuarentena = todas.filter(f => EN_CUARENTENA[f.replace(/^tests\//, '')]);
const aCorrer = todas.filter(f => !EN_CUARENTENA[f.replace(/^tests\//, '')]);

// UN SUELO, PORQUE UN RUNNER QUE NO ENCUENTRA NADA PASA EN VERDE. Si alguien rompe el
// patron de busqueda, o esto se ejecuta desde otro directorio, la salida seria «las 0
// pasan» y el despliegue seguiria tan tranquilo. Es el mismo fallo que este fichero viene
// a resolver -cobertura que no existe y parece que si- reaparecido un nivel mas arriba.
//
// El numero no es un objetivo: es un detector de que la busqueda dejo de funcionar.
const MINIMO_ESPERADO = 45;
if (aCorrer.length < MINIMO_ESPERADO) {
  console.error(
    `Solo se encontraron ${aCorrer.length} pruebas y se esperaban al menos `
    + `${MINIMO_ESPERADO}. O la busqueda esta rota, o esto no se esta ejecutando desde la `
    + `raiz del repositorio. No se ejecuta nada: un verde con media suite es peor que un rojo.`
  );
  process.exit(1);
}

console.log(`Encontradas ${todas.length} pruebas. Se ejecutan ${aCorrer.length}.\n`);

const fallos = [];
const empezo = Date.now();

for (const fichero of aCorrer) {
  const ejecutable = fichero.endsWith('.ts') ? 'tsx' : 'node';
  const r = spawnSync('npx', [ejecutable, fichero], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  const ok = r.status === 0;
  if (!ok) fallos.push({ fichero, salida: (r.stdout || '') + (r.stderr || '') });
  console.log(`${ok ? '  ok  ' : ' FALLA'}  ${fichero}`);
}

const segundos = Math.round((Date.now() - empezo) / 1000);

// EL DETALLE DE LOS FALLOS, AL FINAL Y JUNTO. Intercalado con el resto se pierde entre
// cincuenta lineas, y lo que hace falta al arreglar es tenerlos todos delante.
if (fallos.length) {
  console.log('\n' + '='.repeat(70));
  for (const { fichero, salida } of fallos) {
    console.log(`\n--- ${fichero} ---`);
    console.log(salida.trim().split('\n').slice(-25).join('\n'));
  }
}

if (cuarentena.length) {
  console.log('\n' + '='.repeat(70));
  console.log(`EN CUARENTENA (${cuarentena.length}) — existen y NO se ejecutan:\n`);
  for (const f of cuarentena) {
    console.log(`  ${f}`);
    console.log(`      ${EN_CUARENTENA[f.replace(/^tests\//, '')]}\n`);
  }
  console.log('  Arreglalas o borralas. Mientras esten aqui, no cuentan como cobertura.');
}

console.log('\n' + '='.repeat(70));
console.log(
  fallos.length
    ? `${aCorrer.length - fallos.length} pasan, ${fallos.length} FALLAN  (${segundos}s)`
    : `Las ${aCorrer.length} pasan  (${segundos}s)`
);

process.exit(fallos.length ? 1 : 0);

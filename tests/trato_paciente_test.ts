/**
 * Tú, usted o vos: la primera cosa que sale del SOUL para volverse un ajuste.
 *
 * POR QUÉ EXISTE ESTE CAMPO. El trato al paciente estaba escrito en el SOUL, y el SOUL
 * es UNO para todas las clínicas. La primera que quisiera tutear obligaba a editar el
 * prompt compartido —y ese prompt es justo lo que hay que poder copiar tal cual de una
 * versión del producto a la siguiente—. Con cuatro clientes y tres versiones, actualizar
 * se convertía en una revisión manual del SOUL clínica por clínica.
 *
 * LO QUE MÁS IMPORTA DE ESTA PRUEBA NO ES QUE EL CAMPO FUNCIONE: ES QUE AÑADIRLO NO
 * CAMBIE EL COMPORTAMIENTO DE UNA CLÍNICA QUE YA ESTÁ ATENDIENDO. David preguntó
 * exactamente eso —«¿qué afectaría a COI?»— y la respuesta tiene que ser demostrable,
 * no prometida. Por eso los casos de «no cambia nada» van primero y son más.
 *
 * Y HAY UNA COMPROBACIÓN AQUÍ QUE NO ES SOBRE ESTE CAMPO: que TODA columna de `CAMPOS`
 * exista en alguna migración. `cargarTodas` hace un solo `select` con todas, así que una
 * columna que falte no rompe ese ajuste: rompe la lectura ENTERA y todas las clínicas
 * caen a los valores del entorno —COI perdería horario, dirección, precios y doctores—.
 * Es el fallo más caro que puede meter un campo nuevo, y hasta hoy nada lo vigilaba.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.CLINIC_TIMEZONE = 'Europe/Madrid';

const esquema = await import('../src/tenants/settings-schema.js');
const { normalizarTrato, TRATOS, TRATO_POR_DEFECTO } = esquema;

// =============================================================================
// 1. EL DEFECTO, QUE ES LA PARTE QUE PUEDE ROMPER UNA CLÍNICA
// =============================================================================

// SI ESTO CAMBIA A 'tu', TODAS LAS CLÍNICAS QUE NO LO HAYAN ELEGIDO EMPIEZAN A TUTEAR
// A SUS PACIENTES, sin que nadie lo haya decidido y sin que nada avise. Es un cambio de
// comportamiento en producción escondido en una constante, así que se fija por escrito.
//
// Y el motivo del valor, para que no se cambie «porque suena más cercano»: tratar de
// usted a quien esperaba tú suena rígido y no se queja nadie; tutear a quien esperaba
// usted es una falta de respeto, y en una clínica eso es una queja. Los dos fallos no
// cuestan lo mismo.
assert.equal(
  TRATO_POR_DEFECTO, 'usted',
  'el defecto TIENE que ser usted: cambiarlo hace que todas las clinicas que no lo '
  + 'eligieron empiecen a tutear a sus pacientes en el siguiente despliegue'
);

assert.ok(
  (TRATOS as readonly string[]).includes('vos'),
  'vos desde el primer dia: el trato cambia por pais y añadirlo despues es una migracion'
);
assert.deepEqual([...TRATOS].sort(), ['tu', 'usted', 'vos']);

// =============================================================================
// 2. ACEPTA LO QUE ESCRIBE UNA PERSONA, NO LO QUE LE CONVIENE AL CÓDIGO
// =============================================================================

for (const [escrito, esperado] of [
  ['usted', 'usted'], ['USTED', 'usted'], ['  Usted  ', 'usted'],
  // `tu` y `tú` son la MISMA opcion y nadie se va a acordar de cual toca.
  ['tu', 'tu'], ['tú', 'tu'], ['TÚ', 'tu'], [' Tu ', 'tu'],
  ['vos', 'vos'], ['vós', 'vos'], ['VOS', 'vos']
] as const) {
  assert.equal(
    normalizarTrato(escrito), esperado,
    `«${escrito}» tiene que entrar como «${esperado}»`
  );
}

// =============================================================================
// 3. Y LO QUE NO ES UNA DE LAS TRES, SE DESCARTA — NO SE ARREGLA
// =============================================================================
//
// Devolver null NO significa «sin trato»: significa «la clinica no lo eligio», y
// entonces manda el defecto. Es la regla de todo settings-schema: caer al valor de
// siempre se puede explicar; adivinar lo que quiso decir, no.

for (const basura of [
  '', '   ', null, undefined, 'formal', 'informal', 'ustedes', 'tuteo', 'vosotros',
  'usted/tu', 'us ted', 42, 0, true, false, {}, [], ['tu'], { trato: 'tu' }
]) {
  assert.equal(
    normalizarTrato(basura), null,
    `«${JSON.stringify(basura)}» no es un trato y no puede colarse`
  );
}

// =============================================================================
// 4. QUE AÑADIRLO NO CAMBIE NADA PARA UNA CLÍNICA QUE YA ATIENDE
// =============================================================================
//
// ES LA PREGUNTA DE DAVID. Una clinica con la columna en NULL -o sea, todas las que
// existen el dia del despliegue- tiene que comportarse EXACTAMENTE como antes.

{
  const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
  const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');

  const fake = new FakeSupabase({ primaryKeys: HELIOS_PRIMARY_KEYS });
  // COI tal como esta hoy: con sus ajustes puestos y SIN el campo nuevo.
  fake.seed('helios_tenants', [{
    tenant_id: 'democoi1',
    clinic_tone: 'cercano y profesional',
    clinic_address: 'CC Ejemplo, local 1',
    clinic_formality: null
  }]);
  __setSupabaseClientForTests(fake as any);

  const settings = await import('../src/tenants/settings.js');
  const contexto = await settings.leerContextoDeClinica('democoi1');

  assert.equal(
    contexto.trato, 'usted',
    'con la columna en NULL, la clinica sigue tratando de usted: NADA cambia para COI'
  );

  // Y LO DEMÁS SIGUE LLEGANDO. Es la otra mitad: si el campo nuevo hubiera roto el
  // `select`, esto vendría vacío y nadie lo notaría hasta que un paciente preguntara
  // la dirección.
  assert.equal(contexto.direccion, 'CC Ejemplo, local 1', 'la direccion sigue llegando');
  assert.equal(contexto.tono, 'cercano y profesional', 'y el tono');

  const panel = await settings.leerAjustes('democoi1');
  assert.equal(
    panel.origen && (panel.origen as any).clinic_formality, 'defecto',
    'el panel tiene que decir «de siempre» y no «elegido por la clinica»: nadie lo eligio'
  );
  assert.equal(
    panel.clinic_formality, 'usted',
    'y enseñar el valor que se esta usando de verdad, no un hueco'
  );
  assert.deepEqual(panel.clinic_formality_opciones, ['usted', 'tu', 'vos']);
}

// =============================================================================
// 5. Y QUE CUANDO SÍ SE ELIGE, LLEGUE
// =============================================================================

{
  const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
  const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');

  const fake = new FakeSupabase({ primaryKeys: HELIOS_PRIMARY_KEYS });
  fake.seed('helios_tenants', [
    { tenant_id: 'democoi1', clinic_formality: null },
    { tenant_id: 'clinica3', clinic_formality: 'tu' },
    // Una escritura a mano con acento y mayuscula, que el CHECK de la migracion ya no
    // deja entrar pero que el lector tiene que aguantar igual.
    { tenant_id: 'clinica4', clinic_formality: 'Vós' },
    // Y algo invalido: cae al defecto y se avisa, no tumba a las demas.
    { tenant_id: 'clinica5', clinic_formality: 'formal' }
  ]);
  __setSupabaseClientForTests(fake as any);

  // La cache es de un minuto y viva entre pruebas: hay que invalidarla.
  const settings = await import('../src/tenants/settings.js');
  await settings.guardarAjustes('clinica3', { clinic_formality: 'tu' }).catch(() => {});

  assert.equal((await settings.leerContextoDeClinica('clinica3')).trato, 'tu');
  assert.equal((await settings.leerContextoDeClinica('clinica4')).trato, 'vos');
  assert.equal(
    (await settings.leerContextoDeClinica('clinica5')).trato, 'usted',
    'un valor invalido cae al defecto, y no arrastra a las otras clinicas'
  );
  assert.equal(
    (await settings.leerContextoDeClinica('democoi1')).trato, 'usted',
    'Y COI SIGUE EN USTED aunque la clinica 3 tutee: es la separacion por tenant'
  );

  // Guardar algo que no es un trato tiene que fallar ENTERO, sin escribir nada.
  const malo = await settings.guardarAjustes('clinica3', { clinic_formality: 'formal' });
  assert.equal(malo.ok, false);
  assert.equal(malo.error, 'TRATO_INVALIDO');
  assert.equal(malo.campo, 'clinic_formality');
}

// =============================================================================
// 6. QUE EL ORQUESTADOR LO MANDE DE VERDAD, Y SIEMPRE
// =============================================================================
//
// El campo puede estar perfecto y no servir de nada si no viaja. Es el mismo fallo que
// el horario y el tono, que se guardaban en el panel y NUNCA llegaban a Hermes: la
// pantalla decia «guardado» y era decorativa.

{
  const fuente = readFileSync('src/orchestrator.ts', 'utf8');
  const inicio = fuente.indexOf('clinic_context: {');
  assert.ok(inicio > 0, 'se encontro el bloque clinic_context');
  const bloque = fuente.slice(inicio, fuente.indexOf('signals: {', inicio));

  // ANCLADO AL PRINCIPIO DE LÍNEA, y no es un detalle: la primera versión era
  // `/formality:\s*contextoDeClinica\.trato/` y pasaba en VERDE con la línea comentada,
  // porque el texto sigue ahí. Con `^\s*` no cuela, porque `//` no es espacio.
  //
  // Es el mismo error del día: comprobar que aparece un texto en vez de comprobar la
  // propiedad. Aquí la propiedad es «esta línea se ejecuta», no «esta línea existe».
  assert.ok(
    /^\s*formality:\s*contextoDeClinica\.trato,/m.test(bloque),
    'el orquestador no manda el trato en clinic_context: el ajuste seria decorativo'
  );

  // VIAJA SIEMPRE, NO CON EL PATRÓN CONDICIONAL. Es la diferencia con la direccion y el
  // horario, que se omiten si nadie los confirmo porque un defecto se leeria como un
  // hecho de la clinica. El trato no es un hecho del mundo: es una eleccion que hay que
  // tomar en CADA frase, asi que omitirla se la devolveria al SOUL —que es de donde se
  // la esta sacando—.
  assert.ok(
    !/\.\.\.\(contextoDeClinica\.trato/.test(bloque),
    'el trato NO puede ir condicionado: sin el, la decision vuelve al SOUL compartido'
  );

  // Y EL CAMINO DEL FALLO. Si Supabase no contesta, el `catch` construye un contexto a
  // mano; si ahi falta el trato, llegaria `undefined` justo cuando nadie esta mirando.
  const conCatch = fuente.slice(
    fuente.indexOf('leerContextoDeClinica(tenantId).catch'),
    inicio
  );
  assert.ok(
    /trato:\s*TRATO_POR_DEFECTO/.test(conCatch),
    'con los ajustes ilegibles hay que tratar de usted, no mandar undefined'
  );
}

// =============================================================================
// 7. EL PANEL, PARA QUE SE PUEDA CAMBIAR SIN TOCAR EL SOUL
// =============================================================================

{
  const panel = readFileSync('public/index.html', 'utf8');

  assert.ok(
    /<select[^>]*id="clinica-trato"/.test(panel),
    'un desplegable y no un campo de texto: son tres valores y hay que acertarlos'
  );
  for (const opcion of ['usted', 'tu', 'vos']) {
    assert.ok(
      new RegExp(`<option value="${opcion}"`).test(panel),
      `falta la opcion «${opcion}» en el panel`
    );
  }
  assert.ok(
    /cambiarTexto\('clinic_formality'/.test(panel),
    'el desplegable no guarda nada'
  );
  assert.ok(
    /clinica-trato'\)\.value\s*=/.test(panel),
    'al abrir Ajustes hay que enseñar el valor actual, no la primera opcion por casualidad'
  );

  // Y QUE EL PLACEHOLDER DEL TONO YA NO PIDA EL TUTEO. Si sigue diciendo «de tú o de
  // usted», la clínica escribe ahí lo que ya decide el desplegable y los dos campos se
  // contradicen. Es la versión pequeña del fallo nº 12: el panel enseñando algo que no
  // es lo que el sistema usa.
  const tono = panel.slice(panel.indexOf('id="clinica-tono"'));
  const placeholder = tono.slice(0, tono.indexOf('>'));
  assert.ok(
    !/de t(ú|u) o de usted/i.test(placeholder),
    'el tono ya no pide el tuteo: eso lo decide el desplegable, y pedirlo dos veces '
    + 'deja a la clinica sin saber cual manda'
  );
}

// =============================================================================
// 8. TODA COLUMNA DE `CAMPOS` EXISTE EN UNA MIGRACIÓN
// =============================================================================
//
// ESTA NO ES SOBRE EL TRATO, Y ES LA MÁS IMPORTANTE DEL FICHERO.
//
// `cargarTodas` hace UN SOLO select con todas las columnas de `CAMPOS`. Si una no existe
// en la base, no falla ese ajuste: falla la lectura ENTERA, se cachea el fallo, y TODAS
// las clínicas caen a los valores del entorno. COI perdería su horario, su dirección, sus
// precios y sus doctores, y por dentro se vería como un `settings_read_failed` en los
// logs mientras por fuera Helios sigue contestando.
//
// O sea: el fallo más caro que puede meter un campo nuevo es olvidar la migración, y
// hasta hoy nada lo vigilaba. Esto lo vigila para siempre, no solo para este campo.

{
  const fuente = readFileSync('src/tenants/settings.ts', 'utf8');
  const bloque = fuente.slice(
    fuente.indexOf('const CAMPOS = {'),
    fuente.indexOf('} as const;', fuente.indexOf('const CAMPOS = {'))
  );
  const columnas = [...bloque.matchAll(/^\s{2}(\w+):\s*\{/gm)].map(m => m[1]);

  assert.ok(columnas.length >= 15, `se esperaban las columnas de CAMPOS, salieron ${columnas.length}`);
  assert.ok(columnas.includes('clinic_formality'), 'clinic_formality tiene que estar en CAMPOS');

  const migraciones = readdirSync('supabase/migrations')
    .filter(f => f.endsWith('.sql'))
    .map(f => readFileSync(`supabase/migrations/${f}`, 'utf8'))
    .join('\n');

  // Estas nacieron con la tabla, antes de que hubiera carpeta de migraciones aquí.
  const DE_LA_TABLA_ORIGINAL = new Set(['buffer_ms', 'handoff_stale_hours']);

  const sinMigracion = columnas.filter(
    c => !DE_LA_TABLA_ORIGINAL.has(c) && !new RegExp(`\\b${c}\\b`).test(migraciones)
  );
  assert.deepEqual(
    sinMigracion, [],
    'ESTAS COLUMNAS ESTAN EN CAMPOS Y NO EN NINGUNA MIGRACION: ' + sinMigracion.join(', ')
    + '. El select de cargarTodas las pide todas, asi que una que falte deja a TODAS las '
    + 'clinicas con los valores del entorno -COI sin horario, sin direccion, sin precios '
    + 'y sin doctores- y solo se ve en un settings_read_failed de los logs.'
  );
}

console.log('trato_paciente_test: OK');

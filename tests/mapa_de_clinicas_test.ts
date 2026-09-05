/**
 * El mapa de clínicas, leído de la tabla en vez de una variable de entorno.
 *
 * LO QUE ESTÁ EN JUEGO. Este mapa decide de quién es cada mensaje. Hasta hoy vivía en
 * `CHATWOOT_TENANT_CONTEXTS_JSON`, y esa variable tenía dos problemas que se pagaban
 * caros: cambiarla exigía redesplegar —cortando a TODAS las clínicas para dar de alta a
 * una—, y un JSON con un fallo hacía que se lanzara ANTES de mirar de quién era el
 * mensaje, dejando a todas sin atender con el contenedor en `healthy`.
 *
 * POR QUÉ ESTA PRUEBA ES LARGA. Porque el cambio no puede degradar una función: si me
 * equivoco aquí, DEJAN DE ENTRAR MENSAJES EN TODAS LAS CLÍNICAS A LA VEZ. Casi todo lo
 * que se comprueba abajo no es «esto funciona», es «esto NO puede tumbar el sistema»:
 * la base caída, la tabla vacía, una fila a medias, un duplicado. El camino feliz es la
 * parte corta.
 *
 * Y LA GARANTÍA QUE NO SE VE. La lectura sigue siendo SÍNCRONA. Se llama desde doce
 * sitios, uno en el camino de cada webhook; volverla `async` habría obligado a tocar los
 * doce. Lo que se fue al fondo es el refresco, no la lectura. La sección 9 lo fija.
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';

// EL MAPA DE LA VARIABLE. Los perfiles llevan «-por-entorno» a propósito: así, cuando la
// tabla mande, se ve en el valor CUÁL de las dos fuentes contestó. Si los dos mapas
// dijeran lo mismo, la prueba pasaría en verde aunque la tabla no se leyera nunca.
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi', hermes_profile: 'helios-por-entorno' },
  '3': { tenant_id: 'pruebawh1', clinic_id: 'prueba', hermes_profile: 'wh-por-entorno' }
});

const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const ctx = await import('../src/tenants/context.js');

/** Deja la tabla con estas filas y devuelve el módulo a su estado de arranque. */
function conLaTabla(filas: any[]) {
  const db = new FakeSupabase(HELIOS_PRIMARY_KEYS);
  db.seed('helios_tenants', JSON.parse(JSON.stringify(filas)));
  __setSupabaseClientForTests(db as any);
  return db;
}

const DOS_CLINICAS = [
  { tenant_id: 'democoi1', account_id: '2', clinic_id: 'coi', hermes_profile: 'helios', mapa_activo: true },
  { tenant_id: 'pruebawh1', account_id: '3', clinic_id: 'prueba', hermes_profile: 'helios-prueba-wh', mapa_activo: true }
];

// Silencia los console.warn esperados para que el fallo de verdad, si lo hay, se vea.
const warnDeVerdad = console.warn;
const avisos: string[] = [];
console.warn = (...args: any[]) => { avisos.push(String(args[0])); };
function avisosDesde(n: number) { return avisos.slice(n); }

// =============================================================================
// 1. SIN TABLA, TODO SIGUE EXACTAMENTE COMO ESTABA
// =============================================================================
//
// Lo primero que hay que garantizar no es que lo nuevo funcione, sino que desplegar esto
// no cambie nada. Mientras nadie rellene la tabla, manda la variable.

ctx.reiniciarMapaParaPruebas();
{
  const coi = ctx.resolveTenantContext('2');
  assert.equal(coi.tenant_id, 'democoi1');
  assert.equal(coi.hermes_profile, 'helios-por-entorno', 'sin tabla tiene que contestar la variable');
  assert.equal(ctx.estadoDelMapa().fuente, 'entorno');

  // Y una cuenta que no está en el mapa se sigue rechazando en vez de adivinar.
  assert.throws(
    () => ctx.resolveTenantContext('99'),
    (e: any) => e.code === 'TENANT_NOT_CONFIGURED',
    'una cuenta desconocida no puede resolverse a ninguna clinica'
  );
}

// =============================================================================
// 2. CUANDO LA TABLA TRAE CLÍNICAS, MANDA LA TABLA
// =============================================================================

ctx.reiniciarMapaParaPruebas();
conLaTabla(DOS_CLINICAS);
await ctx.refrescarMapaDesdeTabla();
{
  assert.equal(ctx.estadoDelMapa().fuente, 'tabla');
  assert.equal(ctx.estadoDelMapa().clinicas, 2);

  const coi = ctx.resolveTenantContext('2');
  assert.equal(coi.hermes_profile, 'helios', 'ahora tiene que contestar la TABLA, no la variable');
  assert.equal(coi.clinic_id, 'coi');

  // Y por tenant_id, que es el otro camino de entrada.
  assert.equal(ctx.resolveTenantContextByTenantId('pruebawh1').account_id, '3');
}

// =============================================================================
// 3. YA CON LA TABLA MANDANDO, LA VARIABLE DEJA DE MIRARSE
// =============================================================================
//
// Esto es el cortocircuito, y sin él el cambio no serviría de nada: el lector de la
// variable se ejecuta en CADA lectura, así que pisaría el mapa bueno una y otra vez.
//
// Se comprueba con la variable rota A PROPÓSITO. Antes, un JSON así lanzaba y dejaba a
// todas las clínicas sin atender. Ahora ni se mira.

{
  const anterior = process.env.CHATWOOT_TENANT_CONTEXTS_JSON;
  process.env.CHATWOOT_TENANT_CONTEXTS_JSON = '{ esto no es JSON';

  assert.equal(
    ctx.resolveTenantContext('2').hermes_profile, 'helios',
    'con la tabla mandando, una variable rota no puede afectar a nadie'
  );

  process.env.CHATWOOT_TENANT_CONTEXTS_JSON = anterior;
}

// =============================================================================
// 4. LA BASE CAÍDA NO SE LLEVA EL MAPA POR DELANTE
// =============================================================================
//
// El refresco corre solo, en un temporizador, sin nadie esperándolo. Si lanzara, el fallo
// acabaría en un rechazo de promesa sin capturar: nadie se enteraría hasta que dejaran de
// entrar mensajes.
//
// Se prueban LAS DOS FORMAS de fallar, que son distintas por dentro:

{
  const antes = avisos.length;

  // (a) La conexión se cae: `from()` lanza.
  __setSupabaseClientForTests({ from() { throw new Error('ECONNREFUSED'); } } as any);
  await ctx.refrescarMapaDesdeTabla();

  assert.equal(
    ctx.resolveTenantContext('2').hermes_profile, 'helios',
    'con la base caida se sigue atendiendo con el ultimo mapa bueno'
  );
  assert.equal(ctx.estadoDelMapa().clinicas, 2);
  assert.match(String(ctx.estadoDelMapa().ultimo_fallo), /ECONNREFUSED/);

  // (b) La base contesta, pero con un error. Es el caso de una politica de RLS mal
  //     puesta, y NO lanza: llega en `resultado.error`. Es facil olvidarlo y entonces
  //     `data` viene null y se construye un mapa vacio, que es justo lo que no puede
  //     pasar.
  __setSupabaseClientForTests({
    from: () => ({ select: async () => ({ data: null, error: { message: 'permission denied for table helios_tenants' } }) })
  } as any);
  await ctx.refrescarMapaDesdeTabla();

  assert.equal(
    ctx.resolveTenantContext('2').hermes_profile, 'helios',
    'un error devuelto -no lanzado- tampoco puede vaciar el mapa'
  );
  assert.equal(ctx.estadoDelMapa().clinicas, 2);

  assert.ok(
    avisosDesde(antes).some(a => a.includes('mapa_refresco_fallido')),
    'un refresco fallido tiene que quedar anotado: si no, el mapa se queda viejo en silencio'
  );
}

// =============================================================================
// 5. UNA TABLA VACÍA TAMPOCO BORRA EL MAPA
// =============================================================================
//
// Cero filas y un fallo de lectura se parecen demasiado: un DELETE de más, una migración a
// medias o unos permisos mal puestos devuelven cero exactamente igual que una tabla que de
// verdad está vacía. De esos casos, ninguno significa «deja de atender a todo el mundo».

{
  const antes = avisos.length;
  conLaTabla([]);
  await ctx.refrescarMapaDesdeTabla();

  assert.equal(ctx.estadoDelMapa().clinicas, 2, 'cero filas NO puede vaciar el mapa en memoria');
  assert.equal(ctx.resolveTenantContext('2').hermes_profile, 'helios');
  assert.ok(avisosDesde(antes).some(a => a.includes('mapa_sin_clinicas')));
}

// =============================================================================
// 6. UNA FILA MALA SOLO SE LLEVA A SU CLÍNICA
// =============================================================================
//
// Esta es la mejora de fondo sobre la variable de entorno. Allí, una entrada incompleta
// lanzaba y tumbaba a TODAS. Aquí, la clínica rota se queda sin atender —que es lo
// correcto cuando no se sabe con qué atenderla— y las demás ni se enteran.

ctx.reiniciarMapaParaPruebas();
{
  const antes = avisos.length;
  conLaTabla([
    DOS_CLINICAS[0],
    // Alta a medias: dice ser una clínica y no tiene con qué atenderla.
    { tenant_id: 'pruebawh1', account_id: '3', clinic_id: 'prueba', hermes_profile: null, mapa_activo: true }
  ]);
  await ctx.refrescarMapaDesdeTabla();

  assert.equal(ctx.resolveTenantContext('2').clinic_id, 'coi', 'la clinica sana sigue atendiendose');
  assert.equal(ctx.estadoDelMapa().clinicas, 1);
  assert.throws(
    () => ctx.resolveTenantContext('3'),
    (e: any) => e.code === 'TENANT_NOT_CONFIGURED',
    'la clinica a medias se rechaza: sin perfil no se sabe a que Hermes hablarle'
  );
  assert.ok(
    avisosDesde(antes).some(a => a.includes('mapa_filas_descartadas') && a.includes('sin hermes_profile')),
    'descartar una clinica en silencio seria peor que el fallo: tiene que decir cual y por que'
  );
}

// =============================================================================
// 7. `mapa_activo = false` DA DE BAJA SIN BORRAR NADA
// =============================================================================
//
// Es la forma de retirar una clínica conservando su historial y sus ajustes. Y no es un
// fallo, así que no debe avisar de nada.

ctx.reiniciarMapaParaPruebas();
{
  const antes = avisos.length;
  conLaTabla([DOS_CLINICAS[0], { ...DOS_CLINICAS[1], mapa_activo: false }]);
  await ctx.refrescarMapaDesdeTabla();

  assert.equal(ctx.estadoDelMapa().clinicas, 1);
  assert.equal(ctx.resolveTenantContext('2').clinic_id, 'coi');
  assert.throws(() => ctx.resolveTenantContext('3'), (e: any) => e.code === 'TENANT_NOT_CONFIGURED');
  assert.ok(
    !avisosDesde(antes).some(a => a.includes('mapa_filas_descartadas')),
    'una baja deliberada no es una fila descartada y no debe ensuciar el log'
  );
}

// =============================================================================
// 8. LAS FILAS QUE NO SON CLÍNICAS SE IGNORAN EN SILENCIO
// =============================================================================
//
// `helios_tenants` guarda también filas que no son clínicas atendidas. Sin `account_id`
// no están en el mapa, y eso es normal, no un fallo.

ctx.reiniciarMapaParaPruebas();
{
  const antes = avisos.length;
  conLaTabla([
    DOS_CLINICAS[0],
    { tenant_id: 'escala365', account_id: null, clinic_id: null, hermes_profile: null, mapa_activo: true }
  ]);
  await ctx.refrescarMapaDesdeTabla();

  assert.equal(ctx.estadoDelMapa().clinicas, 1);
  assert.ok(
    !avisosDesde(antes).some(a => a.includes('mapa_filas_descartadas')),
    'una fila sin account_id no es una clinica rota: no hay nada que avisar'
  );
}

// =============================================================================
// 9. DOS CLÍNICAS NO PUEDEN COMPARTIR CUENTA
// =============================================================================
//
// La base ya lo impide con un índice único, así que llegar aquí significa que esa garantía
// no está puesta —una migración que no corrió—. Se descarta la segunda en vez de pisar la
// primera: ante la duda, no atender es mejor que atender a la clínica equivocada, porque
// eso es exactamente mezclar los datos de dos clínicas.

ctx.reiniciarMapaParaPruebas();
{
  const antes = avisos.length;
  conLaTabla([
    DOS_CLINICAS[0],
    { tenant_id: 'otra', account_id: '2', clinic_id: 'otra', hermes_profile: 'otro', mapa_activo: true }
  ]);
  await ctx.refrescarMapaDesdeTabla();

  assert.equal(ctx.estadoDelMapa().clinicas, 1);
  assert.equal(
    ctx.resolveTenantContext('2').clinic_id, 'coi',
    'la segunda no puede quedarse con la cuenta de la primera'
  );
  assert.ok(avisosDesde(antes).some(a => a.includes('duplicada en la tabla')));
}

// =============================================================================
// 10. LA LECTURA SIGUE SIENDO SÍNCRONA
// =============================================================================
//
// Es la garantía que sostiene todo lo demás: los doce sitios que llaman a esto no se
// tocaron. Si alguien vuelve `async` el lector, esos doce empiezan a recibir una promesa
// donde esperaban un objeto —y `contexto.tenant_id` pasa a ser `undefined` sin lanzar—.
// Eso no rompe una función: manda los mensajes de una clínica al sitio equivocado.

ctx.reiniciarMapaParaPruebas();
conLaTabla(DOS_CLINICAS);
await ctx.refrescarMapaDesdeTabla();
{
  const resultado: any = ctx.resolveTenantContext('2');
  assert.ok(!(resultado instanceof Promise), 'resolveTenantContext NO puede devolver una promesa');
  assert.equal(typeof resultado.then, 'undefined', 'ni nada esperable');
  assert.equal(resultado.tenant_id, 'democoi1');

  const porTenant: any = ctx.resolveTenantContextByTenantId('democoi1');
  assert.ok(!(porTenant instanceof Promise));
  assert.equal(porTenant.account_id, '2');

  // Y en el código fuente, por si alguien lo cambia sin correr nada.
  const { readFileSync } = await import('node:fs');
  const fuente = readFileSync(new URL('../src/tenants/context.ts', import.meta.url), 'utf8');
  assert.ok(
    !/export\s+async\s+function\s+resolveTenantContext/.test(fuente),
    'resolveTenantContext tiene que seguir siendo sincrona: hay doce sitios que cuentan con ello'
  );
  assert.ok(
    !/export\s+async\s+function\s+resolveTenantContextByTenantId/.test(fuente),
    'resolveTenantContextByTenantId tambien'
  );

  // Y que el refresco NO se importe estáticamente de Supabase: si `context.ts` importara
  // el cliente arriba, el camino de cada mensaje arrastraría esa dependencia y las
  // pruebas que solo miran el mapa necesitarían una base de datos para arrancar.
  assert.ok(
    !/^import[^\n]*supabase\/client/m.test(fuente),
    'Supabase tiene que cargarse con import() dinamico dentro del refresco, no arriba'
  );
}

// =============================================================================
// 11. EL TEMPORIZADOR NO PUEDE DEJAR EL PROCESO COLGADO
// =============================================================================
//
// Un `setInterval` sin `unref()` impide que Node termine. En producción da igual —el
// servidor no termina—, pero deja las pruebas colgadas para siempre, y eso se manifiesta
// como «la suite se quedó parada» sin ninguna pista de por qué.

{
  ctx.arrancarRefrescoDelMapa(60_000);
  // Llamarlo dos veces no puede dejar dos temporizadores corriendo.
  ctx.arrancarRefrescoDelMapa(60_000);
  ctx.pararRefrescoDelMapa();
  // Si esto no termina, es que quedó un temporizador vivo.
}

console.warn = warnDeVerdad;
console.log('mapa_de_clinicas_test: OK');

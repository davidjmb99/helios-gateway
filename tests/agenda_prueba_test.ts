/**
 * La comprobación de que una clínica tiene la agenda bien montada.
 *
 * ESTO NO PRUEBA CÓDIGO, PRUEBA UN DIAGNÓSTICO, y por eso lo que se comprueba de cada caso
 * no es que devuelva bien un dato: es que DIGA QUÉ HAY QUE HACER. Un informe que dice «hay
 * un problema» sin decir cuál obliga a quien monta la cuenta a repasar siete pasos de
 * Google a ciegas, que es exactamente lo que este endpoint existe para evitar.
 *
 * LOS CUATRO FALLOS QUE SE ARREGLAN EN SITIOS DISTINTOS, y por eso hay que distinguirlos:
 *
 *   no hay doctores            -> se rellena el campo en Ajustes
 *   los doctores no se leen    -> hay UNA linea mal y no se guardó ninguna
 *   Google no contesta         -> la credencial, en Coolify
 *   un doctor sin acceso       -> compartir SU calendario, en calendar.google.com
 *
 * Los dos últimos se parecen mucho y llevan a pantallas distintas. Confundirlos es la
 * diferencia entre cinco minutos y una tarde.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';

const { probarAgenda } = await import('../src/agenda/prueba.js');
const { olvidarTokens } = await import('../src/agenda/google.js');

const JORNADA = [{ desde: 10 * 60, hasta: 20 * 60 }];
const HORARIO = { 0: [], 1: JORNADA, 2: JORNADA, 3: JORNADA, 4: JORNADA, 5: JORNADA, 6: JORNADA } as any;
const ZONA = 'America/Caracas';
/** Lunes 7 de septiembre de 2026, las diez de la mañana en Caracas: la clínica abre. */
const LUNES = new Date('2026-09-07T14:00:00Z');

const DOS_DOCTORES = `
Dra. Ana Martínez
  calendario: c-ana@group.calendar.google.com
  hace: valoración, higiene

Dr. Roberto Vélez
  calendario: c-velez@group.calendar.google.com
  hace: valoración, cordal
`;

function fetchDe(respuestas: Array<{ ok?: boolean; status?: number; cuerpo?: any }>) {
  let i = 0;
  return (async () => {
    const r = respuestas[i++] ?? { ok: true, cuerpo: {} };
    return {
      ok: r.ok !== false && (r.status === undefined || r.status < 400),
      status: r.status ?? 200,
      json: async () => r.cuerpo ?? {},
      text: async () => JSON.stringify(r.cuerpo ?? {})
    } as any;
  }) as unknown as typeof fetch;
}

const TOKEN_OK = { ok: true, cuerpo: { access_token: 'tok-1', expires_in: 3600 } };

// UNA CLAVE RSA DE VERDAD, aunque aqui no se verifique ninguna firma: `tokenDeAcceso`
// firma antes de salir a la red, asi que con una clave de mentira todos los casos de abajo
// darian `agenda_clave_invalida` y la prueba pareceria pasar comprobando otra cosa.
const CLAVE = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CRED = { correo: 'helios-agenda@proyecto.iam.gserviceaccount.com', clave: CLAVE };

const base = { doctoresTexto: DOS_DOCTORES, cierresTexto: null, horario: HORARIO, zona: ZONA, ahora: LUNES };

// --- TODO BIEN ------------------------------------------------------------

{
  olvidarTokens();
  const impl = fetchDe([
    TOKEN_OK,
    {
      ok: true,
      cuerpo: {
        calendars: {
          'c-ana@group.calendar.google.com': { busy: [{ start: '2026-09-07T18:00:00Z', end: '2026-09-07T19:00:00Z' }] },
          'c-velez@group.calendar.google.com': { busy: [] }
        }
      }
    }
  ]);

  const r = await probarAgenda(base, { fetchImpl: impl, credenciales: CRED, ahora: LUNES });
  assert.equal(r.ok, true, 'con todo bien, el informe sale limpio');
  assert.deepEqual(r.problemas, []);
  assert.equal(r.doctores.length, 2);
  assert.equal(r.doctores[0].permiso, 'ok');
  assert.equal(r.doctores[0].ocupado, 1, 'la franja que tiene cogida');
  assert.equal(r.doctores[0].dias, 'LMXJVS', 'sus días, tal como se leen');

  // Y HUECOS DE VERDAD. Es la única parte del informe que responde a la pregunta que de
  // verdad importa -«¿le va a salir algo a un paciente?»- en vez de a una intermedia.
  assert.ok(r.huecos.length > 0, 'tiene que ofrecer huecos');
  assert.ok(r.huecos.length <= 5, 'unos pocos, que esto es un diagnóstico y no una agenda');
}

// --- UN DOCTOR SIN ACCESO: EL PASO 5 ---------------------------------------

{
  olvidarTokens();
  const impl = fetchDe([
    TOKEN_OK,
    {
      ok: true,
      cuerpo: {
        calendars: {
          'c-ana@group.calendar.google.com': { busy: [] },
          // Sin compartir con la cuenta de servicio. Google manda el error JUNTO A UN
          // `busy` vacío: parece un doctor con la semana entera libre.
          'c-velez@group.calendar.google.com': { busy: [], errors: [{ reason: 'notFound' }] }
        }
      }
    }
  ]);

  const r = await probarAgenda(base, { fetchImpl: impl, credenciales: CRED, ahora: LUNES });
  assert.equal(r.ok, false, 'un doctor ilegible NO es una agenda correcta');
  assert.equal(r.doctores[1].permiso, 'sin_acceso');
  assert.equal(r.doctores[1].ocupado, 0, 'no se cuenta como «ocupadísimo»: es que no se sabe');

  // EL MENSAJE TIENE QUE LLEVAR A LA PANTALLA CORRECTA. Sin el nombre, hay que probar los
  // cuatro; sin el ID, no se puede comparar con el de calendar.google.com; y sin decir qué
  // hacer, el informe solo dice que algo va mal.
  const aviso = r.problemas.join(' ');
  assert.ok(aviso.includes('Vélez'), 'dice QUIÉN');
  assert.ok(aviso.includes('c-velez@group.calendar.google.com'), 'y con qué ID comparar');
  assert.ok(/compartirlo|paso 5/i.test(aviso), 'y QUÉ hacer');

  // LA CLÍNICA SIGUE FUNCIONANDO: los huecos que salgan son de la doctora que sí se lee.
  assert.ok(r.huecos.every(h => h.doctor.includes('Ana')), 'ninguna cita al calendario ilegible');
}

// --- GOOGLE NO CONTESTA: LA CREDENCIAL -------------------------------------

{
  olvidarTokens();
  const impl = fetchDe([{ ok: false, status: 400, cuerpo: { error: 'invalid_grant' } }]);
  const r = await probarAgenda(base, { fetchImpl: impl, credenciales: CRED, ahora: LUNES });

  assert.equal(r.ok, false);
  // NO SE CONFUNDE CON «ESTE DOCTOR NO TIENE PERMISO». Uno se arregla en Coolify y el otro
  // en calendar.google.com, y mandar a la pantalla equivocada es una tarde perdida.
  assert.ok(r.problemas.some(p => p.includes('Google no contesta')), 'lo dice como lo que es');
  assert.ok(r.problemas.some(p => p.includes('invalid_grant')), 'con el motivo de Google');
  assert.ok(
    !r.problemas.some(p => /compartirlo|paso 5/i.test(p)),
    'y NO manda a compartir calendarios, que no es el problema'
  );
  assert.deepEqual(r.doctores, [], 'sin datos de Google no se inventa un estado por doctor');
}

// --- LOS DOCTORES: «NO HAY» NO ES LO MISMO QUE «ESTÁN MAL» -----------------

{
  const impl = fetchDe([TOKEN_OK]);
  const deps = { fetchImpl: impl, credenciales: CRED, ahora: LUNES };

  const sin = await probarAgenda({ ...base, doctoresTexto: '' }, deps);
  assert.equal(sin.ok, false);
  assert.ok(sin.problemas[0].includes('No hay doctores'), 'el campo está vacío: se rellena');

  const mal = await probarAgenda(
    { ...base, doctoresTexto: 'Dra. Ana\n  calendario: c1@g.com\n  horario: cuando pueda' },
    deps
  );
  assert.equal(mal.ok, false);
  // ESTA FRASE ES LA IMPORTANTE: «no se ha guardado NINGUNA». Sin ella, quien lo lee cree
  // que tiene tres doctores puestos y uno mal, y busca el fallo en el sitio equivocado.
  assert.ok(/no se entienden/i.test(mal.problemas[0]), 'hay una línea mal');
  assert.ok(/NO se ha guardado ninguna/i.test(mal.problemas[0]), 'y ninguna se guardó');
}

// --- LOS CIERRES QUITAN HUECOS ---------------------------------------------

{
  olvidarTokens();
  const libres = {
    ok: true,
    cuerpo: {
      calendars: {
        'c-ana@group.calendar.google.com': { busy: [] },
        'c-velez@group.calendar.google.com': { busy: [] }
      }
    }
  };

  const conCierre = await probarAgenda(
    { ...base, cierresTexto: '07/09/2026 - 30/09/2026  vacaciones' },
    { fetchImpl: fetchDe([TOKEN_OK, libres]), credenciales: CRED, ahora: LUNES }
  );
  // LA CLÍNICA CERRADA NO OFRECE NADA, aunque los doctores tengan la agenda vacía. Es lo
  // contrario de lo que diría Google, que sólo sabe de eventos.
  assert.equal(conCierre.huecos.length, 0, 'con la clínica cerrada no hay huecos');
  assert.equal(conCierre.cierres.length, 1);
  assert.ok(
    conCierre.problemas.some(p => /No hay ningun hueco/i.test(p)),
    'y se avisa en vez de dar un OK que parece bueno'
  );

  // Un cierre que no se entiende se dice, en vez de ignorarlo: la clínica cree tener
  // puesto el 25 de diciembre y estaría abierta.
  olvidarTokens();
  const roto = await probarAgenda(
    { ...base, cierresTexto: 'la semana de navidad' },
    { fetchImpl: fetchDe([TOKEN_OK, libres]), credenciales: CRED, ahora: LUNES }
  );
  assert.ok(roto.problemas.some(p => /dias cerrados no se entienden/i.test(p)));
}

// --- FILTRAR POR SERVICIO --------------------------------------------------

{
  olvidarTokens();
  const impl = fetchDe([
    TOKEN_OK,
    { ok: true, cuerpo: { calendars: { 'c-velez@group.calendar.google.com': { busy: [] } } } }
  ]);
  // La cordal es cirugía y sólo la hace Vélez. Sirve para comprobar de un vistazo que un
  // servicio cerrado está bien puesto, sin tener que escribirle al bot.
  const r = await probarAgenda({ ...base, servicio: 'cordal' }, { fetchImpl: impl, credenciales: CRED, ahora: LUNES });
  assert.equal(r.doctores.length, 1);
  assert.ok(r.doctores[0].nombre.includes('Vélez'));
  assert.ok(r.huecos.every(h => h.doctor.includes('Vélez')));
}

console.log('agenda_prueba_test: OK');

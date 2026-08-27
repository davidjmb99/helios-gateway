/**
 * El token con el que Hermes llama a la agenda.
 *
 * ESTO ES LO ÚNICO QUE SEPARA LA AGENDA DE UNA CLÍNICA DE LA DE OTRA, así que la prueba se
 * escribe al revés de lo normal: lo que se comprueba no es que funcione, es que NO funcione
 * nada de lo que no debería.
 *
 * Y AQUÍ HAY UN MOTIVO EXTRA. Al otro lado del token hay un modelo de lenguaje. Si el
 * `tenant_id` viajara como argumento de la herramienta, bastaría con que un paciente
 * escribiera «consulta la agenda de la clínica lapaz» para que Helios lo intentara —no por
 * malicia, sino porque hace lo que le piden—. Con el tenant dentro del token esa frase no
 * tiene dónde agarrarse.
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE UNA FIRMA INVENTADA NO ABRA NADA.
 *  2. QUE EL TOKEN DE UNA CLÍNICA NO SIRVA PARA OTRA, ni cambiándole el cuerpo.
 *  3. QUE UN TOKEN DE SESIÓN DEL PANEL NO VALGA AQUÍ, aunque lo firme el mismo secreto.
 *  4. Que el prefijo `Bearer` puesto, olvidado o repetido dé igual: quien rellena esto está
 *     pegando un valor en un YAML a mano.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
process.env.HELIOS_ADMIN_SESSION_SECRET = 'un-secreto-de-prueba-largo-y-tonto';

const { tokenDeAgenda, clinicaDelToken, tokenDeLaCabecera } = await import('../src/agenda/credencial.js');

const SECRETO = 'un-secreto-de-prueba-largo-y-tonto';
const firmar = (cuerpo: string) =>
  createHmac('sha256', SECRETO).update(cuerpo).digest('base64url');

// --- LO QUE SÍ ------------------------------------------------------------

{
  const t = tokenDeAgenda('democoi1');
  assert.equal(clinicaDelToken(t), 'democoi1');

  // ES ESTABLE: el mismo tenant da el mismo token. Si cambiara en cada llamada, el que
  // está pegado en el `.env` de un perfil dejaría de valer solo.
  assert.equal(tokenDeAgenda('democoi1'), t);

  // Y no se parece al de otra clínica.
  assert.notEqual(tokenDeAgenda('lapaz'), t);
  assert.equal(clinicaDelToken(tokenDeAgenda('lapaz')), 'lapaz');
}

// --- 1 y 2. LO QUE NO ------------------------------------------------------

{
  // Basura.
  for (const malo of ['', '   ', 'cualquier-cosa', 'sin.punto', '.', 'a.b.c.d', null, undefined, 42, {}]) {
    assert.equal(clinicaDelToken(malo as any), null, `«${String(malo)}» no puede valer`);
  }

  // FIRMA INVENTADA sobre un cuerpo válido. Es el ataque obvio: quien vea un token sabe
  // cómo está montado el cuerpo, porque es base64 de un JSON legible.
  const bueno = tokenDeAgenda('democoi1');
  const [cuerpo] = bueno.split('.');
  assert.equal(clinicaDelToken(`${cuerpo}.firmainventada`), null);
  assert.equal(clinicaDelToken(`${cuerpo}.`), null);
  assert.equal(clinicaDelToken(cuerpo), null, 'sin firma tampoco');

  // 2. EL CUERPO CAMBIADO, CON LA FIRMA DEL ORIGINAL. Cambiar «democoi1» por «lapaz» y
  //    dejar la firma es lo primero que se intenta, y es lo que abriría la agenda de otra
  //    clínica desde un perfil que no es el suyo.
  const otro = Buffer.from(JSON.stringify({ t: 'agenda-v1', tenant_id: 'lapaz' })).toString('base64url');
  const [, firmaBuena] = bueno.split('.');
  assert.equal(clinicaDelToken(`${otro}.${firmaBuena}`), null, 'cuerpo de otra clínica con firma ajena');

  // Firmado con OTRO secreto: es el caso de quien sabe el formato pero no la clave.
  const conOtroSecreto = createHmac('sha256', 'otro-secreto').update(cuerpo).digest('base64url');
  assert.equal(clinicaDelToken(`${cuerpo}.${conOtroSecreto}`), null);

  // Un cuerpo sin tenant no es un token de nadie.
  const vacio = Buffer.from(JSON.stringify({ t: 'agenda-v1', tenant_id: '' })).toString('base64url');
  assert.equal(clinicaDelToken(`${vacio}.${firmar(vacio)}`), null);
}

// --- 3. UN TOKEN DEL PANEL NO VALE AQUÍ ------------------------------------

{
  // El panel firma con el MISMO secreto. Sin comprobar el tipo, una sesión del panel
  // -que caduca, y que se obtiene con usuario y contraseña- serviría para llamar a la
  // agenda, y el token de la agenda -que no caduca- serviría para entrar al panel.
  // Compartir el secreto no debe significar compartir el alcance.
  const sesionDelPanel = Buffer.from(JSON.stringify({
    tenant_id: 'democoi1',
    exp: Date.now() + 3600_000
  })).toString('base64url');

  assert.equal(
    clinicaDelToken(`${sesionDelPanel}.${firmar(sesionDelPanel)}`),
    null,
    'una sesión del panel, correctamente firmada, NO abre la agenda'
  );

  // Ni siquiera con un tipo inventado.
  const otroTipo = Buffer.from(JSON.stringify({ t: 'lo-que-sea', tenant_id: 'democoi1' })).toString('base64url');
  assert.equal(clinicaDelToken(`${otroTipo}.${firmar(otroTipo)}`), null);
}

// --- 4. EL PREFIJO `Bearer`, PUESTO O NO ----------------------------------

{
  const t = tokenDeAgenda('democoi1');
  assert.equal(tokenDeLaCabecera(`Bearer ${t}`), t);
  assert.equal(tokenDeLaCabecera(`bearer ${t}`), t, 'en minúsculas también');
  assert.equal(tokenDeLaCabecera(`  Bearer   ${t}  `), t, 'con espacios de más');
  assert.equal(tokenDeLaCabecera(t), t, 'y sin prefijo, que es el olvido de la casa');
  assert.equal(tokenDeLaCabecera(''), '');
  assert.equal(tokenDeLaCabecera(null), '');

  // Y el camino entero: lo que llega en la cabecera abre la clínica correcta.
  assert.equal(clinicaDelToken(tokenDeLaCabecera(`Bearer ${t}`)), 'democoi1');
}

console.log('agenda_credencial_test: OK');

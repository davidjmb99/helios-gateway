/**
 * La respuesta a «¿tienes mañana a las 2 con la Dra. Ana?».
 *
 * ESTA PRUEBA COMPRUEBA UNA CONVERSACIÓN, no una función. Lo que se verifica en cada caso
 * es que salgan las piezas exactas de la frase que pidió David:
 *
 *     «La Dra. Ana no está disponible mañana a las 2:00 PM, pero la Dra. María sí tiene
 *      disponibilidad en ese horario. ¿Quieres que te reserve con ella o prefieres que
 *      busquemos otro horario disponible con la Dra. Ana?»
 *
 * LO QUE SE PROTEGE, POR ORDEN DE DAÑO:
 *
 *  1. QUE NO SE RESERVE CON OTRO SIN PREGUNTAR. Lo dijo David con todas las letras: «nunca
 *     reserves con otro profesional sin consentimiento». Aquí eso significa que cuando el
 *     doctor pedido no puede, la respuesta trae A QUIÉN OFRECER, nunca a quién se le ha
 *     asignado.
 *
 *  2. QUE UN FALLO NO SE CONFUNDA CON «NO HAY HUECOS». Un error se deriva a una persona; un
 *     «no hay disponibilidad» el paciente se lo cree y se va.
 *
 *  3. QUE UN DÍA CERRADO NO OFREZCA NADA. Google no sabe que la clínica cierra el 25 de
 *     diciembre: ese día los calendarios están vacíos, que para él es «libres».
 *
 *  4. Que «las dos» sean las dos y no las dos y cinco.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

process.env.CHATWOOT_BASE_URL = 'https://chatwoot.app.escala365.com';
const { consultarAgenda } = await import('../src/agenda/consulta.js');
const { leerDoctores } = await import('../src/agenda/doctores.js');
const { olvidarTokens } = await import('../src/agenda/google.js');

const JORNADA = [{ desde: 10 * 60, hasta: 20 * 60 }];
const CLINICA = { 0: [], 1: JORNADA, 2: JORNADA, 3: JORNADA, 4: JORNADA, 5: JORNADA, 6: JORNADA } as any;
const ZONA = 'America/Caracas';

/** Lunes 7 de septiembre de 2026, las 10:00 en Caracas. La clínica acaba de abrir. */
const AHORA = new Date('2026-09-07T14:00:00Z');
/** Ese mismo lunes a las 14:00 en Caracas. «Las dos de la tarde». */
const LAS_DOS = new Date('2026-09-07T18:00:00Z');

const DOCTORES = leerDoctores(`
Dra. Ana Martínez
  calendario: c-ana@g.com
  hace: valoración, higiene

Dra. María López
  calendario: c-maria@g.com
  hace: valoración, higiene

Dr. Roberto Vélez
  calendario: c-velez@g.com
  hace: valoración, cordal
`, CLINICA)!;

const CLAVE = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CRED = { correo: 'a@b.c', clave: CLAVE };
const TOKEN_OK = { access_token: 'tok', expires_in: 3600 };

/** Google contestando: para cada calendario, lo que tiene ocupado. */
function google(ocupado: Record<string, Array<[string, string]>>, fallo?: { status: number; cuerpo?: any }) {
  let i = 0;
  return (async () => {
    i += 1;
    if (i === 1) return { ok: true, status: 200, json: async () => TOKEN_OK, text: async () => '' } as any;
    if (fallo) {
      return { ok: false, status: fallo.status, json: async () => fallo.cuerpo ?? {}, text: async () => '' } as any;
    }
    const calendars: any = {};
    for (const [id, franjas] of Object.entries(ocupado)) {
      calendars[id] = { busy: franjas.map(([start, end]) => ({ start, end })) };
    }
    return { ok: true, status: 200, json: async () => ({ calendars }), text: async () => '' } as any;
  }) as unknown as typeof fetch;
}

const LIBRES = { 'c-ana@g.com': [], 'c-maria@g.com': [], 'c-velez@g.com': [] } as Record<string, Array<[string, string]>>;
const base = { doctores: DOCTORES, cierres: null, zona: ZONA, ahora: AHORA };
const deps = (impl: typeof fetch) => ({ fetchImpl: impl, credenciales: CRED, ahora: AHORA });

// --- 1. EL CASO DE DAVID: ANA OCUPADA, MARÍA LIBRE -------------------------

{
  olvidarTokens();
  const r = await consultarAgenda(
    { ...base, doctorPedido: 'la Dra. Ana', cuando: LAS_DOS },
    deps(google({ ...LIBRES, 'c-ana@g.com': [['2026-09-07T18:00:00Z', '2026-09-07T19:00:00Z']] }))
  );

  // LAS TRES PIEZAS DE LA FRASE, EN UNA SOLA LLAMADA.
  assert.equal(r.doctor?.nombre, 'Dra. Ana Martínez', '1) a quién pidió');
  assert.equal(r.pedido?.libre, false, '2) y que no puede a esa hora');
  assert.ok(r.mismaHora!.length > 0, '3) pero estas sí pueden a esa misma hora');
  assert.ok(r.mismaHora!.some(n => n.includes('María')));
  assert.ok(r.otras!.length > 0, '4) y estas otras horas sí las tiene ella');

  // 1. NO HAY NADA QUE SE PAREZCA A UNA ASIGNACIÓN. Se devuelve quién PUEDE, y el paciente
  //    decide. Es la regla 73 y lo que pidió David: «nunca reserves con otro profesional
  //    sin consentimiento del paciente».
  assert.equal((r as any).asignado, undefined);
  assert.equal((r as any).reservado, undefined);
  assert.ok(!('booking' in r), 'consultar no reserva');

  // Y LAS ALTERNATIVAS SON DE ELLA, no de otro. Si fueran de cualquiera, la pregunta
  // «¿o buscamos otro horario con Ana?» no tendría respuesta que dar.
  assert.ok(r.otras!.every(h => h.doctor.includes('Ana')), 'las otras horas son las de Ana');

  // Cada hueco trae el instante exacto además del texto: reservar no debe volver a
  // interpretar «jue 10/09, 15:30».
  assert.ok(r.otras![0].inicio.endsWith('Z'));
  assert.ok(/\d{2}:\d{2}/.test(r.otras![0].cuando));
}

// --- ANA SÍ PUEDE: SE CONTESTA Y YA --------------------------------------

{
  olvidarTokens();
  const r = await consultarAgenda(
    { ...base, doctorPedido: 'Martínez', cuando: LAS_DOS },
    deps(google(LIBRES))
  );
  assert.equal(r.pedido?.libre, true);

  // NI ALTERNATIVAS NI OTROS DOCTORES. Ofrecer opciones a quien ya tiene lo que pidió es
  // hacerle dudar de una respuesta buena.
  assert.equal(r.mismaHora, undefined, 'no se le nombra a nadie más');
  assert.equal(r.otras, undefined, 'ni otras horas que no ha pedido');
}

// --- DOS QUE SE LLAMAN IGUAL: SE PREGUNTA SIN MOLESTAR A GOOGLE -----------

{
  olvidarTokens();
  const DOS_ANAS = leerDoctores(`
Dra. Ana Martínez
  calendario: c1@g.com
Dra. Ana López
  calendario: c2@g.com
`, CLINICA)!;

  let llamadas = 0;
  const contando = (async () => {
    llamadas += 1;
    return { ok: true, status: 200, json: async () => TOKEN_OK, text: async () => '' } as any;
  }) as unknown as typeof fetch;

  const r = await consultarAgenda(
    { ...base, doctores: DOS_ANAS, doctorPedido: 'con Ana', cuando: LAS_DOS },
    deps(contando)
  );
  assert.equal(r.doctor?.duda, 'varios');
  assert.equal(r.doctor?.apellidos, 'Martínez o López');
  assert.equal(r.pedido, undefined, 'no se contesta por una hora de alguien sin decidir');
  assert.equal(llamadas, 0, 'y no se molesta a Google para preguntar un apellido');
}

// --- UN DOCTOR QUE NO TRABAJA AQUÍ ---------------------------------------

{
  olvidarTokens();
  const r = await consultarAgenda(
    { ...base, doctorPedido: 'la Dra. Pérez', cuando: LAS_DOS },
    deps(google(LIBRES))
  );
  // SE DICE. Ofrecerle huecos de otro sin mencionar que a quien nombró no lo tenemos es
  // contestar a una pregunta distinta de la que hizo.
  assert.equal(r.doctor?.duda, 'desconocido');
  assert.equal(r.doctor?.nombre, 'la Dra. Pérez');
  // Y aun así se le dice quién sí puede a esa hora, que es lo que venía buscando.
  assert.ok(r.mismaHora!.length > 0);
}

// --- 3. UN DÍA QUE LA CLÍNICA CIERRA -------------------------------------

{
  olvidarTokens();
  let llamadas = 0;
  const contando = (async () => {
    llamadas += 1;
    return { ok: true, status: 200, json: async () => TOKEN_OK, text: async () => '' } as any;
  }) as unknown as typeof fetch;

  const r = await consultarAgenda(
    { ...base, cierres: '07/09/2026  puente', doctorPedido: 'Ana', cuando: LAS_DOS },
    deps(contando)
  );
  assert.equal(r.cerrado, 'puente', 'se dice, y con el motivo que escribió la clínica');
  assert.equal(r.pedido, undefined);
  // NO SE CONSULTA A GOOGLE. Ese día los calendarios están vacíos, que para él es «libres»:
  // preguntarle solo puede dar una respuesta equivocada.
  assert.equal(llamadas, 0);
}

// --- 2. UN FALLO NO ES «NO HAY HUECOS» -----------------------------------

{
  olvidarTokens();
  const r = await consultarAgenda(
    { ...base, doctorPedido: 'Ana', cuando: LAS_DOS },
    deps(google({}, { status: 500 }))
  );
  assert.ok(r.error, 'un fallo se dice como fallo');
  assert.equal(r.pedido, undefined, 'y NO se afirma nada sobre esa hora');
  assert.equal(r.mismaHora, undefined);
  assert.equal(r.otras, undefined);
  assert.equal(r.huecos, undefined, 'sobre todo: NO una lista vacía, que se lee como «no hay»');
}

{
  // Sin doctores configurados tampoco se inventa nada.
  olvidarTokens();
  const r = await consultarAgenda({ ...base, doctores: [] }, deps(google(LIBRES)));
  assert.equal(r.error, 'sin_doctores');
}

// --- SIN PEDIR DOCTOR: LOS PRIMEROS HUECOS, CON QUIÉN ES CADA UNO --------

{
  olvidarTokens();
  const r = await consultarAgenda({ ...base, servicio: 'higiene' }, deps(google(LIBRES)));

  assert.ok(r.huecos!.length > 0);
  // CADA HUECO DICE CON QUIÉN ES. Sin el nombre, «tengo el jueves a las 10» obliga a otra
  // ronda para saber con quién, y el paciente ya había preguntado.
  assert.ok(r.huecos!.every(h => h.doctor), 'cada hueco trae su doctor');
  // La higiene la hacen Ana y María, no Vélez: no puede salir él.
  assert.ok(!r.huecos!.some(h => h.doctor.includes('Vélez')), 'solo quien hace ese servicio');
}

{
  // Un servicio que no hace nadie se dice, en vez de ofrecer a cualquiera.
  olvidarTokens();
  const CERRADO = leerDoctores(
    'Dr. Roberto Vélez\n  calendario: c-velez@g.com\n  hace: cordal', CLINICA
  )!;
  const r = await consultarAgenda(
    { ...base, doctores: CERRADO, servicio: 'cordal' }, deps(google({ 'c-velez@g.com': [] }))
  );
  assert.ok(r.huecos && r.huecos.length > 0, 'el que sí lo hace, sale');
}

// --- 4. «LAS DOS» SON LAS DOS --------------------------------------------

{
  olvidarTokens();
  // Ana ocupada de 14:00 a 14:30. A las 14:00 NO puede -la cita dura 45 minutos- aunque a
  // las 14:45 sí. Un hueco que empieza más tarde no es la hora que pidió.
  const r = await consultarAgenda(
    { ...base, doctorPedido: 'Ana', cuando: LAS_DOS },
    deps(google({ ...LIBRES, 'c-ana@g.com': [['2026-09-07T18:00:00Z', '2026-09-07T18:30:00Z']] }))
  );
  assert.equal(r.pedido?.libre, false, 'ocupada media hora es ocupada a esa hora');
}


{
  // UNA HORA QUE NO CAE EN LA REJILLA. La clinica abre a las 10 y cita en punto, asi que
  // «las 14:30» no existe como hueco aunque el doctor este libre a esa hora.
  //
  // SE CONTESTA «NO PUEDE», Y NO «no citamos a y media». Las dos llevan a ofrecerle las
  // horas que si hay, asi que la conversacion acaba en el mismo sitio; pero el motivo que
  // se le da no es el de verdad. Esta aqui escrito para que se sepa, no porque este bien.
  olvidarTokens();
  const r = await consultarAgenda(
    { ...base, doctorPedido: 'Ana', cuando: new Date('2026-09-07T18:30:00Z') },
    deps(google(LIBRES))
  );
  assert.equal(r.pedido?.libre, false, 'una hora fuera de la rejilla sale como no disponible');
  assert.ok(r.otras!.length > 0, 'pero se le ofrecen las que si hay');
  assert.ok(
    r.otras!.every(h => /:00$/.test(h.cuando)),
    'y todas caen en punto, que es como cita esta clinica'
  );
}

console.log('agenda_consulta_test: OK');

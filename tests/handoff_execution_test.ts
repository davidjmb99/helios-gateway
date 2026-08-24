import assert from 'node:assert/strict';

process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi_demo', hermes_profile: 'helios' }
});
process.env.CHATWOOT_BASE_URL = 'https://chat.example.com';
delete process.env.HELIOS_HANDOFF_ROUTING_JSON;
delete process.env.TELEGRAM_ALERT_CHAT_ID;

const { normalizeChatwootPayload } = await import('../src/chatwoot/normalizer.js');
const { resolveTenantContext } = await import('../src/tenants/context.js');
const { normalizeHandoffRequest } = await import('../src/handoff/stage.js');
const { clearHandoffRoutingCache, resolveHandoffRouting } = await import('../src/handoff/routing.js');
const servicio = await import('../src/handoff/service.js');
const {
  buildNotificationPayload,
  buildPrivateNote,
  buildSupportNote,
  resolveTransitionMessage
} = servicio;
const { renderTelegramMessage } = await import('../src/services/notification-outbox-worker.js');
const { createHandoffIdentity } = await import('../src/durable/identity.js');

clearHandoffRoutingCache();
const tenantContext = resolveTenantContext('2');

function openedHandoff(overrides: any = {}) {
  return {
    handoff_id: '3f2a1b8c-1d4e-8a6b-9c0d-1e2f3a4b5c6d',
    created: true,
    routing: resolveHandoffRouting('democoi1'),
    request: normalizeHandoffRequest({
      reason_code: 'possible_urgency',
      summary: 'Refiere hinchazón desde ayer y pide hablar con alguien.',
      treatment_interest: 'urgencias'
    }),
    destination_team_id: null,
    conversation_id: '44',
    contact_id: '13',
    inbox_id: '7',
    phone: '+34600111222',
    trace_id: 'trace-abc',
    tenantContext,
    ...overrides
  } as any;
}

const verifiedPatient = {
  first_name: 'Xavier',
  last_name: 'Mercado',
  identity_complete: true,
  crm_synced: true
};

// --- Identidad determinista del handoff --------------------------------------

const identityInput = {
  tenant_id: 'democoi1',
  account_id: '2',
  conversation_id: '44',
  contact_id: '13',
  trigger_key: 'batch-abc'
};
const first = createHandoffIdentity(identityInput);
const again = createHandoffIdentity(identityInput);
assert.equal(first.handoff_id, again.handoff_id, 'el mismo disparador da el mismo handoff_id');
assert.match(
  first.handoff_id,
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  'debe ser un UUID válido para la columna uuid de Postgres'
);
assert.notEqual(
  createHandoffIdentity({ ...identityInput, trigger_key: 'batch-otro' }).handoff_id,
  first.handoff_id,
  'otro disparador da otro handoff'
);
assert.notEqual(
  createHandoffIdentity({ ...identityInput, conversation_id: '45' }).handoff_id,
  first.handoff_id,
  'otra conversación da otro handoff'
);

// --- Nota privada: texto limpio para el equipo, sin jerga tecnica -----------

const recapEjemplo = {
  messages: [
    { role: 'patient' as const, text: 'Buenas, tengo una molestia en una muela', at: '2026-08-11T09:00:00.000Z' },
    { role: 'helios' as const, text: 'Entiendo. ¿Desde cuándo la notas?', at: '2026-08-11T09:01:00.000Z' },
    { role: 'patient' as const, text: 'Desde el lunes, prefiero hablar con alguien', at: '2026-08-11T09:02:00.000Z' }
  ],
  total_messages: 3,
  truncated: false
};

const note = buildPrivateNote(openedHandoff(), verifiedPatient);

// Lo que el equipo necesita para actuar sin leer toda la conversación.
assert.match(note, /Un paciente necesita atención humana/);
// Markdown de verdad: en Chatwoot un salto de línea suelto no llega al HTML del
// correo, así que los datos van como lista y no como líneas sueltas.
assert.match(note, /- \*\*Paciente:\*\* Xavier Mercado/, 'nombre y apellido');
assert.match(note, /- \*\*Motivo:\*\* posible urgencia/, 'el motivo en palabras, no en código');
assert.match(note, /- \*\*Prioridad:\*\* Urgente/, 'la prioridad en castellano');
assert.match(note, /- \*\*Para:\*\* Equipo De Recepción/);
assert.match(note, /- \*\*Le interesa:\*\* urgencias/);
assert.match(note, /escribe \/fin/, 'la acción requerida explica cómo devolverla');

// El resumen NO viaja en la nota de la mención. Esa es la que Chatwoot convierte
// en correo, y al correo le añade por su cuenta su bloque «Previous messages»: con
// el resumen dentro, la misma conversación llegaba dos veces.
assert.doesNotMatch(
  note,
  /Últimos mensajes de la conversación/,
  'el resumen va en su propia nota, no en la de la mención'
);
assert.doesNotMatch(note, /molestia en una muela/, 'y por tanto el correo no lo repite');

// Y lo que NO debe aparecer: nada técnico.
assert.doesNotMatch(note, /possible_urgency/, 'sin códigos internos');
assert.doesNotMatch(note, /Trace:/, 'sin trazas');
assert.doesNotMatch(note, /Alta en CRM/, 'el estado del CRM no le dice nada a quien atiende');
assert.doesNotMatch(note, /Referencia interna/, 'ni identificadores internos al final de la nota');
assert.doesNotMatch(note, /Conversación: 44/, 'el id de conversación ya lo ve en Chatwoot');
assert.doesNotMatch(note, /\+34600111222/, 'el teléfono ya lo ve en la ficha del contacto');
assert.doesNotMatch(note, /xavier@example\.com/, 'sin correo');

// --- EL RESUMEN YA NO SE PUBLICA EN CHATWOOT -------------------------------
//
// LO PIDIO DAVID el 24-ago-2026: «como manda la conversacion directa, la persona solo
// debe deslizar hacia arriba y ve esos mensajes; el contexto que le llega es como mas
// ruido visual». En Chatwoot el equipo esta mirando la conversacion, y repetirsela
// debajo en forma de lista tapaba lo unico que aporta la nota: el motivo y la prioridad.
//
// LO QUE ESTA PRUEBA PROTEGE NO ES QUE SE HAYA QUITADO, sino que NO SE HAYA PERDIDO.
// El resumen sigue haciendo falta donde NO hay conversacion que deslizar: el aviso
// externo. Quitarlo de los dos sitios a la vez es el error facil de cometer aqui, y
// dejaria a quien recibe el aviso sin saber de que va el caso.

assert.ok(
  !('buildRecapNote' in servicio),
  'buildRecapNote ya no existe: el resumen no se publica como nota en Chatwoot'
);

{
  // Y EN EL AVISO EXTERNO SIGUE ESTANDO, con los mensajes de verdad.
  const aviso = buildNotificationPayload(
    openedHandoff(),
    { first_name: 'Xavier', last_name: 'Pla', identity_complete: true, crm_synced: true },
    recapEjemplo
  ) as any;

  assert.ok(aviso.recap, 'el aviso externo lleva el resumen');
  assert.ok(
    aviso.recap.lines.some((l: string) => /molestia en una muela/.test(l)),
    'y son los mensajes reales de la conversacion'
  );
  assert.equal(aviso.recap.total_messages, recapEjemplo.total_messages);

  // Una conversacion larga sigue avisando de que hay mas de lo que se ve.
  const largo = buildNotificationPayload(
    openedHandoff(),
    { first_name: 'Xavier', last_name: 'Pla', identity_complete: true, crm_synced: true },
    { messages: recapEjemplo.messages, total_messages: 42, truncated: true }
  ) as any;
  assert.equal(largo.recap.truncated, true, 'y se dice que esta recortada');
  assert.equal(largo.recap.total_messages, 42);
}

const noteWithoutIdentity = buildPrivateNote(openedHandoff(), {
  first_name: null,
  last_name: null,
  identity_complete: false,
  crm_synced: false
});
assert.match(noteWithoutIdentity, /todavía no ha dado su nombre/);
assert.doesNotMatch(noteWithoutIdentity, /Xavier/);

// --- Mención al equipo en la nota privada -----------------------------------

const { teamMention } = await import('../src/handoff/service.js');
assert.equal(
  teamMention('3', 'reception'),
  '[@Equipo De Recepción](mention://team/3/equipo-de-recepcion)',
  'el formato es el que verifica MentionService de Chatwoot'
);
// Las preguntas clínicas y las urgencias van al mismo equipo de recepción: la
// clínica no tiene equipo clínico propio desde la reorganización del 13-08-2026.
assert.equal(teamMention('4', 'clinical_lead'), '[@Equipo De Recepción](mention://team/4/equipo-de-recepcion)');
assert.equal(teamMention(null, 'reception'), null, 'sin ID configurado no se inventa mención');
assert.equal(teamMention('   ', 'reception'), null);

const notaConEquipo = buildPrivateNote(
  openedHandoff({ destination_team_id: '3', request: normalizeHandoffRequest({ reason_code: 'human_requested' }) }),
  verifiedPatient
);
assert.match(
  notaConEquipo,
  /\[@Equipo De Recepción\]\(mention:\/\/team\/3\/equipo-de-recepcion\)/,
  'la nota menciona al equipo cuando hay ID configurado'
);
assert.doesNotMatch(note, /mention:\/\//, 'sin ID configurado la nota no lleva mención');

// --- Fallo técnico: DOS NOTAS, y recepción NO ve el detalle técnico ---------
//
// LO SEÑALO DAVID el 21-ago-2026: «cuando se hace el handoff, se pasa la misma
// información tanto a recepción humana de la clínica como al equipo técnico, eso no
// puede pasar».
//
// Antes era UNA nota que mencionaba a los dos equipos y dentro decía «Qué falló:
// ADAPTER_UNSAFE_RESPONSE en hermes.call». Está mal por dos motivos: a quien tiene
// que seguir hablando con el paciente un código de error no le dice nada y le tapa lo
// que sí necesita, y un recepcionista leyendo trazas internas delante de un paciente
// no transmite ninguna confianza en la clínica.
//
// Siguen haciendo falta los dos avisos —si solo se avisara a soporte, el paciente
// esperaría respuesta de un equipo que arregla programas; si solo a recepción, nadie
// arreglaría el fallo— pero en notas separadas y con contenido distinto.

const conFalloTecnico = openedHandoff({
  request: normalizeHandoffRequest({
    reason_code: 'operational_exception',
    // El mismo texto que escribe escalateTechnicalFailure en produccion.
    summary: 'Helios no pudo atender el mensaje: ADAPTER_UNSAFE_RESPONSE en hermes.call.'
  }, 'technical_failure'),
  destination_team_id: '2',
  support_team_id: '3'
});

const notaRecepcion = buildPrivateNote(conFalloTecnico, verifiedPatient);

// LO QUE RECEPCION SI TIENE QUE VER
assert.match(
  notaRecepcion,
  /\[@Equipo De Recepción\]\(mention:\/\/team\/2\/[^)]+\) — sigue tú la conversación/,
  'recepción sigue con el paciente, y se le dice explícitamente'
);
assert.match(
  notaRecepcion,
  /El paciente ya ha recibido un aviso/,
  'y consta que al paciente ya se le ha dicho algo: no se queda callado'
);
assert.match(notaRecepcion, /Soporte ya está avisado/, 'y que el fallo no se está ignorando');
assert.match(notaRecepcion, /escribe \/fin/, 'y el retorno se explica igual que siempre');

// LO QUE RECEPCION NO PUEDE VER. Esta es la razón de ser del cambio.
assert.doesNotMatch(
  notaRecepcion, /ADAPTER_UNSAFE_RESPONSE/,
  'el código de error NO va en la nota de recepción'
);
assert.doesNotMatch(
  notaRecepcion, /hermes\.call/,
  'ni la etapa interna donde se rompió'
);
assert.doesNotMatch(
  notaRecepcion, /Qué falló/,
  'ni el epígrafe del detalle técnico'
);
assert.doesNotMatch(
  notaRecepcion, /operational_exception/,
  'ni el código de motivo, que tampoco significa nada para quien atiende'
);
assert.doesNotMatch(
  notaRecepcion, /mention:\/\/team\/3\//,
  'y no se menciona a soporte en la nota de recepción: su aviso va aparte'
);

// LA NOTA DE SOPORTE, que es donde SI va el detalle.
const notaSoporte = buildSupportNote(conFalloTecnico);
assert.ok(notaSoporte, 'con equipo de soporte configurado tiene que haber nota');
assert.match(
  notaSoporte!,
  /\[@Soporte Técnico Helios\]\(mention:\/\/team\/3\/[^)]+\) — revisad el error/,
  'soporte se entera para arreglarlo, sin quedarse la conversación'
);
assert.match(notaSoporte!, /ADAPTER_UNSAFE_RESPONSE/, 'y aquí SÍ va lo que falló');
assert.match(notaSoporte!, /contract_debug/, 'con el puntero a donde está el detalle completo');
assert.match(
  notaSoporte!, /Recepción ya está siguiendo la conversación/,
  'y soporte sabe que el paciente no está desatendido, para no correr sin motivo'
);

// Sin equipo de soporte configurado no hay nota de soporte, y recepción sigue
// avisada: es lo que impide que el paciente se quede sin nadie.
const sinSoporte = openedHandoff({
  request: normalizeHandoffRequest({
    reason_code: 'operational_exception',
    summary: 'Helios no pudo atender el mensaje: ADAPTER_UNSAFE_RESPONSE en hermes.call.'
  }, 'technical_failure'),
  destination_team_id: '2',
  support_team_id: null
});
assert.equal(buildSupportNote(sinSoporte), null, 'sin equipo de soporte no se crea la nota');
assert.match(buildPrivateNote(sinSoporte, verifiedPatient), /sigue tú la conversación/,
  'pero recepción sigue avisada, que es lo que no puede faltar');
assert.doesNotMatch(
  buildPrivateNote(sinSoporte, verifiedPatient), /ADAPTER_UNSAFE_RESPONSE/,
  'y el detalle NO se cuela en la nota de recepción por no haber soporte'
);

// Y en una derivación NORMAL no hay nota de soporte que valga.
assert.equal(
  buildSupportNote(openedHandoff({ destination_team_id: '2', support_team_id: '3' })),
  null,
  'una derivación normal no es un fallo técnico: no se molesta a soporte'
);

// --- Alerta al equipo -------------------------------------------------------

const payload = buildNotificationPayload(openedHandoff(), verifiedPatient);
assert.equal(payload.kind, 'handoff_created');
assert.equal(payload.priority, 'urgent');
assert.equal(payload.destination, 'clinical_lead');
assert.equal(payload.patient_first_name, 'Xavier');
assert.equal(
  payload.conversation_url,
  'https://chat.example.com/app/accounts/2/conversations/44',
  'la alerta lleva enlace directo a la conversación'
);
const serializedPayload = JSON.stringify(payload);
assert.doesNotMatch(serializedPayload, /\+34600111222/, 'la alerta no lleva el teléfono');
assert.match(String(payload.patient_full_name), /Xavier Mercado/, 'el equipo necesita nombre y apellido');

const anonymousPayload = buildNotificationPayload(openedHandoff(), {
  first_name: 'Xavier',
  last_name: null,
  identity_complete: false,
  crm_synced: false
});
assert.equal(
  anonymousPayload.patient_first_name,
  null,
  'sin identidad verificada no se envía ningún nombre'
);

// --- Texto del aviso de Telegram --------------------------------------------

const telegram = renderTelegramMessage(payload as any);
assert.match(telegram, /Un paciente necesita atención humana/);
assert.match(telegram, /🔴 URGENTE/);
assert.match(telegram, /Xavier/);
assert.match(telegram, /https:\/\/chat\.example\.com\/app\/accounts\/2\/conversations\/44/);
assert.doesNotMatch(telegram, /undefined/, 'ningún campo se renderiza como undefined');

const technicalTelegram = renderTelegramMessage(
  buildNotificationPayload(
    openedHandoff({
      request: normalizeHandoffRequest({ reason_code: 'operational_exception' }, 'technical_failure')
    }),
    { first_name: null, last_name: null, identity_complete: false, crm_synced: false }
  ) as any
);
assert.match(technicalTelegram, /Helios no ha podido atender un mensaje/);
assert.match(technicalTelegram, /todavía no ha dado su nombre/);
assert.doesNotMatch(technicalTelegram, /undefined/);

// --- Mensaje de transición --------------------------------------------------

assert.equal(
  resolveTransitionMessage('democoi1', 'Te paso con Ana del equipo.'),
  'Te paso con Ana del equipo.',
  'el mensaje del modelo se conserva literal'
);
assert.match(
  resolveTransitionMessage('democoi1', '   '),
  /persona del equipo/,
  'sin mensaje del modelo se usa la plantilla'
);

process.env.HELIOS_HANDOFF_ROUTING_JSON = JSON.stringify({
  democoi1: { transition_message: 'Recepción te contesta enseguida.' }
});
clearHandoffRoutingCache();
assert.equal(
  resolveTransitionMessage('democoi1', null),
  'Recepción te contesta enseguida.',
  'la plantilla del tenant gana sobre la global'
);
delete process.env.HELIOS_HANDOFF_ROUTING_JSON;
clearHandoffRoutingCache();

// --- Captura de mensajes del equipo humano ---------------------------------

function conversationPayload(extra: any = {}) {
  return {
    event: 'message_created',
    account: { id: 2 },
    conversation: { id: 44, contact_inbox: { contact_id: '13' }, inbox_id: '7' },
    id: 'msg-1',
    content: 'Hola, soy Ana de la clínica.',
    created_at: '2026-08-07T18:00:00.000Z',
    ...extra
  };
}

const agentMessage = normalizeChatwootPayload(conversationPayload({
  message_type: 'outgoing',
  sender: { id: '99', type: 'user', name: 'Ana' }
}));
assert.equal(agentMessage.direction, 'outgoing');
assert.equal(agentMessage.should_process, false, 'no puede llegar a la IA');
assert.equal(agentMessage.human_agent_candidate, true, 'sí debe quedar registrado');

const privateNote = normalizeChatwootPayload(conversationPayload({
  message_type: 'outgoing',
  private: true,
  sender: { id: '99', type: 'user' }
}));
assert.equal(privateNote.is_private, true);
assert.equal(
  privateNote.human_agent_candidate,
  false,
  'la nota privada del propio handoff no puede confundirse con un mensaje del equipo'
);

const activityMessage = normalizeChatwootPayload(conversationPayload({
  message_type: 'activity',
  content: 'Conversación asignada a Ana',
  sender: { id: '99', type: 'user' }
}));
assert.equal(
  activityMessage.human_agent_candidate,
  false,
  'los eventos de actividad de Chatwoot no son mensajes del equipo'
);

const botMessage = normalizeChatwootPayload(conversationPayload({
  message_type: 'outgoing',
  sender: { id: '5', type: 'agent_bot' }
}));
assert.equal(botMessage.human_agent_candidate, false, 'el agent bot no es una persona');

const patientMessage = normalizeChatwootPayload(conversationPayload({
  message_type: 'incoming',
  sender: { id: '13', type: 'contact', phone_number: '+34600111222' }
}));
assert.equal(patientMessage.direction, 'incoming');
assert.equal(patientMessage.should_process, true);
assert.equal(patientMessage.human_agent_candidate, false, 'un entrante no es un mensaje del equipo');

const emptyOutgoing = normalizeChatwootPayload(conversationPayload({
  message_type: 'outgoing',
  content: '   ',
  sender: { id: '99', type: 'user' }
}));
assert.equal(emptyOutgoing.human_agent_candidate, false, 'un saliente vacío no se guarda');

console.log('handoff_execution_test: PASS');

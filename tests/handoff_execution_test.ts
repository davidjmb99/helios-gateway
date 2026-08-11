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
const {
  buildNotificationPayload,
  buildPrivateNote,
  resolveTransitionMessage
} = await import('../src/handoff/service.js');
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

// --- Nota privada (ítem 20) --------------------------------------------------

const note = buildPrivateNote(openedHandoff(), verifiedPatient);
assert.match(note, /possible_urgency/, 'incluye el reason code');
assert.match(note, /Prioridad: urgent/);
assert.match(note, /Responsable Clínico/, 'el destino aparece en lenguaje del equipo');
assert.match(note, /hinchazón desde ayer/, 'incluye el resumen');
assert.match(note, /Xavier Mercado/, 'identidad verificada');
assert.match(note, /Alta en CRM: sí/);
assert.match(note, /Acción requerida:/);
assert.match(note, /Helios Case ID: 3f2a1b8c/);
assert.match(note, /Conversación: 44/);
assert.match(note, /Trace: trace-abc/);
assert.doesNotMatch(note, /\+34600111222/, 'la nota no repite el teléfono: Chatwoot ya muestra el contacto');
assert.doesNotMatch(note, /@/, 'la nota no incluye correo');

const noteWithoutIdentity = buildPrivateNote(openedHandoff(), {
  first_name: null,
  last_name: null,
  identity_complete: false,
  crm_synced: false
});
assert.match(noteWithoutIdentity, /identidad incompleta/);
assert.match(noteWithoutIdentity, /Alta en CRM: no/);
assert.doesNotMatch(noteWithoutIdentity, /Xavier/);

// --- Mención al equipo en la nota privada -----------------------------------

const { teamMention } = await import('../src/handoff/service.js');
assert.equal(
  teamMention('3', 'reception'),
  '[@Recepción Clínica](mention://team/3/recepcion-clinica)',
  'el formato es el que verifica MentionService de Chatwoot'
);
assert.equal(teamMention('4', 'clinical_lead'), '[@Responsable Clínico](mention://team/4/responsable-clinico)');
assert.equal(teamMention(null, 'reception'), null, 'sin ID configurado no se inventa mención');
assert.equal(teamMention('   ', 'reception'), null);

const notaConEquipo = buildPrivateNote(
  openedHandoff({ destination_team_id: '3', request: normalizeHandoffRequest({ reason_code: 'human_requested' }) }),
  verifiedPatient
);
assert.match(
  notaConEquipo,
  /\[@Recepción Clínica\]\(mention:\/\/team\/3\/recepcion-clinica\)/,
  'la nota menciona al equipo cuando hay ID configurado'
);
assert.doesNotMatch(note, /mention:\/\//, 'sin ID configurado la nota no lleva mención');

const technicalNote = buildPrivateNote(
  openedHandoff({
    request: normalizeHandoffRequest({ reason_code: 'operational_exception' }, 'technical_failure')
  }),
  verifiedPatient
);
assert.match(technicalNote, /Soporte Helios/);
assert.match(technicalNote, /avisar a Soporte Helios/, 'la acción requerida cambia en un fallo técnico');

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
assert.doesNotMatch(serializedPayload, /Mercado/, 'la alerta lleva solo el nombre de pila');

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
assert.match(telegram, /Helios ha derivado una conversación/);
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
assert.match(technicalTelegram, /Helios no pudo atender un mensaje/);
assert.match(technicalTelegram, /paciente sin identificar/);
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

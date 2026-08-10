import assert from 'node:assert/strict';

process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi_demo', hermes_profile: 'helios' }
});
process.env.HELIOS_HANDOFF_ROUTING_JSON = JSON.stringify({
  democoi1: { teams: { reception: '3', clinical_lead: '4', helios_support: '5' } }
});

const {
  interpretSignal,
  isSupportTeam,
  parseConversationSignal,
  planSignalAction
} = await import('../src/handoff/signals.js');
const { clearHandoffRoutingCache, resolveHandoffRouting } = await import('../src/handoff/routing.js');

clearHandoffRoutingCache();
const routing = resolveHandoffRouting('democoi1');

/** Payload real de conversation_updated: labels, status, priority y meta.team en la raíz. */
function conversationUpdated(extra: any = {}) {
  return {
    event: 'conversation_updated',
    account: { id: 2 },
    id: 44,
    inbox_id: 7,
    status: 'open',
    priority: null,
    labels: [],
    contact_inbox: { contact_id: '13', source_id: '34600111222' },
    meta: {
      sender: { id: 13, phone_number: '+34600111222' },
      assignee: { id: 99 },
      team: null
    },
    custom_attributes: {},
    snoozed_until: null,
    ...extra
  };
}

// --- Lectura del payload ----------------------------------------------------

const parsed = parseConversationSignal(conversationUpdated({
  labels: ['helios-en-curso', 'presupuesto'],
  status: 'open',
  priority: 'high',
  meta: {
    sender: { id: 13, phone_number: '+34600111222' },
    assignee: { id: 99 },
    team: { id: 4, name: 'Responsable Clínico' }
  }
}));
assert.equal(parsed.account_id, '2');
assert.equal(parsed.conversation_id, '44', 'el id de la conversación va en la raíz del payload');
assert.equal(parsed.contact_id, '13');
assert.equal(parsed.inbox_id, '7');
assert.equal(parsed.phone, '+34600111222');
assert.deepEqual(parsed.labels, ['helios-en-curso', 'presupuesto']);
assert.equal(parsed.status, 'open');
assert.equal(parsed.priority, 'high');
assert.equal(parsed.team_id, '4');
assert.equal(parsed.team_name, 'Responsable Clínico');
assert.equal(parsed.assignee_id, '99');

const withoutPlus = parseConversationSignal(conversationUpdated({
  meta: { sender: { phone_number: '34600111222' } }
}));
assert.equal(withoutPlus.phone, '+34600111222', 'el teléfono se normaliza a E.164');

// --- Identificación de Soporte Helios ---------------------------------------

assert.equal(
  isSupportTeam(parseConversationSignal(conversationUpdated({
    meta: { team: { id: 5, name: 'Cualquier cosa' } }
  })), routing),
  true,
  'reconoce el equipo por el ID configurado'
);
assert.equal(
  isSupportTeam(parseConversationSignal(conversationUpdated({
    meta: { team: { id: 77, name: 'Soporte Helios' } }
  })), routing),
  true,
  'reconoce el equipo por nombre si el ID no está configurado'
);
assert.equal(
  isSupportTeam(parseConversationSignal(conversationUpdated({
    meta: { team: { id: 3, name: 'Recepción Clínica' } }
  })), routing),
  false
);

// --- Traducción de señales (ítem 21) ----------------------------------------

function interpret(extra: any, currentStage: any = 'human_queue') {
  return interpretSignal(parseConversationSignal(conversationUpdated(extra)), routing, currentStage);
}

assert.equal(interpret({ labels: ['helios-nuevo'] }, 'handoff_requested').target, 'human_queue');
assert.equal(interpret({ labels: ['helios-en-curso'] }).target, 'human_active');
assert.equal(interpret({ labels: ['helios-escalado'] }).target, 'human_queue');
assert.equal(interpret({ labels: ['helios-retorno-solicitado'] }).target, 'return_requested');

assert.equal(
  interpret({ labels: ['helios-en-curso'], status: 'snoozed' }).target,
  'waiting_patient',
  'snoozed con la conversación en curso es espera del paciente'
);
assert.equal(
  interpret({ labels: ['helios-en-curso'], status: 'pending' }).target,
  'waiting_patient'
);

assert.equal(
  interpret({
    labels: ['urgente'],
    meta: { team: { id: 5, name: 'Soporte Helios' } }
  }).target,
  'handoff_failed',
  'urgente + Soporte Helios es un handoff fallido'
);
assert.equal(
  interpret({ labels: ['urgente'], meta: { team: { id: 3, name: 'Recepción Clínica' } } }).target,
  null,
  'urgente sin Soporte Helios no significa handoff fallido'
);

assert.equal(
  interpret({ labels: ['helios-retorno-solicitado', 'helios-en-curso'] }).target,
  'return_requested',
  'la petición de retorno tiene prioridad sobre la etiqueta de en curso'
);

// --- El retorno de Helios no puede volver a bloquear la conversación --------

const afterReturn = interpret({ labels: [], status: 'pending' }, 'bot_active');
assert.equal(
  afterReturn.target,
  null,
  'el propio retorno deja la conversación en pending sin etiquetas: no debe reinterpretarse'
);
assert.equal(afterReturn.reason, 'no_helios_signal');

assert.equal(
  interpret({ labels: [], status: 'resolved' }, 'bot_active').target,
  null,
  'resolver una conversación que ya era del bot no cambia nada'
);
assert.equal(
  interpret({ labels: [], status: 'resolved' }, 'human_active').target,
  'closed',
  'el equipo resuelve la conversación y el episodio se cierra'
);

// --- Plan de acción (ítem 22) -----------------------------------------------

assert.deepEqual(
  planSignalAction({ target: 'return_requested', reason: 'label_return_requested' }, 'human_active'),
  { kind: 'return_to_bot', reason: 'label_return_requested' }
);
assert.deepEqual(
  planSignalAction({ target: 'return_requested', reason: 'label_return_requested' }, 'waiting_patient'),
  { kind: 'return_to_bot', reason: 'label_return_requested' }
);
assert.deepEqual(
  planSignalAction({ target: 'return_requested', reason: 'label_return_requested' }, 'return_requested'),
  { kind: 'return_to_bot', reason: 'label_return_requested' },
  'repetir la macro de retorno es idempotente'
);

const rejectedReturn = planSignalAction(
  { target: 'return_requested', reason: 'label_return_requested' },
  'human_queue'
);
assert.equal(rejectedReturn.kind, 'rejected');
assert.equal(
  (rejectedReturn as any).reason,
  'return_only_from_human_active_or_waiting_patient',
  'solo se vuelve al bot desde human_active o waiting_patient'
);

assert.deepEqual(
  planSignalAction({ target: 'human_active', reason: 'label_active' }, 'human_active'),
  { kind: 'none', reason: 'already_in_target_stage' },
  'tres webhooks duplicados producen un solo cambio de estado'
);

assert.deepEqual(
  planSignalAction({ target: null, reason: 'no_helios_signal' }, 'bot_active'),
  { kind: 'none', reason: 'no_helios_signal' }
);

const setStage = planSignalAction({ target: 'human_active', reason: 'label_active' }, 'human_queue');
assert.equal(setStage.kind, 'set_stage');
assert.equal((setStage as any).stage, 'human_active');

const invalid = planSignalAction({ target: 'human_active', reason: 'label_active' }, 'bot_active');
assert.equal(
  invalid.kind,
  'rejected',
  'no se puede pasar a human_active sin que exista un handoff registrado'
);
assert.equal((invalid as any).reason, 'invalid_transition');

// --- Etiquetas configurables por tenant -------------------------------------

process.env.HELIOS_HANDOFF_ROUTING_JSON = JSON.stringify({
  democoi1: {
    teams: { helios_support: '5' },
    labels: { active: 'atendiendo-persona' }
  }
});
clearHandoffRoutingCache();
const customRouting = resolveHandoffRouting('democoi1');
assert.equal(
  interpretSignal(
    parseConversationSignal(conversationUpdated({ labels: ['atendiendo-persona'] })),
    customRouting,
    'human_queue'
  ).target,
  'human_active',
  'la etiqueta configurada por el tenant es la que manda'
);
assert.equal(
  interpretSignal(
    parseConversationSignal(conversationUpdated({ labels: ['helios-en-curso'] })),
    customRouting,
    'human_queue'
  ).target,
  null,
  'con etiqueta personalizada, la de por defecto deja de tener efecto'
);

console.log('handoff_signals_test: PASS');

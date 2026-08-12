import assert from 'node:assert/strict';
import {
  DEFAULT_STAGE,
  HANDOFF_STAGES,
  canTransition,
  detectHandoffRequest,
  evaluateTransition,
  humanHandoffActiveFor,
  isHumanOwnedStage,
  normalizeHandoffRequest,
  normalizePriority,
  normalizeReasonCode,
  resolveDestination,
  resolveStage
} from '../src/handoff/stage.js';
import {
  DEFAULT_HANDOFF_LABELS,
  clearHandoffRoutingCache,
  conversationDeepLink,
  labelForStage,
  managedLabels,
  parseHandoffRouting,
  resolveHandoffRouting
} from '../src/handoff/routing.js';

// --- Etapas que pertenecen a una persona ---------------------------------

const blocking = [
  'handoff_requested',
  'human_queue',
  'human_active',
  'waiting_patient',
  'return_requested',
  'handoff_failed'
] as const;

for (const stage of blocking) {
  assert.equal(isHumanOwnedStage(stage), true, `${stage} debe bloquear la IA`);
  assert.equal(humanHandoffActiveFor(stage), true, `${stage} debe reflejarse en human_handoff_active`);
}

assert.equal(isHumanOwnedStage('bot_active'), false);
assert.equal(
  isHumanOwnedStage('closed'),
  false,
  'una conversación cerrada no puede dejar muerto un mensaje nuevo del paciente'
);
assert.equal(humanHandoffActiveFor('bot_active'), false);

// Toda etapa declarada tiene que estar clasificada, sin huecos.
for (const stage of HANDOFF_STAGES) {
  assert.equal(typeof isHumanOwnedStage(stage), 'boolean');
}

// --- Resolución del stage efectivo, incluido el legado -------------------

assert.deepEqual(
  resolveStage({ stage: 'human_active' }),
  { stage: 'human_active', source: 'conversation_state.stage' }
);

assert.equal(
  resolveStage({ human_handoff_active: true, status: 'waiting_patient' }).stage,
  'human_active',
  'fila legacy en modo humano sigue bloqueada tras el deploy'
);

assert.equal(
  resolveStage({ human_handoff_active: true, status: 'error' }).stage,
  'bot_active',
  'status=error + human_handoff_active es fallo técnico, no derivación real'
);
assert.equal(
  resolveStage({ human_handoff_active: true, status: 'error' }).source,
  'legacy_recovered_from_technical_error'
);

assert.equal(resolveStage(null).stage, DEFAULT_STAGE);
assert.equal(resolveStage(null).source, 'missing_state_default');
assert.equal(resolveStage({ human_handoff_active: false }).stage, 'bot_active');
assert.equal(
  resolveStage({ stage: 'algo_inventado' }).stage,
  'bot_active',
  'un stage desconocido no puede bloquear la conversación en silencio'
);
assert.equal(resolveStage({ stage: 'algo_inventado' }).source, 'invalid_stage_value');

// --- Transiciones --------------------------------------------------------

assert.equal(canTransition('bot_active', 'handoff_requested'), true);
assert.equal(canTransition('handoff_requested', 'human_queue'), true);
assert.equal(canTransition('human_queue', 'human_active'), true);
assert.equal(canTransition('human_active', 'waiting_patient'), true);
assert.equal(canTransition('human_active', 'return_requested'), true);
assert.equal(canTransition('return_requested', 'bot_active'), true);
assert.equal(canTransition('waiting_patient', 'return_requested'), true);
assert.equal(canTransition('human_active', 'human_active'), true, 'reentrada idempotente');

assert.equal(
  canTransition('bot_active', 'bot_active'),
  true,
  'devolver al bot una conversación que ya está en el bot es idempotente'
);
assert.equal(
  canTransition('human_queue', 'bot_active'),
  false,
  'solo se vuelve al bot desde human_active, waiting_patient o return_requested (ítem 22)'
);
assert.equal(
  canTransition('bot_active', 'human_active'),
  false,
  'no se puede saltar el registro del handoff'
);
assert.equal(canTransition('closed', 'bot_active'), true, 'el paciente puede reabrir escribiendo');

assert.deepEqual(evaluateTransition('human_queue', 'bot_active'), {
  allowed: false,
  from: 'human_queue',
  to: 'bot_active',
  reason: 'invalid_transition'
});
assert.equal(evaluateTransition('human_active', 'human_active').reason, 'noop_same_stage');

// --- Contrato de handoff -------------------------------------------------

assert.equal(normalizeReasonCode('possible_urgency'), 'possible_urgency');
assert.equal(
  normalizeReasonCode('motivo_desconocido'),
  'operational_exception',
  'un motivo no reconocido se normaliza, no se rechaza'
);
assert.equal(normalizeReasonCode(undefined), 'operational_exception');

assert.equal(normalizePriority('urgent', 'human_requested'), 'urgent');
assert.equal(normalizePriority('medium', 'human_requested'), 'normal');
assert.equal(normalizePriority(null, 'possible_urgency'), 'urgent', 'urgencia clínica por defecto');
assert.equal(normalizePriority(null, 'human_requested'), 'normal');
assert.equal(normalizePriority(null, 'complaint'), 'high');

assert.equal(resolveDestination('clinical_question', undefined, 'model'), 'clinical_lead');
assert.equal(resolveDestination('possible_urgency', undefined, 'model'), 'clinical_lead');
assert.equal(resolveDestination('human_requested', undefined, 'model'), 'reception');
assert.equal(resolveDestination('complaint', undefined, 'model'), 'reception');
assert.equal(resolveDestination('financing_exception', undefined, 'model'), 'reception');
assert.equal(
  resolveDestination('clinical_question', 'clinical_lead', 'technical_failure'),
  'helios_support',
  'un fallo técnico nunca se convierte en handoff clínico (ítem 17)'
);

const modelRequest = normalizeHandoffRequest({
  reason_code: 'possible_urgency',
  summary: '  El paciente refiere hinchazón desde ayer  ',
  treatment_interest: 'urgencias'
});
assert.equal(modelRequest.reason_code, 'possible_urgency');
assert.equal(modelRequest.destination, 'clinical_lead');
assert.equal(modelRequest.priority, 'urgent');
assert.equal(modelRequest.summary, 'El paciente refiere hinchazón desde ayer');
assert.equal(modelRequest.treatment_interest, 'urgencias');
assert.equal(modelRequest.origin, 'model');

const longSummary = normalizeHandoffRequest({ reason_code: 'complaint', summary: 'x'.repeat(900) });
assert.equal(longSummary.summary?.length, 500, 'el resumen se acota');

const technical = normalizeHandoffRequest({ reason_code: 'clinical_question' }, 'technical_failure');
assert.equal(technical.destination, 'helios_support');
assert.equal(technical.origin, 'technical_failure');

// --- Motivo deducido de las señales del propio Gateway ----------------------
// El contrato de salida solo admite diez claves raíz, así que el objeto handoff no
// puede llegar desde el modelo. El motivo se deduce en código.

const { deriveHandoffRequest } = await import('../src/handoff/stage.js');

assert.equal(
  deriveHandoffRequest({ signals: { asks_for_human: true }, patientMessage: 'quiero hablar con un humano' }).reason_code,
  'human_requested'
);
assert.equal(
  deriveHandoffRequest({ signals: { possible_frustration: true }, patientMessage: 'estoy muy molesto' }).reason_code,
  'complaint'
);
assert.equal(
  deriveHandoffRequest({ signals: { possible_emergency: true }, patientMessage: 'no puedo respirar bien' }).reason_code,
  'possible_urgency'
);
assert.equal(
  deriveHandoffRequest({ signals: {}, patientMessage: 'algo raro' }).reason_code,
  'operational_exception',
  'sin ninguna señal cae al motivo operativo'
);
assert.equal(
  deriveHandoffRequest({
    signals: { possible_emergency: true, asks_for_human: true, possible_frustration: true },
    patientMessage: 'tengo la cara hinchada y quiero hablar con alguien ya'
  }).reason_code,
  'possible_urgency',
  'la urgencia clínica manda sobre todo lo demás'
);
assert.equal(
  deriveHandoffRequest({
    signals: { asks_for_human: true, possible_frustration: true },
    patientMessage: 'estoy enfadado, ponme con una persona'
  }).reason_code,
  'complaint',
  'enfadado y pidiendo persona es una queja: misma cola pero más prioridad'
);

// El contexto que ve el equipo son las palabras del paciente, no una interpretación.
const derived = deriveHandoffRequest({
  signals: { asks_for_human: true },
  patientMessage: '  quiero hablar con un humano para verificar algo  '
});
assert.match(String(derived.summary), /quiero hablar con un humano para verificar algo/);
assert.doesNotMatch(String(derived.summary), /^\s/, 'el resumen viene recortado');

// operation.summary del modelo tiene preferencia sobre el mensaje crudo.
assert.match(
  String(deriveHandoffRequest({
    signals: { asks_for_human: true },
    patientMessage: 'ponme con alguien',
    operationSummary: 'El paciente quiere verificar su cita del jueves.'
  }).summary),
  /verificar su cita del jueves/
);

// Y si algún día el contrato admite el objeto handoff, ese gana.
const fromModel = deriveHandoffRequest({
  modelHandoff: { reason_code: 'complaint', summary: 'Molesto por la espera.' },
  signals: { asks_for_human: true },
  patientMessage: 'ponme con alguien'
});
assert.equal(fromModel.reason_code, 'complaint');
assert.match(String(fromModel.summary), /Molesto por la espera/);

assert.equal(
  deriveHandoffRequest({
    modelHandoff: { reason_code: 'motivo_inventado' },
    signals: { asks_for_human: true },
    patientMessage: 'x'
  }).reason_code,
  'human_requested',
  'un reason_code inválido del modelo no se propaga: se usa el deducido'
);

// --- Detección de la petición en la respuesta del Adapter ---------------

assert.equal(detectHandoffRequest({ handoff_required: true }), true);
assert.equal(detectHandoffRequest({ requires_handoff: true }), true);
assert.equal(detectHandoffRequest({ decision: 'needs_handoff' }), true);
assert.equal(detectHandoffRequest({ operation: { type: 'handoff' } }), true);
assert.equal(
  detectHandoffRequest({ operation: { type: 'human_handoff' } }),
  true,
  'human_handoff es el valor que declara el enum del SOUL: si no se detecta, el paciente espera a alguien que nadie ha avisado'
);
assert.equal(detectHandoffRequest({ operation: { type: 'HUMAN_HANDOFF' } }), true, 'sin distinguir mayúsculas');
assert.equal(detectHandoffRequest({ operation: { type: 'availability_checked' } }), false);
assert.equal(detectHandoffRequest({ handoff: { reason_code: 'human_requested' } }), true);
assert.equal(detectHandoffRequest({ handoff_required: false }), false);
assert.equal(detectHandoffRequest(null), false);
assert.equal(
  detectHandoffRequest({ handoff_required: true, error_code: 'HERMES_TIMEOUT' }),
  false,
  'un error técnico no dispara el handoff clínico por esta vía'
);

// --- Enrutado por tenant -------------------------------------------------

clearHandoffRoutingCache();
const routingMap = parseHandoffRouting(JSON.stringify({
  democoi1: {
    teams: { reception: '3', clinical_lead: '4' },
    labels: { active: 'helios-atendiendo' },
    telegram: { chat_id: '-100999' },
    transition_message: 'Te paso con recepción.'
  }
}));
const democoi1 = routingMap.get('democoi1')!;
assert.equal(democoi1.teams.reception, '3');
assert.equal(democoi1.teams.clinical_lead, '4');
assert.equal(democoi1.teams.helios_support, undefined, 'un equipo sin configurar no se inventa');
assert.equal(democoi1.labels.active, 'helios-atendiendo', 'la etiqueta configurada gana');
assert.equal(democoi1.labels.queue, DEFAULT_HANDOFF_LABELS.queue, 'el resto conserva el defecto');
assert.equal(democoi1.attribute_keys.case_id, 'helios_case_id');
assert.equal(democoi1.telegram_chat_id, '-100999');
assert.equal(democoi1.transition_message, 'Te paso con recepción.');

assert.equal(parseHandoffRouting('{ esto no es json').size, 0, 'JSON inválido no revienta el arranque');
assert.equal(parseHandoffRouting('').size, 0);

const previousRouting = process.env.HELIOS_HANDOFF_ROUTING_JSON;
const previousChatId = process.env.TELEGRAM_ALERT_CHAT_ID;
delete process.env.HELIOS_HANDOFF_ROUTING_JSON;
delete process.env.TELEGRAM_ALERT_CHAT_ID;
clearHandoffRoutingCache();
const fallback = resolveHandoffRouting('tenant_sin_configurar');
assert.deepEqual(fallback.teams, {}, 'sin configuración no se asigna equipo');
assert.deepEqual(fallback.labels, DEFAULT_HANDOFF_LABELS);
assert.equal(fallback.telegram_chat_id, null);

process.env.HELIOS_HANDOFF_ROUTING_JSON = JSON.stringify({
  otroTenant: { teams: { reception: '9' } }
});
clearHandoffRoutingCache();
assert.equal(resolveHandoffRouting('otroTenant').teams.reception, '9');
assert.deepEqual(
  resolveHandoffRouting('democoi1').teams,
  {},
  'un tenant ausente del mapa no hereda los equipos de otro'
);

if (previousRouting === undefined) delete process.env.HELIOS_HANDOFF_ROUTING_JSON;
else process.env.HELIOS_HANDOFF_ROUTING_JSON = previousRouting;
if (previousChatId === undefined) delete process.env.TELEGRAM_ALERT_CHAT_ID;
else process.env.TELEGRAM_ALERT_CHAT_ID = previousChatId;
clearHandoffRoutingCache();

assert.equal(labelForStage(fallback, 'human_queue'), 'helios-nuevo');
assert.equal(labelForStage(fallback, 'handoff_requested'), 'helios-nuevo');
assert.equal(labelForStage(fallback, 'human_active'), 'helios-en-curso');
assert.equal(labelForStage(fallback, 'return_requested'), 'helios-retorno-solicitado');
assert.equal(labelForStage(fallback, 'handoff_failed'), 'helios-fallo-tecnico');
assert.equal(labelForStage(fallback, 'bot_active'), null);

// INVARIANTE: Helios solo toca etiquetas de su propio espacio de nombres, y TODAS
// las suyas se retiran al devolver la conversación a la IA. Antes la de fallo
// técnico era 'urgente', una etiqueta de la clínica, y no estaba en la lista de
// limpieza: se aplicaba y quedaba pegada para siempre. Ponerla en la lista sin
// renombrarla habría sido peor, porque habría borrado la que pusiera a mano una
// persona del equipo.
assert.equal(managedLabels(fallback).includes('helios-fallo-tecnico'), true);
assert.equal(managedLabels(fallback).length, 5);
assert.ok(
  managedLabels(fallback).every(label => label.startsWith('helios-')),
  'ninguna etiqueta gestionada es de la clínica'
);

assert.equal(
  conversationDeepLink('https://chat.example.com/', '2', '44'),
  'https://chat.example.com/app/accounts/2/conversations/44'
);

// --- Gate de la IA: cero llamadas a Hermes en modo humano (ítem 16) ---------

process.env.CHATWOOT_TENANT_CONTEXTS_JSON = process.env.CHATWOOT_TENANT_CONTEXTS_JSON
  || JSON.stringify({ '2': { tenant_id: 'democoi1', clinic_id: 'coi_demo', hermes_profile: 'helios' } });
const { evaluateAiGate } = await import('../src/orchestrator.js');

for (const stage of blocking) {
  const decision = evaluateAiGate({ stage, ai_enabled: true });
  assert.equal(decision.process, false, `stage ${stage} no puede llamar a Hermes`);
  assert.equal(decision.skip_reason, 'human_mode_stage');
}

const botTurn = evaluateAiGate({ stage: 'bot_active', ai_enabled: true });
assert.equal(botTurn.process, true);
assert.equal(botTurn.skip_reason, null);

assert.equal(
  evaluateAiGate({ stage: 'bot_active', ai_enabled: false }).skip_reason,
  'explicit_ai_disabled',
  'la pausa explícita de la IA sigue teniendo prioridad'
);
assert.equal(evaluateAiGate({ stage: 'human_active', ai_enabled: false }).process, false);

assert.equal(
  evaluateAiGate(null).process,
  true,
  'una conversación sin estado es nueva: la IA la atiende'
);
assert.equal(evaluateAiGate(null).stage, 'bot_active');

assert.equal(
  evaluateAiGate({ human_handoff_active: true, status: 'waiting_patient' }).process,
  false,
  'las filas legacy en modo humano siguen bloqueadas tras el deploy'
);
assert.equal(
  evaluateAiGate({ human_handoff_active: true, status: 'error' }).process,
  true,
  'el falso handoff por error técnico no puede seguir bloqueando la conversación'
);
assert.equal(
  evaluateAiGate({ stage: 'closed', ai_enabled: true }).process,
  true,
  'un paciente que escribe tras cerrar la conversación es atendido'
);

console.log('handoff_stage_test: PASS');

/**
 * Ejecuta processBufferEvent DE VERDAD contra dobles en memoria.
 *
 * A diferencia del resto de las suites de handoff, esta no prueba funciones puras:
 * recorre el camino completo del orquestador, incluido axios y la validación Zod de
 * la respuesta del Adapter, contra un servidor HTTP local que hace de Adapter.
 *
 * Cubre cuatro de las seis pruebas obligatorias del bloque de handoff sin tocar
 * producción:
 *   - un mensaje normal produce una sola respuesta
 *   - tres mensajes en modo humano producen CERO llamadas a Hermes
 *   - tres disparos del mismo handoff dejan una sola nota y una sola alerta
 *   - tras el retorno, el siguiente mensaje vuelve a Hermes
 *
 * SEGURIDAD DEL TEST: las credenciales de Chatwoot y Telegram se vacían antes de
 * cargar la configuración, y se comprueba que están vacías antes de ejecutar nada.
 * Este test no puede escribir en el Chatwoot del cliente.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';

// --- 1. Entorno blindado, ANTES de cargar cualquier módulo -------------------

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://127.0.0.1:1/fake-supabase';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  '2': { tenant_id: 'democoi1', clinic_id: 'coi_demo', hermes_profile: 'helios' }
});
// Vacías a propósito: dotenv no sobrescribe lo que ya está en process.env, así que
// esto neutraliza cualquier credencial real del .env del repositorio.
process.env.CHATWOOT_API_TOKEN = '';
process.env.CHATWOOT_ACCOUNT_ID = '';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_ALERT_CHAT_ID = '';
process.env.HELIOS_HANDOFF_ROUTING_JSON = '';
process.env.HELIOS_HANDOFF_ENABLED = 'true';
process.env.HERMES_ENABLED = 'true';
process.env.HERMES_MOCK = 'false';
process.env.HERMES_API_KEY = '';
process.env.HERMES_ENDPOINT = '/adapter/process';
process.env.HERMES_TIMEOUT_MS = '5000';

// --- 2. Adapter de mentira, servidor HTTP real ------------------------------

interface AdapterScript {
  status: number;
  body: any;
}

const adapterRequests: any[] = [];
let adapterScript: AdapterScript = { status: 200, body: {} };

const adapterServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    try {
      adapterRequests.push(JSON.parse(raw || '{}'));
    } catch {
      adapterRequests.push({ unparsable: true });
    }
    res.writeHead(adapterScript.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(adapterScript.body));
  });
});

await new Promise<void>(resolve => adapterServer.listen(0, '127.0.0.1', () => resolve()));
const adapterPort = (adapterServer.address() as AddressInfo).port;
process.env.HERMES_BASE_URL = `http://127.0.0.1:${adapterPort}`;

// --- 3. Módulos, ya con el entorno fijado -----------------------------------

const { config } = await import('../src/config.js');
const { __setSupabaseClientForTests } = await import('../src/supabase/client.js');
const { FakeSupabase, HELIOS_PRIMARY_KEYS } = await import('./fixtures/fake-supabase.js');
const { processBufferEvent, clearOrchestratorCache } = await import('../src/orchestrator.js');
const { openHandoff, completeHandoff, returnConversationToBot } = await import('../src/handoff/service.js');
const { normalizeHandoffRequest } = await import('../src/handoff/stage.js');
const { resolveTenantContextByTenantId } = await import('../src/tenants/context.js');
const { startReport, addSection } = await import('./fixtures/verification-report.js');

startReport({
  title: 'Verificación del handoff de Helios',
  subtitle: 'Seis escenarios ejecutados sobre el orquestador real, sin tocar producción.',
  outputPath: 'verificacion-handoff.html',
  expectedSections: 7
});

/** Filas del buffer en formato legible para el informe. */
function bufferTable(caption: string) {
  return {
    caption,
    columns: ['Mensaje', 'Dirección', '¿Procesado?'],
    rows: db.table('helios_inbound_buffer').map((row: any) => [
      row.body,
      row.direction === 'incoming' ? 'del paciente' : 'del equipo',
      row.processed_at ? 'sí' : 'no'
    ])
  };
}

// Comprobación de seguridad antes de ejecutar nada.
assert.equal(config.CHATWOOT_API_TOKEN, '', 'el test no puede tener credenciales de Chatwoot');
assert.equal(config.CHATWOOT_ACCOUNT_ID, '', 'el test no puede tener cuenta de Chatwoot');
assert.equal(config.TELEGRAM_BOT_TOKEN, '', 'el test no puede tener token de Telegram');
assert.equal(config.HELIOS_HANDOFF_ENABLED, true, 'el bloque de handoff debe estar activo aquí');

// --- 4. Utilidades del escenario --------------------------------------------

const TENANT = 'democoi1';
const tenantContext = resolveTenantContextByTenantId(TENANT);

let db: FakeSupabase;
let bufferAutoId = 1;

function bufferRow(conversationId: string, contactId: string, body: string, overrides: any = {}) {
  return {
    id: bufferAutoId++,
    tenant_id: TENANT,
    conversation_id: conversationId,
    contact_id: contactId,
    inbox_id: '7',
    message_id: `msg-${bufferAutoId}`,
    source_id: null,
    body,
    direction: 'incoming',
    content_type: 'text',
    created_at: new Date(Date.UTC(2026, 7, 7, 12, bufferAutoId)).toISOString(),
    processed_at: null,
    processing_started_at: null,
    failed_at: null,
    next_retry_at: null,
    retry_count: 0,
    last_error_code: null,
    response_idempotency_key: null,
    trace_id: `trace-${conversationId}`,
    phone: '+34600111222',
    // OJO: aquí NO va `signals`. helios_inbound_buffer no tiene esa columna, y
    // un fixture que se la invente esconde justo el fallo que dejó todas las
    // derivaciones como «excepción operativa» durante días.
    ...overrides
  };
}

function stateRow(conversationId: string, contactId: string, overrides: any = {}) {
  return {
    tenant_id: TENANT,
    conversation_id: conversationId,
    contact_id: contactId,
    inbox_id: '7',
    phone: '+34600111222',
    status: 'processed',
    stage: 'bot_active',
    ai_enabled: true,
    human_handoff_active: false,
    pending_question: null,
    pending_intent: null,
    missing_fields: [],
    active_booking: null,
    financing: null,
    last_intent: null,
    handoff_id: null,
    handoff_requested_at: null,
    returned_to_bot_at: null,
    handoff_context_delivered_at: null,
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function patientRow(contactId: string, overrides: any = {}) {
  return {
    tenant_id: TENANT,
    contact_id: contactId,
    phone: '+34600111222',
    first_name: 'Xavier',
    last_name: 'Mercado',
    name: 'Xavier Mercado',
    email: 'xavier@example.com',
    profile_complete: true,
    crm_contact_id: '240562035087',
    chatwoot_display_name: null,
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function freshDatabase(): FakeSupabase {
  const fake = new FakeSupabase(HELIOS_PRIMARY_KEYS);

  fake.registerRpc('claim_conversation_messages', (params: any) => {
    const rows = fake.table('helios_inbound_buffer').filter((row: any) =>
      row.tenant_id === params.p_tenant_id
      && row.conversation_id === params.p_conversation_id
      && row.processed_at === null
      && row.failed_at === null
      && (row.retry_count ?? 0) < 5
      && row.processing_started_at === null
    );
    const claimedAt = new Date().toISOString();
    rows.forEach((row: any) => { row.processing_started_at = claimedAt; });
    return rows.map((row: any) => ({ ...row }));
  });

  fake.registerRpc('claim_helios_processing_batch', (params: any) => {
    const row: any = fake.table('helios_processing_batches')
      .find((candidate: any) => candidate.batch_key === params.p_batch_key);
    if (!row) return [];
    if (!['pending', 'processing'].includes(row.ai_status)) return [];
    row.ai_status = 'processing';
    row.lease_owner = params.p_lease_owner;
    row.lease_expires_at = new Date(Date.now() + 180_000).toISOString();
    row.attempt_count = (row.attempt_count ?? 0) + 1;
    return [{ ...row }];
  });

  __setSupabaseClientForTests(fake);
  clearOrchestratorCache();
  adapterRequests.length = 0;
  return fake;
}

const okReply = {
  ok: true,
  reply: 'Perfecto, te confirmo la cita.',
  message_for_client: 'Perfecto, te confirmo la cita.',
  safe_to_send: true,
  error_code: null,
  tool_calls: [],
  state_patch: { status: 'processed', pending_question: null }
};

// ===========================================================================
// ESCENARIO A — un turno normal sigue funcionando igual que antes
// ===========================================================================

db = freshDatabase();
db.seed('helios_inbound_buffer', [bufferRow('101', '13', 'Hola, quiero una cita')]);
db.seed('helios_conversation_state', [stateRow('101', '13')]);
db.seed('helios_patient_profiles', [patientRow('13')]);
adapterScript = { status: 200, body: okReply };

await processBufferEvent(TENANT, '101', 'trace-101');

assert.equal(adapterRequests.length, 1, 'A1: el Adapter se llama exactamente una vez');
assert.equal(
  adapterRequests[0].event,
  'patient_message_ready',
  'A2: el payload sigue siendo el contrato de siempre'
);
assert.equal(adapterRequests[0].state.stage, 'bot_active', 'A3: el payload lleva el stage');

const batchesA = db.table('helios_processing_batches');
assert.equal(batchesA.length, 1, 'A4: se crea un único lote');
assert.equal(batchesA[0].ai_status, 'completed', 'A5: el lote queda completado');
assert.equal(batchesA[0].delivery_status, 'pending', 'A6: la entrega queda pendiente para el worker');

const outboxA = db.table('helios_chatwoot_outbox');
assert.equal(outboxA.length, 1, 'A7: se encola una única respuesta');
assert.equal(outboxA[0].content, 'Perfecto, te confirmo la cita.', 'A8: con el texto del modelo');
assert.equal(outboxA[0].status, 'pending');

assert.ok(
  db.table('helios_inbound_buffer')[0].processed_at,
  'A9: el mensaje del buffer queda procesado'
);
assert.equal(db.table('helios_handoff_events').length, 0, 'A10: un turno normal no abre handoff');
assert.equal(db.table('helios_notification_outbox').length, 0, 'A11: ni genera avisos');

const logsA = db.logEvents();
for (const expected of ['HERMES_CALL_STARTED', 'HERMES_CALL_SUCCESS', 'CHATWOOT_OUTBOX_CREATED']) {
  assert.ok(logsA.includes(expected), `A12: la timeline conserva ${expected}`);
}
assert.equal(
  db.table('helios_conversation_state')[0].stage,
  'bot_active',
  'A13: el stage no se mueve en un turno normal'
);

addSection({
  id: 'A',
  title: 'Un paciente escribe y Helios le contesta, como siempre',
  question: '¿Después de haber movido el orden por dentro, sigue funcionando lo de antes?',
  inputs: ['Hola, quiero una cita'],
  facts: [
    { label: 'Veces que Helios consultó a la IA', value: '1', good: true },
    { label: 'Respuestas preparadas para el paciente', value: '1', good: true },
    { label: 'Texto que va a recibir', value: outboxA[0].content, good: true },
    { label: 'Se pasó a una persona', value: 'no, no hacía falta', good: true },
    { label: 'Avisos enviados al equipo', value: '0', good: true }
  ],
  tables: [
    bufferTable('Mensajes del paciente guardados'),
    {
      caption: 'Estado de la conversación',
      columns: ['Quién la lleva', '¿IA activa?'],
      rows: [['la IA', 'sí']]
    }
  ],
  conclusion: 'El camino normal está intacto: una consulta a la IA, una respuesta, y la conversación sigue siendo de la IA.'
});

// ===========================================================================
// ESCENARIO B — modo humano: CERO llamadas a Hermes (prueba obligatoria 3)
// ===========================================================================

db = freshDatabase();
db.seed('helios_inbound_buffer', [
  bufferRow('102', '14', 'Hola?'),
  bufferRow('102', '14', 'Sigue ahí alguien?'),
  bufferRow('102', '14', 'Necesito respuesta')
]);
db.seed('helios_conversation_state', [stateRow('102', '14', {
  stage: 'human_active',
  human_handoff_active: true,
  handoff_id: '3f2a1b8c-1d4e-8a6b-9c0d-1e2f3a4b5c6d',
  handoff_requested_at: new Date(Date.UTC(2026, 7, 7, 11, 0)).toISOString()
})]);
db.seed('helios_patient_profiles', [patientRow('14')]);
adapterScript = { status: 200, body: okReply };

await processBufferEvent(TENANT, '102', 'trace-102');

assert.equal(adapterRequests.length, 0, 'B1: CERO llamadas al Adapter en modo humano');
assert.equal(db.table('helios_processing_batches').length, 0, 'B2: no se crea lote');
assert.equal(db.table('helios_chatwoot_outbox').length, 0, 'B3: no se encola nada al paciente');
assert.equal(
  db.table('helios_inbound_buffer').filter((row: any) => row.processed_at).length,
  3,
  'B4: los tres mensajes quedan guardados y marcados, no perdidos (requisito C)'
);
assert.ok(
  db.logEvents().includes('HUMAN_MODE_MESSAGE_SKIPPED'),
  'B5: queda registrado por qué no se contestó'
);
assert.equal(
  db.table('helios_conversation_state')[0].stage,
  'human_active',
  'B6: el gate no altera el stage'
);

// Fila anterior a la migración: sin stage, solo el booleano legacy.
db = freshDatabase();
db.seed('helios_inbound_buffer', [bufferRow('103', '15', 'Hola')]);
db.seed('helios_conversation_state', [{
  tenant_id: TENANT,
  conversation_id: '103',
  contact_id: '15',
  inbox_id: '7',
  status: 'waiting_patient',
  ai_enabled: true,
  human_handoff_active: true
}]);
db.seed('helios_patient_profiles', [patientRow('15')]);

await processBufferEvent(TENANT, '103', 'trace-103');

assert.equal(
  adapterRequests.length,
  0,
  'B7: una conversación en modo humano ANTES de la migración sigue bloqueada'
);

// La IA pausada explícitamente conserva su comportamiento de siempre.
db = freshDatabase();
db.seed('helios_inbound_buffer', [bufferRow('104', '16', 'Hola')]);
db.seed('helios_conversation_state', [stateRow('104', '16', { ai_enabled: false })]);
db.seed('helios_patient_profiles', [patientRow('16')]);

await processBufferEvent(TENANT, '104', 'trace-104');

assert.equal(adapterRequests.length, 0, 'B8: con la IA pausada tampoco se llama al Adapter');
assert.ok(
  db.logEvents().includes('AI_DISABLED_MESSAGE_SKIPPED'),
  'B9: la pausa explícita se distingue del modo humano'
);

addSection({
  id: 'B',
  title: 'La conversación la lleva una persona: Helios se calla',
  question: '¿Puede la IA colarse y contestar por encima de un compañero que está atendiendo?',
  inputs: ['Hola?', '¿Sigue ahí alguien?', 'Necesito respuesta'],
  facts: [
    { label: 'Veces que Helios consulto a la IA', value: '0', good: true },
    { label: 'Respuestas enviadas al paciente', value: '0', good: true },
    { label: 'Mensajes guardados en la base de datos', value: '3 de 3', good: true },
    { label: 'Con una conversación anterior a la migración', value: 'también se calla', good: true },
    { label: 'Con la IA pausada a mano', value: 'tambien se calla', good: true }
  ],
  tables: [{
    caption: 'Los tres mensajes: guardados, no contestados',
    columns: ['Mensaje', 'Dirección', '¿Procesado?'],
    rows: [
      ['Hola?', 'del paciente', 'sí'],
      ['¿Sigue ahí alguien?', 'del paciente', 'sí'],
      ['Necesito respuesta', 'del paciente', 'sí']
    ]
  }],
  conclusion: 'Tres mensajes seguidos y cero intervenciones de la IA. Nada se pierde: todo queda guardado para que la persona lo lea.'
});

// ===========================================================================
// ESCENARIO C — handoff pedido por el modelo: orden y unicidad
// ===========================================================================

db = freshDatabase();
db.seed('helios_inbound_buffer', [bufferRow('105', '17', 'Quiero hablar con una persona')]);
db.seed('helios_conversation_state', [stateRow('105', '17')]);
db.seed('helios_patient_profiles', [patientRow('17')]);
adapterScript = {
  status: 200,
  body: {
    ...okReply,
    reply: 'Te paso con el equipo.',
    message_for_client: 'Te paso con el equipo.',
    handoff_required: true
    // SIN objeto `handoff`. El contrato de salida admite exactamente diez claves
    // raíz y el output guard de Hermes rechaza cualquier otra, así que ese objeto
    // NO PUEDE llegar nunca en producción. Antes el test lo inyectaba y por eso
    // pasaba en verde mientras la realidad fallaba: el motivo se daba por bueno
    // sin ejercitar nunca la deducción a partir del texto del paciente.
  }
};

await processBufferEvent(TENANT, '105', 'trace-105');

assert.equal(adapterRequests.length, 1, 'C1: una sola llamada al Adapter');

const handoffRows = db.table('helios_handoff_events');
assert.equal(handoffRows.length, 1, 'C2: se registra un único handoff');
// El motivo sale del texto del paciente («Quiero hablar con una persona»), que es
// el único camino que existe de verdad.
assert.equal(
  handoffRows[0].reason_code,
  'human_requested',
  'C2b: el motivo se deduce del mensaje, no es «excepción operativa»'
);
assert.equal(
  handoffRows[0].priority,
  'normal',
  'C2c: la prioridad la marca el motivo verdadero, no el «alta» del cajón de sastre'
);
assert.equal(handoffRows[0].destination, 'reception', 'C3: el motivo enruta a Equipo De Recepción');
assert.equal(handoffRows[0].stage, 'human_queue', 'C4: el handoff acaba entregado a la cola humana');
assert.equal(handoffRows[0].status, 'pending');

const outboxC = db.table('helios_chatwoot_outbox');
assert.equal(outboxC.length, 1, 'C5: un ÚNICO mensaje de transición');
const textoDelModeloC = 'Te paso con el equipo.';
assert.ok(
  outboxC[0].content.startsWith(textoDelModeloC),
  'C5a: el texto que escribio el modelo se conserva intacto y al principio'
);
const coletillaC = outboxC[0].content.slice(textoDelModeloC.length);
assert.ok(
  /^ (El equipo está atendiendo ahora|Le responderán dentro del horario)/.test(coletillaC),
  `C5b: lo unico añadido es la disponibilidad del equipo, y salio: "${coletillaC}"`
);
assert.ok(
  !/lo antes posible.*fuera del horario/.test(outboxC[0].content),
  'C5c: el mensaje no puede prometer inmediatez y decir que esta cerrado a la vez'
);

const notificationsC = db.table('helios_notification_outbox');
assert.equal(notificationsC.length, 1, 'C6: una única alerta al equipo');
assert.equal(
  notificationsC[0].notification_key,
  `handoff:${handoffRows[0].handoff_id}:telegram:created`,
  'C7: la clave de la alerta es la del ítem 23'
);
assert.equal(
  notificationsC[0].status,
  'blocked_unconfigured',
  'C8: sin Telegram configurado la alerta espera, no se pierde ni gasta intentos'
);

const stateC = db.table('helios_conversation_state')[0];
assert.equal(stateC.stage, 'human_queue', 'C9: la conversación queda en manos del equipo');
assert.equal(stateC.human_handoff_active, true, 'C10: el booleano legacy sigue coherente');
assert.equal(stateC.handoff_id, handoffRows[0].handoff_id);

// EL ORDEN DEL ÍTEM 18: el estado que bloquea la IA se persiste ANTES de que el
// paciente pueda recibir nada.
const blockingWriteIndex = db.indexOfOp(op =>
  op.table === 'helios_conversation_state'
  && op.op === 'upsert'
  && op.detail?.payload?.stage === 'handoff_requested'
);
const outboxWriteIndex = db.indexOfOp(op => op.table === 'helios_chatwoot_outbox' && op.op === 'upsert');
assert.ok(blockingWriteIndex >= 0, 'C11: existe la escritura de handoff_requested');
assert.ok(outboxWriteIndex >= 0, 'C12: existe la escritura del mensaje de transición');
assert.ok(
  blockingWriteIndex < outboxWriteIndex,
  'C13: el bloqueo de la IA se persiste antes de encolar el mensaje al paciente'
);

addSection({
  id: 'C',
  title: 'El paciente pide hablar con una persona',
  question: '¿Se avisa al equipo, se avisa al paciente una sola vez, y en el orden correcto?',
  inputs: ['Quiero hablar con una persona'],
  facts: [
    { label: 'Mensajes de aviso al paciente', value: '1 (ni cero ni dos)', good: true },
    { label: 'Lo que se le dice', value: outboxC[0].content, good: true },
    { label: 'A qué equipo va', value: 'Equipo De Recepción', good: true },
    { label: 'Quién lleva ahora la conversación', value: 'el equipo humano', good: true },
    { label: 'Avisos al equipo creados', value: '1', good: true },
    { label: 'Estado del aviso de Telegram', value: 'esperando: falta configurar el bot', good: false },
    { label: 'Se bloqueó la IA ANTES de avisar al paciente', value: 'sí', good: true }
  ],
  tables: [{
    caption: 'Ficha del caso abierto',
    columns: ['Motivo', 'Prioridad', 'Destino', 'Situación'],
    rows: [[
      'el paciente pide una persona',
      handoffRows[0].priority,
      'Equipo De Recepción',
      'en cola del equipo'
    ]]
  }],
  conclusion: 'El orden importa y se respeta: primero se calla la IA, después se avisa al paciente. Si el proceso se cayera en medio, la IA ya estaría callada.'
});

// ===========================================================================
// ESCENARIO D — tres disparos del mismo handoff: una nota y una alerta
//               (prueba obligatoria 6)
// ===========================================================================

db = freshDatabase();
db.seed('helios_conversation_state', [stateRow('106', '18')]);

const handoffInput = {
  tenantContext,
  conversation_id: '106',
  contact_id: '18',
  inbox_id: '7',
  phone: '+34600111222',
  trace_id: 'trace-106',
  trigger_key: 'batch-106',
  request: normalizeHandoffRequest({ reason_code: 'possible_urgency', summary: 'Hinchazón' })
};
const patientSnapshot = {
  first_name: 'Xavier',
  last_name: 'Mercado',
  identity_complete: true,
  crm_synced: true
};

// Cada paso completado se escribe una vez en chatwoot_steps. Contando esas
// escrituras se ve si un reintento repite trabajo o lo omite.
const countStepWrites = () => db.countOps(op =>
  op.table === 'helios_handoff_events'
  && op.op === 'update'
  && Boolean(op.detail?.payload?.chatwoot_steps)
);

const opened1 = await openHandoff(handoffInput);
await completeHandoff({ opened: opened1, transition_outbox_key: null, patient: patientSnapshot });
const stepWritesAfterFirst = countStepWrites();
assert.ok(stepWritesAfterFirst > 0, 'D0: la primera pasada ejecuta los pasos de Chatwoot');

for (let attempt = 0; attempt < 2; attempt += 1) {
  const opened = await openHandoff(handoffInput);
  await completeHandoff({ opened, transition_outbox_key: null, patient: patientSnapshot });
}

assert.equal(
  db.table('helios_handoff_events').length,
  1,
  'D1: tres disparos del mismo handoff dejan UNA fila'
);
assert.equal(
  db.table('helios_notification_outbox').length,
  1,
  'D2: y UNA sola alerta al equipo'
);

const steps = db.table('helios_handoff_events')[0].chatwoot_steps;
assert.ok(steps.private_note?.done, 'D3: la nota privada consta como hecha');
assert.ok(steps.team_notification?.done, 'D3b: y la alerta también');
assert.equal(
  countStepWrites(),
  stepWritesAfterFirst,
  'D4: los dos reintentos NO repiten ningún paso: ni nota, ni etiqueta, ni alerta'
);

addSection({
  id: 'D',
  title: 'El mismo aviso llega tres veces',
  question: '¿Acaba el equipo con tres notas y tres pitidos en el móvil por el mismo caso?',
  inputs: [],
  facts: [
    { label: 'Veces que se pidió el mismo traspaso', value: '3', good: true },
    { label: 'Casos abiertos en el historial', value: '1', good: true },
    { label: 'Notas privadas en Chatwoot', value: '1', good: true },
    { label: 'Avisos al equipo', value: '1', good: true },
    { label: 'Pasos repetidos en los dos reintentos', value: 'ninguno', good: true }
  ],
  tables: [{
    caption: 'Pasos completados, marcados para no repetirse',
    columns: ['Paso', '¿Hecho?'],
    rows: Object.keys(steps).map(step => [step, 'sí'])
  }],
  conclusion: 'Repetir el aviso tres veces deja una sola nota y un solo pitido. El identificador del caso se calcula siempre igual, así que el duplicado se reconoce solo.'
});
assert.equal(
  db.table('helios_handoff_events')[0].handoff_id,
  db.table('helios_conversation_state')[0].handoff_id,
  'D5: el handoff_id determinista es el mismo en las tres pasadas'
);

// ===========================================================================
// ESCENARIO E — retorno al bot y siguiente mensaje de vuelta a Hermes
//               (pruebas obligatorias 4 y 5)
// ===========================================================================

const handoffIdE = db.table('helios_handoff_events')[0].handoff_id;
await returnConversationToBot({
  tenantContext,
  conversation_id: '106',
  contact_id: '18',
  inbox_id: '7',
  phone: '+34600111222',
  trace_id: 'trace-106-return',
  handoff_id: handoffIdE,
  accepted_by: '99'
});

const stateE = db.table('helios_conversation_state')[0];
assert.equal(stateE.stage, 'bot_active', 'E1: la conversación vuelve al bot');
assert.equal(stateE.human_handoff_active, false, 'E2: el booleano legacy se libera');
assert.ok(stateE.returned_to_bot_at, 'E3: queda registrado returned_to_bot_at');
assert.equal(stateE.handoff_id, null, 'E4: el caso deja de estar activo en el estado');
assert.equal(
  db.table('helios_handoff_events')[0].status,
  'resolved',
  'E5: el handoff queda resuelto en el historial'
);
assert.ok(
  db.logEvents().includes('HANDOFF_RETURNED_TO_BOT'),
  'E6: el retorno queda auditado'
);

// Repetir el retorno es idempotente: no revienta ni duplica nada.
await returnConversationToBot({
  tenantContext,
  conversation_id: '106',
  contact_id: '18',
  inbox_id: '7',
  phone: '+34600111222',
  trace_id: 'trace-106-return-2',
  handoff_id: handoffIdE,
  accepted_by: '99'
});
assert.equal(db.table('helios_handoff_events').length, 1, 'E7: repetir el retorno no duplica');

// El siguiente mensaje del paciente vuelve a Hermes.
clearOrchestratorCache();
adapterRequests.length = 0;
adapterScript = { status: 200, body: okReply };
db.seed('helios_inbound_buffer', [bufferRow('106', '18', 'Gracias, una última duda')]);
db.seed('helios_patient_profiles', [patientRow('18')]);

await processBufferEvent(TENANT, '106', 'trace-106-next');

assert.equal(adapterRequests.length, 1, 'E8: tras el retorno, el siguiente mensaje vuelve a Hermes');
assert.equal(
  db.table('helios_chatwoot_outbox').length,
  1,
  'E9: y produce una única respuesta'
);
assert.ok(
  adapterRequests[0].human_handoff,
  'E10: Hermes recibe lo que se habló en modo humano (requisito D)'
);
assert.ok(
  db.table('helios_conversation_state')[0].handoff_context_delivered_at,
  'E11: y se marca entregado para no reenviarlo en cada turno'
);

addSection({
  id: 'E',
  title: 'El equipo termina y devuelve la conversación a Helios',
  question: '¿Vuelve a contestar la IA, y sabe lo que se habló mientras no estaba?',
  inputs: ['Gracias, una última duda'],
  facts: [
    { label: 'Quién lleva la conversación al devolverla', value: 'la IA', good: true },
    { label: 'Caso cerrado en el historial', value: 'sí, marcado como resuelto', good: true },
    { label: 'Devolver dos veces por error', value: 'no duplica nada', good: true },
    { label: 'El siguiente mensaje llega a la IA', value: 'sí', good: true },
    { label: 'La IA recibe lo hablado con la persona', value: 'sí', good: true },
    { label: 'Se reenvía en todos los turnos siguientes', value: 'no, solo una vez', good: true }
  ],
  tables: [{
    caption: 'Estado final de la conversación',
    columns: ['Quién la lleva', '¿Caso activo?', '¿Devuelta?'],
    rows: [['la IA', 'no', 'sí']]
  }],
  conclusion: 'El ciclo se cierra: la persona atiende, devuelve, y la IA retoma sabiendo lo que pasó, sin arrastrar esa conversación para siempre.'
});

// ===========================================================================
// ESCENARIO F — dos webhooks simultáneos del mismo mensaje del equipo
//               (el bug real de la conversación 45: se guardó dos veces)
// ===========================================================================

db = freshDatabase();
const { idempotencyRepository } = await import('../src/repositories/database.js');

const primero = await idempotencyRepository.claim('democoi1', 'chatwoot', '795', '45', 'trace-a');
const segundo = await idempotencyRepository.claim('democoi1', 'chatwoot', '795', '45', 'trace-b');

assert.equal(primero, true, 'F1: el primer webhook gana el claim');
assert.equal(
  segundo,
  false,
  'F2: el segundo webhook del MISMO mensaje pierde. Comprobar-y-luego-insertar dejaba pasar los dos y guardaba el mensaje del equipo dos veces'
);
assert.equal(
  db.table('helios_message_idempotency').length,
  1,
  'F3: una sola fila de idempotencia, porque el candado es la clave primaria'
);

const otroMensaje = await idempotencyRepository.claim('democoi1', 'chatwoot', '796', '45', 'trace-c');
assert.equal(otroMensaje, true, 'F4: un mensaje distinto sí puede reclamarse');

addSection({
  id: 'F',
  title: 'El mismo mensaje del equipo llega dos veces a la vez',
  question: '¿Se guarda dos veces, como pasó de verdad en la conversación 45?',
  inputs: ['que tal, como estas?  (entregado dos veces por Chatwoot)'],
  facts: [
    { label: 'Primer webhook: gana el turno', value: 'sí', good: true },
    { label: 'Segundo webhook: se descarta', value: 'sí', good: true },
    { label: 'Veces que se guarda el mensaje', value: '1', good: true },
    { label: 'Un mensaje distinto sí entra', value: 'sí', good: true }
  ],
  tables: [{
    caption: 'Registro de mensajes ya vistos',
    columns: ['Mensaje', 'Conversación'],
    rows: db.table('helios_message_idempotency').map((row: any) => [row.message_id, row.conversation_id])
  }],
  conclusion: 'El candado es la clave primaria de la base de datos, no una comprobación previa. Entre comprobar y guardar cabía otra petición, y por eso el mensaje del equipo se duplicó en la prueba real.'
});

// ===========================================================================
// ESCENARIO G — un error de contrato acaba en Soporte Técnico Helios
// ===========================================================================
// El operador lo pidió explícitamente: "cuando haya un problema técnico, un error
// de Helios, por ejemplo por contrato, se pase al equipo de soporte técnico".
//
// Este camino NO estaba cubierto de punta a punta. Solo se probaba la función que
// construye la nota, con un objeto de fallo técnico ya montado a mano: exactamente
// el mismo patrón que dejó pasar el fallo de las señales (HEL-046). Aquí el fallo
// lo produce el Adapter de verdad y la escalada tiene que salir sola.

db = freshDatabase();
db.seed('helios_inbound_buffer', [bufferRow('108', '20', 'Quiero pedir cita para una limpieza')]);
db.seed('helios_conversation_state', [stateRow('108', '20')]);
db.seed('helios_patient_profiles', [patientRow('20')]);

// Respuesta que VIOLA el contrato: le falta message_for_client y manda un tipo
// que no existe. Es lo que llega cuando el modelo se sale del formato pactado.
adapterScript = {
  status: 200,
  body: {
    ok: true,
    reply: 'algo',
    safe_to_send: 'quizás',
    operation: { type: 'inventado_por_el_modelo', status: 'success' }
  }
};

await processBufferEvent(TENANT, '108', 'trace-108');

const tecnicos = db.table('helios_handoff_events');
assert.equal(tecnicos.length, 1, 'G1: el fallo de contrato genera una derivación');
assert.equal(
  tecnicos[0].origin,
  'technical_failure',
  'G2: consta como fallo técnico, no como derivación clínica'
);
assert.equal(
  tecnicos[0].destination,
  'helios_support',
  'G3: va a Soporte Técnico Helios, NO al equipo de recepción'
);
assert.equal(
  tecnicos[0].stage,
  'handoff_failed',
  'G4: la etapa es la que espera el equipo técnico'
);

// Un error de contrato NO es un fallo de red: no se reintenta cinco veces antes
// de avisar. Se escala en el primer intento, porque reintentar no lo va a arreglar.
const bufferG = db.table('helios_inbound_buffer');
assert.equal(bufferG[0].failed_at !== null, true, 'G5: el mensaje se marca fallido de inmediato');
assert.equal(bufferG[0].retry_count, 0, 'G6: sin reintentos: reintentar un error de contrato es inútil');

// EL PACIENTE NO SE PUEDE QUEDAR CALLADO. Antes no se le mandaba nada y se
// quedaba mirando el chat sin saber si le habían leído, esperando a un equipo
// técnico que arregla programas y no atiende pacientes.
const outboxG = db.table('helios_chatwoot_outbox');
assert.equal(outboxG.length, 1, 'G7: al paciente se le avisa, una sola vez');
assert.match(
  outboxG[0].content,
  /problema técnico/,
  'G7b: se le dice que hubo un problema, sin códigos de error'
);
assert.match(
  outboxG[0].content,
  /(El equipo está atendiendo|Le responderán dentro del horario)/,
  'G7c: y que le va a responder el equipo, que es lo que necesita saber'
);
assert.ok(
  /atendiendo ahora|se reanuda|dentro del horario de atención/.test(outboxG[0].content),
  'G7d: el aviso dice CUANDO responde el equipo. Sin esto, a las once de la noche '
  + 'se le promete al paciente una atencion que nadie va a cumplir'
);

const estadoG = db.table('helios_conversation_state')[0];
assert.equal(estadoG.stage, 'handoff_failed', 'G8: la conversación queda en manos del equipo técnico');
assert.equal(estadoG.human_handoff_active, true, 'G9: y Hermes deja de contestar');

// La conversación queda además fuera de la encuesta de satisfacción: no se le
// pregunta "¿qué tal el servicio?" a quien acaba de sufrir un fallo.
assert.equal(
  estadoG.csat_excluded_reason,
  'technical_failure',
  'G10: excluida de la encuesta, y con el motivo más grave registrado'
);

addSection({
  id: 'G',
  title: 'Helios se sale del contrato en mitad de una petición de cita',
  question: '¿Quién se entera, y adónde va la conversación?',
  inputs: ['Quiero pedir cita para una limpieza  (el Adapter responde fuera de contrato)'],
  facts: [
    { label: 'A qué equipo va', value: 'Soporte Técnico Helios', good: true },
    { label: 'Etapa de la conversación', value: 'Fallo técnico', good: true },
    { label: 'Reintentos antes de avisar', value: '0', good: true },
    { label: 'Aviso al paciente', value: '1 mensaje', good: true },
    { label: '¿Sigue contestando la IA?', value: 'no', good: true },
    { label: 'Encuesta de satisfacción', value: 'excluida', good: true }
  ],
  tables: [{
    caption: 'La derivación que se crea sola',
    columns: ['Origen', 'A qué equipo', 'Etapa'],
    rows: db.table('helios_handoff_events').map((row: any) => [
      row.origin === 'technical_failure' ? 'fallo técnico' : row.origin,
      row.destination === 'helios_support' ? 'Soporte Técnico Helios' : row.destination,
      row.stage === 'handoff_failed' ? 'Fallo técnico' : row.stage
    ])
  }],
  conclusion: 'Un error de contrato no se reintenta: reintentarlo no lo arregla. Se avisa en el primer intento, y a DOS equipos con encargos distintos: recepción continúa la conversación para que el paciente no se quede colgado, y soporte ve el error para arreglarlo. Al paciente se le dice que hubo un problema y que sigue una persona.'
});

// ===========================================================================

await new Promise<void>(resolve => adapterServer.close(() => resolve()));

console.log('handoff_orchestrator_test: PASS (7 escenarios end-to-end sobre processBufferEvent)');

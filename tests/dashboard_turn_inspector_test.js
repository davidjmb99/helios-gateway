import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const dashboardPath = path.join(testDirectory, '..', 'public', 'index.html');
const dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');
const inlineScripts = [...dashboardHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(script => script.trim());

assert.equal(inlineScripts.length, 1, 'se esperaba un único script inline del dashboard');

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    if (force === undefined) {
      if (this.values.has(name)) this.values.delete(name);
      else this.values.add(name);
      return this.values.has(name);
    }
    if (force) this.values.add(name);
    else this.values.delete(name);
    return force;
  }

  contains(name) {
    return this.values.has(name);
  }
}

const elements = new Map();

function makeElement(id) {
  const element = {
    id,
    classList: new FakeClassList(),
    className: '',
    style: {},
    value: '',
    innerText: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0
  };
  let html = '';
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return html;
    },
    set(value) {
      html = String(value);
      if (id === 'chat-panel' && html.includes('id="conversation-message-scroll"')) {
        elements.set('conversation-message-scroll', makeElement('conversation-message-scroll'));
      }
    }
  });
  return element;
}

function getElement(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}

const localStorageValues = new Map();
const sandbox = {
  console: {
    log() {},
    error() {},
    warn() {}
  },
  document: {
    hidden: false,
    getElementById: getElement,
    addEventListener() {}
  },
  localStorage: {
    getItem(key) {
      return localStorageValues.get(key) ?? null;
    },
    setItem(key, value) {
      localStorageValues.set(key, String(value));
    },
    removeItem(key) {
      localStorageValues.delete(key);
    }
  },
  fetch: async () => {
    throw new Error('fetch no debe ejecutarse durante esta prueba');
  },
  requestAnimationFrame(callback) {
    callback();
    return 1;
  },
  setInterval() {
    return 1;
  },
  clearInterval() {},
  setTimeout,
  clearTimeout,
  encodeURIComponent,
  decodeURIComponent,
  URLSearchParams,
  Date,
  JSON,
  Math,
  Number,
  Object,
  String,
  Array,
  Set,
  Map
};
sandbox.globalThis = sandbox;

const exportsSource = `
  globalThis.__dashboardTestApi = {
    buildConversationMessages,
    renderSelectedOperationalConversation,
    showConversationHistory,
    selectOperationalMessage,
    changeOperationalDetailTab,
    setMobilePanel,
    renderOperationalConversations,
    setFixture(events, conversations, conversationKey) {
      allEvents = events;
      operationalConversations = conversations;
      activeOperationalConversationKey = conversationKey;
      operationalDetailTab = 'summary';
      lastChatConversationKey = null;
      activeOperationalTurnKey = null;
      activeOperationalMessageKey = null;
      durableConversationMessages = new Map();
    },
    setDurableMessages(conversationKey, messages) {
      durableConversationMessages.set(conversationKey, messages);
    },
    getSelection() {
      return {
        conversationKey: activeOperationalConversationKey,
        turnKey: activeOperationalTurnKey,
        messageKey: activeOperationalMessageKey,
        detailTab: operationalDetailTab
      };
    }
  };
`;

vm.createContext(sandbox);
vm.runInContext(`${inlineScripts[0]}\n${exportsSource}`, sandbox, {
  filename: dashboardPath
});

const dashboard = sandbox.__dashboardTestApi;

function buildTurn(turnNumber, incomingText, outgoingText) {
  const second = String(turnNumber).padStart(2, '0');
  const traceId = `trace-${turnNumber}`;
  const requestKey = `request-${turnNumber}`;
  const batchKey = `batch-${turnNumber}`;
  const outboxKey = `outbox-${turnNumber}`;
  const sourceMessageId = `source-${turnNumber}`;
  const outboundMessageId = `outbound-${turnNumber}`;
  const baseMinute = turnNumber * 2;
  const incomingTimestamp = `2026-07-29T10:${String(baseMinute).padStart(2, '0')}:00.000Z`;
  const outgoingTimestamp = `2026-07-29T10:${String(baseMinute + 1).padStart(2, '0')}:00.000Z`;

  const debugEvent = {
    id: `event-${second}`,
    trace_id: traceId,
    tenant_id: 'democoi1',
    conversation_id: '33',
    contact_id: '8',
    message_type: 'incoming',
    text: incomingText,
    timestamp: incomingTimestamp,
    normalizedPayload: {
      tenant_id: 'democoi1',
      direction: 'incoming',
      source_message_id: sourceMessageId,
      adapter_request_key: requestKey,
      batch_key: batchKey,
      raw_payload: {
        id: sourceMessageId,
        content: incomingText
      }
    },
    hermesRequest: {
      request_key: requestKey,
      batch_key: batchKey,
      model: 'default',
      transport: 'agent_api'
    },
    hermesResponse: {
      body: {
        message_for_client: outgoingText,
        hermes_conversation_id: `hermes-conversation-${turnNumber}`,
        hermes_response_id: `hermes-response-${turnNumber}`,
        adapter_request_key: requestKey,
        batch_key: batchKey,
        outbox_key: outboxKey,
        reasoning: `razonamiento privado ${turnNumber}`,
        tool_calls: [{
          name: 'technical_tool',
          result: `resultado técnico ${turnNumber}`
        }]
      }
    },
    actionsExecuted: [{
      action: 'reply_sent_to_chatwoot',
      success: true,
      timestamp: outgoingTimestamp,
      data: {
        reply: outgoingText,
        chatwoot_message_id: outboundMessageId,
        outbox_key: outboxKey,
        adapter_request_key: requestKey
      }
    }]
  };

  const timeline = [
    {
      stage: 'INBOUND_RECEIVED',
      timestamp: incomingTimestamp,
      trace_id: traceId,
      source_message_id: sourceMessageId,
      adapter_request_key: requestKey,
      batch_key: batchKey
    },
    {
      stage: 'BATCH_CREATED',
      timestamp: incomingTimestamp,
      trace_id: traceId,
      source_message_id: sourceMessageId,
      adapter_request_key: requestKey,
      batch_key: batchKey
    },
    {
      stage: 'ADAPTER_COMPLETED',
      timestamp: outgoingTimestamp,
      trace_id: traceId,
      adapter_request_key: requestKey,
      batch_key: batchKey,
      outbox_key: outboxKey
    },
    {
      stage: 'OUTBOX_CREATED',
      timestamp: outgoingTimestamp,
      trace_id: traceId,
      adapter_request_key: requestKey,
      batch_key: batchKey,
      outbox_key: outboxKey
    },
    {
      stage: 'CHATWOOT_SENT',
      timestamp: outgoingTimestamp,
      trace_id: traceId,
      adapter_request_key: requestKey,
      batch_key: batchKey,
      outbox_key: outboxKey,
      chatwoot_outbound_message_id: outboundMessageId
    }
  ];

  return { debugEvent, timeline };
}

const turnFixtures = [
  buildTurn(1, 'Mensaje repetido', 'Salida 1'),
  buildTurn(2, 'Mensaje repetido', 'Salida 2'),
  buildTurn(3, 'Entrada 3', 'Salida 3'),
  buildTurn(4, 'Entrada 4', 'Salida 4')
];
const conversation = {
  group_key: 'democoi1:2:33:8',
  tenant_id: 'democoi1',
  account_id: '2',
  conversation_id: '33',
  contact_id: '8',
  patient_name: 'Paciente de prueba',
  phone: '+584000000000',
  status: 'SENT',
  hermes_profile: 'helios',
  inbound_message: 'Entrada 4',
  hermes_response: 'Salida 4',
  last_timestamp: '2026-07-29T10:09:00.000Z',
  timeline: turnFixtures.flatMap(item => item.timeline)
};
const debugEvents = turnFixtures.map(item => item.debugEvent);

dashboard.setFixture(debugEvents, [conversation], conversation.group_key);

let assertionsPassed = 0;
function verify(description, assertion) {
  assertion();
  assertionsPassed += 1;
  console.log(`PASS ${assertionsPassed}/16: ${description}`);
}

const messages = dashboard.buildConversationMessages(conversation);

verify('la tarjeta muestra completo el teléfono ya autorizado por backend', () => {
  const list = getElement('authorized-phone-list');
  dashboard.renderOperationalConversations('', '', list);
  assert.match(list.innerHTML, /\+584000000000/);
  assert.doesNotMatch(list.innerHTML, /\*{3,}/);
});

verify('la tarjeta conserva el teléfono enmascarado entregado por backend', () => {
  const list = getElement('masked-phone-list');
  const maskedConversation = { ...conversation, phone: '+58*******00' };
  dashboard.setFixture(debugEvents, [maskedConversation], maskedConversation.group_key);
  dashboard.renderOperationalConversations('', '', list);
  assert.match(list.innerHTML, /\+58\*{7}00/);
  dashboard.setFixture(debugEvents, [conversation], conversation.group_key);
});

verify('cuatro turnos generan ocho burbujas', () => {
  assert.equal(messages.length, 8);
});

verify('las burbujas quedan ordenadas cronológicamente', () => {
  const timestamps = Array.from(messages, message => message.timestamp);
  assert.equal(JSON.stringify(timestamps), JSON.stringify([...timestamps].sort()));
});

verify('mensajes iguales en turnos distintos no se deduplican', () => {
  assert.equal(
    messages.filter(message => message.direction === 'incoming' && message.text === 'Mensaje repetido').length,
    2
  );
});

verify('el fallback durable no duplica la última salida', () => {
  assert.equal(
    messages.filter(message => message.direction === 'outgoing' && message.text === 'Salida 4').length,
    1
  );
});

const durableMessages = Array.from(messages, message => ({
  message_key: message.message_key,
  turn_key: message.turn_key,
  direction: message.direction,
  text: message.text,
  timestamp: message.timestamp,
  trace_id: message.trace_id,
  chatwoot_message_id: message.chatwoot_message_id,
  source_message_id: message.source_message_id,
  adapter_request_key: message.adapter_request_key,
  batch_key: message.batch_key,
  outbox_key: message.outbox_key,
  delivery_status: message.direction === 'outgoing' ? 'sent' : undefined
}));

verify('el historial durable funciona con debug events vacíos tras reinicio', () => {
  dashboard.setFixture([], [conversation], conversation.group_key);
  dashboard.setDurableMessages(conversation.group_key, durableMessages);
  assert.equal(dashboard.buildConversationMessages(conversation).length, 8);
});

verify('debug temporal complementa sin duplicar mensajes durables', () => {
  dashboard.setFixture(debugEvents, [conversation], conversation.group_key);
  dashboard.setDurableMessages(conversation.group_key, durableMessages);
  assert.equal(dashboard.buildConversationMessages(conversation).length, 8);
});

const turnTwoIncoming = messages.find(
  message => message.trace_id === 'trace-2' && message.direction === 'incoming'
);
const turnTwoOutgoing = messages.find(
  message => message.trace_id === 'trace-2' && message.direction === 'outgoing'
);
assert.ok(turnTwoIncoming);
assert.ok(turnTwoOutgoing);

verify('seleccionar una entrada carga el inspector de su turno', () => {
  dashboard.selectOperationalMessage(encodeURIComponent(turnTwoIncoming.message_key));
  assert.match(getElement('inspector-panel').innerHTML, /trace-2/);
});

verify('entrada y salida correlacionadas apuntan al mismo turno', () => {
  dashboard.selectOperationalMessage(encodeURIComponent(turnTwoIncoming.message_key));
  const incomingSelection = dashboard.getSelection();
  dashboard.selectOperationalMessage(encodeURIComponent(turnTwoOutgoing.message_key));
  const outgoingSelection = dashboard.getSelection();
  assert.equal(outgoingSelection.turnKey, incomingSelection.turnKey);
  assert.match(getElement('inspector-panel').innerHTML, /trace-2/);
});

const turnOneIncoming = messages.find(
  message => message.trace_id === 'trace-1' && message.direction === 'incoming'
);
assert.ok(turnOneIncoming);

verify('las pestañas usan el turno seleccionado y no el último', () => {
  dashboard.selectOperationalMessage(encodeURIComponent(turnOneIncoming.message_key));
  dashboard.changeOperationalDetailTab('input');
  const inspectorHtml = getElement('inspector-panel').innerHTML;
  assert.match(inspectorHtml, /Mensaje repetido/);
  assert.doesNotMatch(inspectorHtml, /Entrada 4/);
});

verify('el auto-refresh conserva conversación, turno, burbuja y pestaña', () => {
  const beforeRefresh = dashboard.getSelection();
  dashboard.renderSelectedOperationalConversation(conversation);
  assert.deepEqual(dashboard.getSelection(), beforeRefresh);
});

verify('el auto-refresh conserva el scroll cuando el usuario no está al final', () => {
  dashboard.showConversationHistory(conversation);
  const currentScroller = getElement('conversation-message-scroll');
  currentScroller.scrollTop = 120;
  currentScroller.scrollHeight = 1000;
  currentScroller.clientHeight = 300;
  dashboard.showConversationHistory(conversation);
  assert.equal(getElement('conversation-message-scroll').scrollTop, 120);
});

verify('el chat no renderiza razonamiento, herramientas ni resultados técnicos', () => {
  const visibleText = messages.map(message => message.text).join('\n');
  assert.doesNotMatch(visibleText, /razonamiento privado/);
  assert.doesNotMatch(visibleText, /technical_tool/);
  assert.doesNotMatch(visibleText, /resultado técnico/);
});

verify('en móvil el inspector sustituye al chat sin taparlo', () => {
  dashboard.setMobilePanel('details');
  assert.equal(getElement('inspector-panel').classList.contains('mobile-active'), true);
  assert.equal(getElement('chat-panel').classList.contains('mobile-active'), false);
  dashboard.setMobilePanel('chat');
  assert.equal(getElement('chat-panel').classList.contains('mobile-active'), true);
  assert.equal(getElement('inspector-panel').classList.contains('mobile-active'), false);
});

verify('la lista izquierda y el simulador permanecen en el HTML real', () => {
  assert.match(dashboardHtml, /id="left-list-container"/);
  assert.match(dashboardHtml, /onsubmit="sendSimulated\(event\)"/);
});

assert.equal(assertionsPassed, 16);
console.log('dashboard_turn_inspector_test: PASS (16/16)');

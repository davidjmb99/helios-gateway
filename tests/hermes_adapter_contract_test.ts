import assert from 'node:assert/strict';
import { normalizeHermesToolCalls } from '../src/hermes/client.js';
import { HermesResponseSchema } from '../src/hermes/schema.js';

const adapterSuccessResponse = {
  ok: true,
  reply: '¡Hola! Encantada de ayudarte a agendar una cita.',
  reply_text: '¡Hola! Encantada de ayudarte a agendar una cita.',
  message_for_client: '¡Hola! Encantada de ayudarte a agendar una cita.',
  route: 'hermes',
  intent: 'create_appointment',
  decision: 'processed',
  operation: {
    type: 'identity_requested',
    status: 'success',
    summary: 'Se solicitaron los datos necesarios para identificar al paciente.',
    last_tool_name: null,
    last_tool_status: null,
    last_operation_at: null
  },
  profile_patch: {},
  state_patch: {
    status: null,
    pending_question: 'patient_identity',
    pending_intent: 'create_appointment',
    missing_fields: null,
    human_handoff_active: null,
    last_intent: 'appointment_request'
  },
  booking_patch: {
    booking_uid: null,
    status: null,
    start_time: null,
    timezone: null,
    service: null,
    last_action: null
  },
  tool_calls: [],
  safe_to_send: true,
  response_sent: false,
  handoff_required: false,
  reason: '',
  recoverable: false,
  error_code: null
};

const successResult = HermesResponseSchema.safeParse(adapterSuccessResponse);
assert.equal(
  successResult.success,
  true,
  successResult.success ? undefined : JSON.stringify(successResult.error.issues)
);

if (successResult.success) {
  assert.equal(successResult.data.error_code, null);
  assert.equal(successResult.data.safe_to_send, true);
  assert.equal(
    successResult.data.message_for_client,
    adapterSuccessResponse.message_for_client
  );
}

const adapterErrorResponse = {
  ok: false,
  reply: '',
  reply_text: '',
  message_for_client: '',
  route: 'error',
  intent: 'technical_error',
  decision: 'error',
  operation: {
    type: 'technical_error',
    status: 'failed',
    summary: 'Respuesta final rechazada.'
  },
  profile_patch: {},
  state_patch: {},
  booking_patch: {},
  tool_calls: [],
  safe_to_send: false,
  response_sent: false,
  handoff_required: false,
  reason: '',
  recoverable: true,
  error_code: 'INVALID_HERMES_CONTRACT'
};

const errorResult = HermesResponseSchema.safeParse(adapterErrorResponse);
assert.equal(
  errorResult.success,
  true,
  errorResult.success ? undefined : JSON.stringify(errorResult.error.issues)
);

const canonicalCall = {
  name: 'mcp_hubspot_contacts_upsert_patient_contact',
  arguments: {},
  status: 'success',
  duration_ms: null,
  result_code: null
};

assert.deepEqual(
  normalizeHermesToolCalls([{
    name: '  mcp_hubspot_contacts_upsert_patient_contact  ',
    status: 'success'
  }]),
  [canonicalCall],
  '1/6 tool call con name conserva y normaliza el nombre'
);

assert.deepEqual(
  normalizeHermesToolCalls([{
    tool: '  mcp_hubspot_contacts_upsert_patient_contact  ',
    status: 'success'
  }]),
  [canonicalCall],
  '2/6 tool se convierte al campo canónico name'
);

const namePriorityCall = normalizeHermesToolCalls([{
  name: 'canonical_tool_name',
  tool: 'legacy_tool_alias',
  status: 'success'
}]);

assert.deepEqual(
  namePriorityCall,
  [{
    name: 'canonical_tool_name',
    arguments: {},
    status: 'success',
    duration_ms: null,
    result_code: null
  }],
  'name tiene prioridad cuando el mismo objeto también contiene tool'
);
assert.equal(
  'tool' in namePriorityCall[0],
  false,
  'el resultado canónico no conserva el alias tool'
);

assert.deepEqual(
  normalizeHermesToolCalls([
    { name: 'tool_by_name', arguments: { source: 'name' }, status: 'success' },
    { tool: 'tool_by_alias', arguments: { source: 'tool' }, status: 'success' }
  ]),
  [
    {
      name: 'tool_by_name',
      arguments: { source: 'name' },
      status: 'success',
      duration_ms: null,
      result_code: null
    },
    {
      name: 'tool_by_alias',
      arguments: { source: 'tool' },
      status: 'success',
      duration_ms: null,
      result_code: null
    }
  ],
  '3/6 una lista mixta acepta name y tool'
);

assert.deepEqual(
  normalizeHermesToolCalls([
    { status: 'success' },
    null,
    { tool: 'valid_tool', status: 'success' }
  ]),
  [{
    name: 'valid_tool',
    arguments: {},
    status: 'success',
    duration_ms: null,
    result_code: null
  }],
  '4/6 elementos sin name ni tool se omiten de forma segura'
);

const realAdapterResponse = {
  message_for_client: 'Gracias, Xavier. He registrado tus datos correctamente.',
  profile_patch: {
    profile_complete: true,
    hubspot_contact_id: '238515162795'
  },
  tool_calls: [
    {
      tool: 'mcp_hubspot_contacts_upsert_patient_contact',
      status: 'success'
    },
    {
      tool: 'mcp_calcom_get_available_slots',
      status: 'success'
    }
  ],
  safe_to_send: true,
  error_code: null
};

const normalizedRealResponse = {
  ...realAdapterResponse,
  reply: realAdapterResponse.message_for_client,
  reply_text: realAdapterResponse.message_for_client,
  tool_calls: normalizeHermesToolCalls(realAdapterResponse.tool_calls)
};
const realResult = HermesResponseSchema.safeParse(normalizedRealResponse);

assert.equal(
  realResult.success,
  true,
  realResult.success ? undefined : JSON.stringify(realResult.error.issues)
);

if (realResult.success) {
  assert.deepEqual(
    realResult.data.tool_calls.map(call => call.name),
    [
      'mcp_hubspot_contacts_upsert_patient_contact',
      'mcp_calcom_get_available_slots'
    ],
    '5/6 la respuesta real conserva ambas herramientas'
  );
  assert.equal(
    realResult.data.profile_patch?.hubspot_contact_id,
    realAdapterResponse.profile_patch.hubspot_contact_id,
    '6/6 profile_patch se conserva'
  );
  assert.equal(
    realResult.data.message_for_client,
    realAdapterResponse.message_for_client,
    '6/6 message_for_client se conserva'
  );
  assert.equal(
    realResult.data.safe_to_send,
    realAdapterResponse.safe_to_send,
    '6/6 safe_to_send se conserva'
  );
}

console.log('PASS: contrato Adapter -> Gateway acepta éxitos, errores y tool_calls normalizados.');

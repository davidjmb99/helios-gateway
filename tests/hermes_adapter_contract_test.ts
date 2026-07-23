import assert from 'node:assert/strict';
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

console.log('PASS: contrato Adapter -> Gateway acepta éxitos sin error y errores normalizados.');

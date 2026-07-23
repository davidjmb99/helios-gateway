import { z } from 'zod';

const NullableStringSchema = z.string().nullable().optional();
const NullableNumberSchema = z.number().nullable().optional();

// Schema ampliado del profile_patch para aceptar todos los campos que Hermes/Adapter puede devolver.
// Incluye first_name, last_name, profile_complete y hubspot_contact_id que antes se descartaban por .strip().
const ProfilePatchSchema = z.object({
  first_name: NullableStringSchema,
  last_name: NullableStringSchema,
  name: NullableStringSchema,
  email: NullableStringSchema,
  phone: NullableStringSchema,
  profile_complete: z.boolean().nullable().optional(),
  hubspot_contact_id: NullableStringSchema,
}).nullable().optional();

export const HermesResponseSchema = z.object({
  ok: z.boolean().optional(),
  route: z.string().optional(),
  intent: z.string().optional(),
  reply: z.string().nullable().optional(),
  reply_text: z.string().nullable().optional(),
  message_for_client: z.string().nullable().optional(),
  safe_to_send: z.boolean().optional(),
  profile_patch: ProfilePatchSchema,
  patient_profile_update: ProfilePatchSchema,
  state_patch: z.object({
    status: NullableStringSchema,
    pending_question: NullableStringSchema,
    pending_intent: NullableStringSchema,
    missing_fields: z.array(z.string()).nullable().optional(),
    human_handoff_active: z.boolean().nullable().optional(),
    active_booking: z.any().optional(),
    financing: z.any().optional(),
    appointment_context: z.any().optional(),
    last_intent: NullableStringSchema
  }).nullable().optional(),
  state_update: z.any().optional(),
  booking_patch: z.object({
    booking_uid: NullableStringSchema,
    status: NullableStringSchema,
    start_time: NullableStringSchema,
    timezone: NullableStringSchema,
    service: NullableStringSchema,
    last_action: NullableStringSchema
  }).nullable().optional(),
  operation: z.object({
    type: NullableStringSchema,
    status: NullableStringSchema,
    summary: NullableStringSchema,
    last_tool_name: NullableStringSchema,
    last_tool_status: NullableStringSchema,
    last_operation_at: NullableStringSchema
  }).nullable().optional(),
  tool_calls: z.array(z.object({
    name: z.string(),
    arguments: z.any().optional(),
    status: NullableStringSchema,
    duration_ms: NullableNumberSchema,
    result_code: NullableStringSchema
  })).default([]),
  decision: z.enum(['processed', 'identity_required', 'needs_handoff', 'error']).optional().default('processed'),
  response_sent: z.boolean().optional(),
  handoff_required: z.boolean().optional().default(false),
  reason: z.string().optional(),
  // El Adapter usa null para indicar explícitamente que una respuesta exitosa no tiene error.
  error_code: NullableStringSchema,
  recoverable: z.boolean().optional()
});

export type HermesResponse = z.infer<typeof HermesResponseSchema>;

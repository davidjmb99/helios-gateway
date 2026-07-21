import { z } from 'zod';

// Schema ampliado del profile_patch para aceptar todos los campos que Hermes/Adapter puede devolver.
// Incluye first_name, last_name, profile_complete y hubspot_contact_id que antes se descartaban por .strip().
const ProfilePatchSchema = z.object({
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  profile_complete: z.boolean().nullable().optional(),
  hubspot_contact_id: z.string().nullable().optional(),
}).nullable().optional();

export const HermesResponseSchema = z.object({
  route: z.string().optional(),
  intent: z.string().optional(),
  reply: z.string().nullable().optional(),
  reply_text: z.string().nullable().optional(),
  safe_to_send: z.boolean().optional(),
  profile_patch: ProfilePatchSchema,
  patient_profile_update: ProfilePatchSchema,
  state_patch: z.object({
    status: z.string().optional(),
    pending_question: z.string().nullable().optional(),
    pending_intent: z.string().nullable().optional(),
    missing_fields: z.array(z.string()).optional(),
    human_handoff_active: z.boolean().optional(),
    active_booking: z.any().optional(),
    financing: z.any().optional(),
    appointment_context: z.any().optional(),
    last_intent: z.string().nullable().optional()
  }).nullable().optional(),
  state_update: z.object({
    status: z.string().optional(),
    pending_question: z.string().nullable().optional(),
    pending_intent: z.string().nullable().optional(),
    missing_fields: z.array(z.string()).optional(),
    human_handoff_active: z.boolean().optional(),
    active_booking: z.any().optional(),
    financing: z.any().optional(),
    appointment_context: z.any().optional(),
    last_intent: z.string().nullable().optional()
  }).optional(),
  tool_calls: z.array(z.object({
    name: z.string(),
    arguments: z.any()
  })).default([]),
  decision: z.enum(['processed', 'identity_required', 'needs_handoff', 'error']).optional().default('processed'),
  response_sent: z.boolean().optional(),
  handoff_required: z.boolean().optional().default(false),
  reason: z.string().optional()
});

export type HermesResponse = z.infer<typeof HermesResponseSchema>;

import { z } from 'zod';

export const HermesResponseSchema = z.object({
  route: z.string().optional(),
  intent: z.string().optional(),
  decision: z.string().optional(),
  reply: z.string().nullable().optional(),
  reply_text: z.string().nullable().optional(),
  safe_to_send: z.boolean().optional(),
  profile_patch: z.object({
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional()
  }).nullable().optional(),
  patient_profile_update: z.object({
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional()
  }).optional(),
  state_patch: z.object({
    status: z.string().optional(),
    pending_question: z.string().nullable().optional(),
    pending_intent: z.string().nullable().optional(),
    missing_fields: z.array(z.string()).optional(),
    human_handoff_active: z.boolean().optional(),
    active_booking: z.any().optional(),
    financing: z.any().optional(),
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
    last_intent: z.string().nullable().optional()
  }).optional(),
  tool_calls: z.array(z.object({
    name: z.string(),
    arguments: z.any()
  })).default([]),
  handoff_required: z.boolean().default(false),
  reason: z.string().optional()
});

export type HermesResponse = z.infer<typeof HermesResponseSchema>;

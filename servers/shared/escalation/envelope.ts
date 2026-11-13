import { z } from 'zod'
import { ESCALATION_REASONS, type EscalationCause, type EscalationReason } from './policy'
import type { PublicEscalation } from './serialize'

// How an escalation crosses A2A. Mastra's handler ends a task that threw as `failed` with the
// text `Handler failed: <error message>` and nothing else, so the escalation travels as that
// message: this marker followed by JSON.
//   hint        specialist → router: the code, the wait and the internal cause
//   escalation  router → caller: the public fields and the sentence to show
export const ENVELOPE_MARKER = '[[escalation:v2]]'

export type EscalationHint = { escalationReason: EscalationReason; retryAfterMs?: number; cause?: EscalationCause }

export type Envelope = { kind: 'hint'; hint: EscalationHint } | { kind: 'escalation'; text: string; escalation: PublicEscalation }

const reason = z.enum(ESCALATION_REASONS)

const hintSchema = z.object({
  escalationReason: reason,
  retryAfterMs: z.number().nonnegative().optional(),
  cause: z.enum(['dependency', 'model', 'permission', 'intent', 'rule', 'guardrail', 'limit']).optional(),
})

const escalationSchema = z.object({
  schemaVersion: z.literal(2),
  reasonCode: reason,
  summary: z.string(),
  failureClass: z.enum(['terminal', 'transient', 'caller-action']),
  retryable: z.boolean(),
  retryAfterMs: z.number().nonnegative().optional(),
  destination: z.object({ url: z.string(), label: z.string(), instructions: z.string().optional() }),
  approval: z
    .object({
      approvalId: z.string(),
      action: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
      expiresAt: z.string().optional(),
    })
    .optional(),
})

const envelopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hint'), hint: hintSchema }),
  z.object({ kind: z.literal('escalation'), text: z.string(), escalation: escalationSchema }),
])

export const encodeEnvelope = (envelope: Envelope) => `${ENVELOPE_MARKER}${JSON.stringify(envelope)}`

// The JSON object at the start of `text`, without whatever follows it.
function leadingObject(text: string) {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return text.slice(0, i + 1)
  }
  return text
}

// Reads an envelope out of any text that contains one, whatever was put before or after it.
export function parseEnvelope(text: unknown): Envelope | undefined {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf(ENVELOPE_MARKER)
  if (start < 0) return undefined
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(leadingObject(text.slice(start + ENVELOPE_MARKER.length))))
    return parsed.success ? (parsed.data as Envelope) : undefined
  } catch {
    return undefined
  }
}

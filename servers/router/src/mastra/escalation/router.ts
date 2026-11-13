import {
  parseEnvelope,
  renderEscalation,
  resolveDestination,
  serializeEscalation,
  type ApprovalRequest,
  type Envelope,
  type EscalationHint,
  type PublicEscalation,
} from '../../../../shared/escalation'
import type { EscalationOptions, Run } from '../../../../shared/escalation-runtime'
import type { PoppyContext } from '../poppy'
import { specialists, type SpecialistId } from '../specialists'
import { createEscalationCap } from './cap'

// Where the destination links point. The portal itself is not part of this demo.
const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL ?? 'http://localhost:3030'
const cap = createEscalationCap(Number(process.env.MAX_CONSECUTIVE_ESCALATIONS ?? 3))

// What a tool tells `finalize` about the escalation it raised. Stays inside the router.
export type StopDetail = { agent?: SpecialistId; approval?: ApprovalRequest }

// The conversation a run belongs to: the A2A context, or the PAP or MCP conversation.
const conversationOf = (run: Run) => run.thread ?? (run.requestContext?.get('poppy') as PoppyContext | undefined)?.conversationId

// The one place an escalation becomes what a caller sees, so every front door says the same:
// the destination comes from the specialist's registration, the sentence from the table, and
// only the allowlisted fields are sent.
function toPublic(hint: EscalationHint, detail: StopDetail = {}): Extract<Envelope, { kind: 'escalation' }> {
  const registration = specialists.find(specialist => specialist.id === detail.agent)?.destination
  const destination = resolveDestination(registration, hint.escalationReason, {}, PORTAL_BASE_URL)
  const text = renderEscalation({ reasonCode: hint.escalationReason, retryAfterMs: hint.retryAfterMs, destination })
  const escalation = serializeEscalation({ reasonCode: hint.escalationReason, summary: text, destination, retryAfterMs: hint.retryAfterMs, approval: detail.approval, cause: hint.cause })
  return { kind: 'escalation', text, escalation }
}

export const routerEscalation: EscalationOptions = {
  // A full application is a dozen delegations, some of them in the same step.
  maxSteps: 20,
  beforeRun: run => {
    const conversation = conversationOf(run)
    return conversation && cap.reached(conversation) ? { escalationReason: 'escalation_limit_reached', cause: 'limit' } : undefined
  },
  finalize: stop => toPublic(stop.hint, stop.detail as StopDetail | undefined),
  onSettled: (run, escalated) => {
    const conversation = conversationOf(run)
    if (conversation) cap.settle(conversation, escalated)
  },
}

// For the doors that call the router agent themselves (PAP, MCP): what to say when it threw.
export function escalationOf(error: unknown): { text: string; escalation: PublicEscalation } {
  const envelope = parseEnvelope(error instanceof Error ? error.message : error)
  return envelope?.kind === 'escalation' ? envelope : toPublic(envelope?.hint ?? { escalationReason: 'internal_error' })
}

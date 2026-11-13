import type { Destination } from './destinations'
import type { EscalationReason } from './policy'

// What the user reads. Plain language: no names of servers, models or tools, and nothing that
// confirms a record exists. `{n}` is the wait in seconds.
export const SENTENCES: Record<EscalationReason, string> = {
  service_unavailable: "I can't complete this right now.",
  rate_limited: "You've reached the request limit. Try again in about {n} seconds.",
  escalation_limit_reached: "I wasn't able to finish this in the conversation.",
  internal_error: 'Something went wrong on my side.',
  credential_expired: 'Your sign-in expired. Send your last message again after you sign in.',
  approval_required: "This needs the borrower's approval before I can continue.",
  approval_denied: "The borrower's approval was not given, so I stopped.",
  agent_steps_exhausted: "I couldn't finish this in the steps I'm allowed.",
  unsupported_request: "I can't help with that here.",
  request_rejected: "I can't do that for this request.",
  clarification_exhausted: "I still don't have what I need to continue.",
  budget_turns_exhausted: 'This conversation has reached its length limit.',
  budget_cost_exhausted: 'This conversation has reached its usage limit.',
  caller_requested_handoff: "As you asked, I'm handing this over.",
}

// Words a sentence must never contain. Checked by a test over the whole table.
export const DENYLIST = [
  'mastra',
  'router',
  'specialist',
  'agent',
  'tool',
  'model',
  'anthropic',
  'bifrost',
  'gateway',
  'guardrail',
  'access',
  'permission',
  'token',
  'error',
]

// The sentence for the code, then always the way on: the destination as a link, and what to do there.
export function renderEscalation({
  reasonCode,
  retryAfterMs,
  destination,
}: {
  reasonCode: EscalationReason
  retryAfterMs?: number
  destination: Destination
}) {
  const seconds = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000))
  const sentence = SENTENCES[reasonCode].replace('{n}', String(seconds))
  const way = `You can continue in the [${destination.label}](${destination.url}).`
  return [sentence, way, destination.instructions].filter(Boolean).join(' ')
}

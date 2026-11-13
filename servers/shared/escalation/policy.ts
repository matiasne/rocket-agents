// Why a turn ended without an answer. A closed list: a caller decides its next step from the
// code alone, so codes never name a server, a model or a tool.
export const ESCALATION_REASONS = [
  'service_unavailable',
  'rate_limited',
  'escalation_limit_reached',
  'internal_error',
  'credential_expired',
  'approval_required',
  'approval_denied',
  'agent_steps_exhausted',
  'unsupported_request',
  'request_rejected',
  'clarification_exhausted',
  'budget_turns_exhausted',
  'budget_cost_exhausted',
  'caller_requested_handoff',
] as const

export type EscalationReason = (typeof ESCALATION_REASONS)[number]

// failed         could not finish this time
// rejected       will not do this; never retryable
// auth-required  a person must act first
export type EscalationCategory = 'failed' | 'rejected' | 'auth-required'
export type FailureClass = 'terminal' | 'transient' | 'caller-action'

// What produced the escalation. Logged, and read by the router's roll-up; never sent to a caller.
export type EscalationCause = 'dependency' | 'model' | 'permission' | 'intent' | 'rule' | 'guardrail' | 'limit'

export type EscalationPolicy = {
  category: EscalationCategory
  failureClass: FailureClass
  retryable: boolean
  defaultRetryAfterMs?: number
}

export const ESCALATION_POLICY: Record<EscalationReason, EscalationPolicy> = {
  // An outage that survived every retry is not a hiccup: not retryable.
  service_unavailable: { category: 'failed', failureClass: 'terminal', retryable: false },
  // The only retryable failure. The wait comes from whoever limited the caller.
  rate_limited: { category: 'failed', failureClass: 'transient', retryable: true },
  escalation_limit_reached: { category: 'failed', failureClass: 'terminal', retryable: false },
  internal_error: { category: 'failed', failureClass: 'terminal', retryable: false },
  credential_expired: { category: 'auth-required', failureClass: 'caller-action', retryable: true, defaultRetryAfterMs: 0 },
  approval_required: { category: 'auth-required', failureClass: 'caller-action', retryable: false },
  approval_denied: { category: 'rejected', failureClass: 'terminal', retryable: false },
  agent_steps_exhausted: { category: 'rejected', failureClass: 'terminal', retryable: false },
  unsupported_request: { category: 'rejected', failureClass: 'terminal', retryable: false },
  request_rejected: { category: 'rejected', failureClass: 'terminal', retryable: false },
  clarification_exhausted: { category: 'rejected', failureClass: 'terminal', retryable: false },
  budget_turns_exhausted: { category: 'rejected', failureClass: 'terminal', retryable: false },
  budget_cost_exhausted: { category: 'rejected', failureClass: 'terminal', retryable: false },
  caller_requested_handoff: { category: 'rejected', failureClass: 'terminal', retryable: false },
}

// Codes nothing in this app produces yet: there is no sign-in, no clarification loop,
// no turn or cost budget and no handoff intent.
export const DEFERRED_PRODUCERS: readonly EscalationReason[] = [
  'credential_expired',
  'clarification_exhausted',
  'budget_turns_exhausted',
  'budget_cost_exhausted',
  'caller_requested_handoff',
]

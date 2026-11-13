import type { Destination } from './destinations'
import { ESCALATION_POLICY, type EscalationCause, type EscalationReason, type FailureClass } from './policy'

// What the borrower is asked to approve. The id is issued by the router, never by a model.
export type ApprovalRequest = { approvalId: string; action: string; details?: Record<string, unknown>; expiresAt?: string }

export type Escalation = {
  reasonCode: EscalationReason
  summary: string
  destination: Destination
  retryAfterMs?: number
  approval?: ApprovalRequest
  cause?: EscalationCause
}

// What a caller receives. Only the fields that apply are present; none is ever null.
export type PublicEscalation = {
  schemaVersion: 2
  reasonCode: EscalationReason
  summary: string
  failureClass: FailureClass
  retryable: boolean
  retryAfterMs?: number
  destination: Destination
  approval?: ApprovalRequest
}

// Field by field on purpose: anything not listed here (`cause`, fault detail) cannot leak.
export function serializeEscalation(escalation: Escalation): PublicEscalation {
  const { failureClass, retryable, defaultRetryAfterMs } = ESCALATION_POLICY[escalation.reasonCode]
  const retryAfterMs = escalation.retryAfterMs ?? defaultRetryAfterMs
  const { url, label, instructions } = escalation.destination
  return {
    schemaVersion: 2,
    reasonCode: escalation.reasonCode,
    summary: escalation.summary,
    failureClass,
    retryable,
    ...(retryable && retryAfterMs !== undefined && { retryAfterMs }),
    destination: { url, label, ...(instructions && { instructions }) },
    ...(escalation.reasonCode === 'approval_required' &&
      escalation.approval && {
        approval: {
          approvalId: escalation.approval.approvalId,
          action: escalation.approval.action,
          ...(escalation.approval.details && { details: escalation.approval.details }),
          ...(escalation.approval.expiresAt && { expiresAt: escalation.approval.expiresAt }),
        },
      }),
  }
}

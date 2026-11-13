import { encodeEnvelope, parseEnvelope, type EscalationHint } from './envelope'
import { ESCALATION_REASONS, type EscalationCause, type EscalationReason } from './policy'

type HintOptions = { retryAfterMs?: number; cause?: EscalationCause }

// Thrown by the layer that knows what its own failure means (a tool, a client, a limiter),
// so nothing above it has to map the same error again. A rate limit must say how long to wait.
export class EscalationHintError extends Error implements EscalationHint {
  readonly escalationReason: EscalationReason
  readonly retryAfterMs?: number
  readonly cause?: EscalationCause

  constructor(reason: 'rate_limited', options: HintOptions & { retryAfterMs: number })
  constructor(reason: Exclude<EscalationReason, 'rate_limited'>, options?: HintOptions)
  constructor(reason: EscalationReason, options: HintOptions = {}) {
    const hint: EscalationHint = {
      escalationReason: reason,
      ...(options.retryAfterMs !== undefined && { retryAfterMs: options.retryAfterMs }),
      ...(options.cause && { cause: options.cause }),
    }
    // The message is the envelope, so the hint survives a wrapper that keeps only the message.
    super(encodeEnvelope({ kind: 'hint', hint }))
    this.name = 'EscalationHintError'
    this.escalationReason = reason
    this.retryAfterMs = hint.retryAfterMs
    this.cause = hint.cause
  }
}

// By shape, not by class: an error may have crossed a bundle boundary or been copied.
export function hasEscalationHint(error: unknown): error is EscalationHint {
  return (
    typeof error === 'object' &&
    error !== null &&
    'escalationReason' in error &&
    ESCALATION_REASONS.includes(error.escalationReason as EscalationReason)
  )
}

// The hint an error carries, as fields or inside its message.
export function readHint(error: unknown): EscalationHint | undefined {
  if (hasEscalationHint(error)) {
    return {
      escalationReason: error.escalationReason,
      ...(typeof error.retryAfterMs === 'number' && { retryAfterMs: error.retryAfterMs }),
      ...(typeof error.cause === 'string' && { cause: error.cause }),
    }
  }
  const message = typeof error === 'string' ? error : (error as { message?: unknown } | null)?.message
  const envelope = parseEnvelope(message)
  return envelope?.kind === 'hint' ? envelope.hint : undefined
}

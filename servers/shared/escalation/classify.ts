import type { EscalationHint } from './envelope'
import { readHint } from './hint'
import type { EscalationCause, EscalationReason } from './policy'

export type Classification = {
  reasonCode: EscalationReason
  retryAfterMs?: number
  cause?: EscalationCause
  // The original error text. For the log only: the one place it survives.
  fault: string
}

const MAX_DEPTH = 6
const MODEL_FAULT_NAMES = ['AI_APICallError', 'AI_RetryError', 'AbortError', 'TimeoutError']

type ErrorLike = { name?: unknown; message?: unknown; cause?: unknown; lastError?: unknown; errors?: unknown; isRetryable?: unknown; url?: unknown }

// The error and everything it wraps, nearest first.
function chain(error: unknown) {
  const found: unknown[] = []
  let level = [error]
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
    const next: unknown[] = []
    for (const item of level) {
      if (item === undefined || item === null || found.includes(item)) continue
      found.push(item)
      if (typeof item !== 'object') continue
      const { cause, lastError, errors } = item as ErrorLike
      // Only wrapped errors: a hint's own `cause` is a label, not an error.
      next.push(...[cause, lastError, ...(Array.isArray(errors) ? errors : [])].filter(inner => typeof inner === 'object'))
    }
    level = next
  }
  return found
}

// A failed model call, recognized by shape because the errors come from a library this module does not import.
function isModelFault(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  const { name, isRetryable, url } = error as ErrorLike
  return MODEL_FAULT_NAMES.includes(name as string) || (typeof isRetryable === 'boolean' && typeof url === 'string')
}

function describe(error: unknown) {
  if (typeof error !== 'object' || error === null) return String(error)
  const { name, message } = error as ErrorLike
  return `${typeof name === 'string' ? name : 'Error'}: ${typeof message === 'string' ? message : ''}`
}

// Decides once what a thrown error means. A hint anywhere in the error wins; a failed model
// call is an outage; anything else is a defect.
export function classifyFault(error: unknown): Classification {
  const errors = chain(error)
  const fault = errors.map(describe).join(' <- ')

  let hint: EscalationHint | undefined
  for (const item of errors) {
    hint = readHint(item)
    if (hint) break
  }
  if (hint) {
    return {
      reasonCode: hint.escalationReason,
      ...(hint.retryAfterMs !== undefined && { retryAfterMs: hint.retryAfterMs }),
      ...(hint.cause && { cause: hint.cause }),
      fault,
    }
  }
  if (errors.some(isModelFault)) return { reasonCode: 'service_unavailable', cause: 'model', fault }
  return { reasonCode: 'internal_error', fault }
}

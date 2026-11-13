import { describe, expect, it } from 'vitest'
import { classifyFault } from './classify'
import { encodeEnvelope, parseEnvelope } from './envelope'
import { EscalationHintError, hasEscalationHint } from './hint'

const apiCallError = Object.assign(new Error('overloaded'), {
  name: 'AI_APICallError',
  isRetryable: true,
  url: 'https://llm.example/v1/messages',
})

describe('classifyFault', () => {
  it('reads a hint with its wait and cause', () => {
    const result = classifyFault(new EscalationHintError('rate_limited', { retryAfterMs: 15000, cause: 'limit' }))
    expect(result).toMatchObject({ reasonCode: 'rate_limited', retryAfterMs: 15000, cause: 'limit' })
  })

  it('reads a hint without a wait or cause', () => {
    const result = classifyFault(new EscalationHintError('request_rejected'))
    expect(result.reasonCode).toBe('request_rejected')
    expect(result).not.toHaveProperty('retryAfterMs')
    expect(result).not.toHaveProperty('cause')
  })

  it('finds a hint under a wrapper', () => {
    const wrapped = new Error('generate failed', { cause: new Error('step failed', { cause: new EscalationHintError('unsupported_request', { cause: 'rule' }) }) })
    expect(classifyFault(wrapped)).toMatchObject({ reasonCode: 'unsupported_request', cause: 'rule' })
  })

  it('finds a hint that survives only as message text', () => {
    const copied = new Error(`Handler failed: ${new EscalationHintError('request_rejected', { cause: 'permission' }).message}`)
    expect(classifyFault(copied)).toMatchObject({ reasonCode: 'request_rejected', cause: 'permission' })
  })

  it('prefers a hint over the model fault that wraps it', () => {
    const retry = Object.assign(new Error('retries exhausted'), { name: 'AI_RetryError', lastError: new EscalationHintError('rate_limited', { retryAfterMs: 1000 }) })
    expect(classifyFault(retry).reasonCode).toBe('rate_limited')
  })

  it('treats a failed model call as an outage', () => {
    expect(classifyFault(apiCallError)).toMatchObject({ reasonCode: 'service_unavailable', cause: 'model' })
  })

  it('treats exhausted retries as an outage through lastError', () => {
    const retry = Object.assign(new Error('retries exhausted'), { name: 'AI_RetryError', lastError: apiCallError, errors: [apiCallError] })
    expect(classifyFault(new Error('wrapper', { cause: retry }))).toMatchObject({ reasonCode: 'service_unavailable', cause: 'model' })
  })

  it('recognizes a model fault by shape when the name is unknown', () => {
    expect(classifyFault({ isRetryable: false, url: 'https://llm.example' }).reasonCode).toBe('service_unavailable')
  })

  it('treats an abort or timeout as an outage', () => {
    expect(classifyFault(Object.assign(new Error('aborted'), { name: 'AbortError' })).reasonCode).toBe('service_unavailable')
    expect(classifyFault(Object.assign(new Error('timed out'), { name: 'TimeoutError' })).reasonCode).toBe('service_unavailable')
  })

  it('treats anything else as a defect and keeps the text for the log', () => {
    const result = classifyFault(new Error('boom'))
    expect(result.reasonCode).toBe('internal_error')
    expect(result.fault).toContain('boom')
    expect(classifyFault('just a string').reasonCode).toBe('internal_error')
    expect(classifyFault(undefined).reasonCode).toBe('internal_error')
  })

  it('stops at a wrapping depth of 6 and survives a cycle', () => {
    let deep: Error = new EscalationHintError('request_rejected')
    for (let i = 0; i < 6; i++) deep = new Error(`level ${i}`, { cause: deep })
    // The hint's fields are out of reach, and so is its message.
    expect(classifyFault(deep).reasonCode).toBe('internal_error')

    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(classifyFault(a).reasonCode).toBe('internal_error')
  })
})

describe('hints and envelopes', () => {
  it('recognizes a hint by shape', () => {
    expect(hasEscalationHint({ escalationReason: 'rate_limited' })).toBe(true)
    expect(hasEscalationHint({ escalationReason: 'made_up' })).toBe(false)
    expect(hasEscalationHint(new Error('x'))).toBe(false)
    expect(hasEscalationHint(null)).toBe(false)
  })

  it('requires a wait on a rate limit hint', () => {
    // @ts-expect-error a rate limit without retryAfterMs must not compile
    new EscalationHintError('rate_limited')
  })

  it('round-trips an envelope behind any prefix', () => {
    const envelope = { kind: 'hint', hint: { escalationReason: 'service_unavailable', cause: 'dependency' } } as const
    expect(parseEnvelope(`Handler failed: ${encodeEnvelope(envelope)}`)).toEqual(envelope)
  })

  it('rejects text that is not a valid envelope', () => {
    expect(parseEnvelope('Handler failed: boom')).toBeUndefined()
    expect(parseEnvelope('[[escalation:v2]]not json')).toBeUndefined()
    expect(parseEnvelope('[[escalation:v2]]{"kind":"hint","hint":{"escalationReason":"made_up"}}')).toBeUndefined()
    expect(parseEnvelope(undefined)).toBeUndefined()
  })
})

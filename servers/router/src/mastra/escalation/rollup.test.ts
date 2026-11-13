import { describe, expect, it } from 'vitest'
import { ESCALATION_REASONS, type EscalationHint } from '../../../../shared/escalation'
import { createEscalationCap } from './cap'
import { decideRollup, MAX_UNAVAILABLE_PER_TURN, newTurn } from './rollup'

const AGENTS = ['income-employment', 'owned-properties', 'assets']
const hint = (escalationReason: EscalationHint['escalationReason'], cause?: EscalationHint['cause']): EscalationHint => ({ escalationReason, ...(cause && { cause }) })

describe('decideRollup', () => {
  it('retries an unavailable specialist until the turn has seen three failures', () => {
    const turn = newTurn()
    const decisions = Array.from({ length: MAX_UNAVAILABLE_PER_TURN }, () => decideRollup(hint('service_unavailable'), 'assets', turn, AGENTS))
    expect(decisions).toEqual(['retry', 'retry', 'escalate'])
  })

  it('never retries a rate limit', () => {
    expect(decideRollup({ escalationReason: 'rate_limited', retryAfterMs: 1000 }, 'assets', newTurn(), AGENTS)).toBe('escalate')
  })

  it('reroutes a misroute once per turn', () => {
    const turn = newTurn()
    expect(decideRollup(hint('unsupported_request', 'intent'), 'income-employment', turn, AGENTS)).toBe('reroute')
    expect(decideRollup(hint('unsupported_request', 'rule'), 'owned-properties', turn, AGENTS)).toBe('escalate')
  })

  it('does not reroute when every specialist has been asked', () => {
    expect(decideRollup(hint('unsupported_request', 'intent'), 'assets', newTurn(), ['assets'])).toBe('escalate')
  })

  it('does not reroute a guardrail stop', () => {
    expect(decideRollup(hint('unsupported_request', 'guardrail'), 'assets', newTurn(), AGENTS)).toBe('escalate')
  })

  it('escalates every other code at once', () => {
    for (const reason of ESCALATION_REASONS) {
      if (reason === 'service_unavailable' || reason === 'unsupported_request') continue
      expect(decideRollup({ escalationReason: reason }, 'assets', newTurn(), AGENTS), reason).toBe('escalate')
    }
  })
})

describe('createEscalationCap', () => {
  it('is reached after max escalations in a row, and stays reached', () => {
    const cap = createEscalationCap(3)
    for (let turn = 0; turn < 3; turn++) {
      expect(cap.reached('c1')).toBe(false)
      cap.settle('c1', hint('internal_error'))
    }
    expect(cap.reached('c1')).toBe(true)
    cap.settle('c1', hint('escalation_limit_reached', 'limit'))
    expect(cap.reached('c1')).toBe(true)
    expect(cap.reached('c2')).toBe(false)
  })

  it('counts a rate-limited turn', () => {
    const cap = createEscalationCap(1)
    cap.settle('c1', { escalationReason: 'rate_limited', retryAfterMs: 1000 })
    expect(cap.reached('c1')).toBe(true)
  })

  it('is reset by a completed turn and by a turn waiting for an approval', () => {
    const cap = createEscalationCap(2)
    cap.settle('c1', hint('internal_error'))
    cap.settle('c1', undefined)
    cap.settle('c1', hint('internal_error'))
    expect(cap.reached('c1')).toBe(false)
    cap.settle('c1', hint('approval_required'))
    cap.settle('c1', hint('internal_error'))
    expect(cap.reached('c1')).toBe(false)
  })
})

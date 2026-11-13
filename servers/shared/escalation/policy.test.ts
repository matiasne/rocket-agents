import { describe, expect, it } from 'vitest'
import { DEFERRED_PRODUCERS, ESCALATION_POLICY, ESCALATION_REASONS } from './policy'

describe('escalation policy', () => {
  it('has a policy for every code and no others', () => {
    expect(Object.keys(ESCALATION_POLICY).sort()).toEqual([...ESCALATION_REASONS].sort())
  })

  it('only lets a failed or auth-required code be retryable', () => {
    for (const reason of ESCALATION_REASONS) {
      const { category, retryable } = ESCALATION_POLICY[reason]
      if (retryable) expect(['failed', 'auth-required'], reason).toContain(category)
      if (category === 'rejected') expect(retryable, reason).toBe(false)
    }
  })

  it('makes rate_limited the only retryable failure', () => {
    const retryableFailures = ESCALATION_REASONS.filter(
      reason => ESCALATION_POLICY[reason].category === 'failed' && ESCALATION_POLICY[reason].retryable,
    )
    expect(retryableFailures).toEqual(['rate_limited'])
  })

  it('only defers known codes', () => {
    for (const reason of DEFERRED_PRODUCERS) expect(ESCALATION_REASONS).toContain(reason)
  })
})

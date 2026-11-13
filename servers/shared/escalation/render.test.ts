import { describe, expect, it } from 'vitest'
import { PLATFORM_DEFAULT, resolveDestination, validateDestination, validateDestinationPath, type EscalationDestination } from './destinations'
import { encodeEnvelope, parseEnvelope } from './envelope'
import { ESCALATION_REASONS } from './policy'
import { DENYLIST, renderEscalation, SENTENCES } from './render'
import { serializeEscalation, type Escalation } from './serialize'

const PORTAL = 'http://localhost:3030'
const destination = { url: `${PORTAL}/loans/assets`, label: 'Assets' }

describe('destinations', () => {
  it.each(['https://x', '//x', '/../x', 'x', '/\\x', '/a//b', ''])('rejects the path %j', path => {
    expect(() => validateDestinationPath(path)).toThrow()
  })

  it.each(['/', '/loans', '/loans/credit/authorization'])('accepts the path %j', path => {
    expect(() => validateDestinationPath(path)).not.toThrow()
  })

  it('validates every path a registration declares', () => {
    expect(() => validateDestination({ default: { path: '/ok', label: 'Ok' }, byReason: { approval_required: { path: '//evil', label: 'x' } } })).toThrow()
    expect(() => validateDestination(undefined)).not.toThrow()
  })

  const config: EscalationDestination<{ loanId?: string }> = {
    default: { path: '/loans/credit', label: 'Credit' },
    byReason: { approval_required: { path: '/loans/credit/authorization', label: 'Credit authorization', instructions: 'Ask the borrower.' } },
    resolve: (reason, state) => (reason === 'request_rejected' && state.loanId ? { path: `/loans/${state.loanId}`, label: 'This loan' } : undefined),
  }

  it('resolves in the order resolve, byReason, default, platform default', () => {
    expect(resolveDestination(config, 'request_rejected', { loanId: 'L1' }, PORTAL).url).toBe(`${PORTAL}/loans/L1`)
    expect(resolveDestination(config, 'approval_required', {}, PORTAL)).toEqual({
      url: `${PORTAL}/loans/credit/authorization`,
      label: 'Credit authorization',
      instructions: 'Ask the borrower.',
    })
    expect(resolveDestination(config, 'service_unavailable', {}, PORTAL)).toEqual({ url: `${PORTAL}/loans/credit`, label: 'Credit' })
    expect(resolveDestination(undefined, 'service_unavailable', {}, PORTAL)).toEqual({ url: `${PORTAL}/`, label: PLATFORM_DEFAULT.label })
  })

  it('joins the same with or without a trailing slash on the base', () => {
    expect(resolveDestination(config, 'internal_error', {}, `${PORTAL}/`).url).toBe(resolveDestination(config, 'internal_error', {}, PORTAL).url)
  })

  it('refuses a resolved path that leaves the portal', () => {
    expect(() => resolveDestination({ resolve: () => ({ path: '//evil.example', label: 'x' }) }, 'internal_error', {}, PORTAL)).toThrow()
  })
})

describe('renderEscalation', () => {
  it('has a sentence for every code, free of internal vocabulary', () => {
    for (const reason of ESCALATION_REASONS) {
      for (const word of DENYLIST) expect(SENTENCES[reason], `${reason} contains "${word}"`).not.toMatch(new RegExp(`\\b${word}`, 'i'))
    }
  })

  it('always ends with the destination link, then the instructions', () => {
    for (const reasonCode of ESCALATION_REASONS) {
      expect(renderEscalation({ reasonCode, destination })).toContain(`[Assets](${PORTAL}/loans/assets)`)
    }
    const text = renderEscalation({ reasonCode: 'approval_required', destination: { ...destination, instructions: 'Ask the borrower.' } })
    expect(text.endsWith(`You can continue in the [Assets](${PORTAL}/loans/assets). Ask the borrower.`)).toBe(true)
  })

  it('states the wait in whole seconds', () => {
    expect(renderEscalation({ reasonCode: 'rate_limited', retryAfterMs: 14200, destination })).toContain('about 15 seconds')
  })
})

describe('serializeEscalation', () => {
  const base: Escalation = { reasonCode: 'service_unavailable', summary: 'Stopped at Assets.', destination, cause: 'dependency' }

  it('never includes the cause', () => {
    for (const reasonCode of ESCALATION_REASONS) {
      expect(JSON.stringify(serializeEscalation({ ...base, reasonCode }))).not.toContain('cause')
    }
  })

  it('includes the wait only when the code is retryable', () => {
    expect(serializeEscalation({ ...base, retryAfterMs: 5000 })).not.toHaveProperty('retryAfterMs')
    expect(serializeEscalation({ ...base, reasonCode: 'rate_limited', retryAfterMs: 5000 })).toMatchObject({
      failureClass: 'transient',
      retryable: true,
      retryAfterMs: 5000,
    })
    expect(serializeEscalation({ ...base, reasonCode: 'credential_expired' }).retryAfterMs).toBe(0)
  })

  it('includes the approval only for approval_required', () => {
    const approval = { approvalId: 'a-1', action: 'credit-pull' }
    expect(serializeEscalation({ ...base, reasonCode: 'approval_required', approval }).approval).toEqual(approval)
    expect(serializeEscalation({ ...base, reasonCode: 'approval_denied', approval })).not.toHaveProperty('approval')
  })

  it('omits absent fields instead of sending null', () => {
    const json = JSON.stringify(serializeEscalation(base))
    expect(json).not.toContain('null')
    expect(Object.keys(serializeEscalation(base)).sort()).toEqual(['destination', 'failureClass', 'reasonCode', 'retryable', 'schemaVersion', 'summary'])
  })

  it('survives the trip through an envelope', () => {
    const escalation = serializeEscalation({ ...base, reasonCode: 'rate_limited', retryAfterMs: 5000 })
    const envelope = { kind: 'escalation', text: 'Try again.', escalation } as const
    expect(parseEnvelope(`Handler failed: ${encodeEnvelope(envelope)}`)).toEqual(envelope)
    expect(parseEnvelope(`${encodeEnvelope({ ...envelope, text: 'A } and a \\" inside.' })}\n    at fail (index.mjs:1)`)?.kind).toBe('escalation')
  })
})

import type { InputProcessor } from '@mastra/core/processors'
import { registerApiRoute } from '@mastra/core/server'
import { EscalationHintError } from './escalation'

// A fault to inject before the agent starts on a message, to see how the others cope with an
// agent that cannot answer. Each one goes down the same path a real fault of its kind would.
// Starts at `none` and is changed from the UI; kept in memory, so a restart resets it.
//   outage       the model call fails after its retries
//   rate-limit   a limiter turns the caller away and says how long to wait
//   denied       the caller may not do this
//   unsupported  the request is outside what this agent does
//   guardrail    a processor stops the run
//   crash        a defect: a plain error nobody labeled
export const FAULTS = ['none', 'outage', 'rate-limit', 'denied', 'unsupported', 'guardrail', 'crash'] as const
export type Fault = (typeof FAULTS)[number]

const RATE_LIMIT_WAIT_MS = 30_000
let fault: Fault = 'none'

export const faultInjector: InputProcessor = {
  id: 'fault-injector',
  processInput: async ({ messages, abort }) => {
    switch (fault) {
      case 'outage':
        throw Object.assign(new Error('Injected fault: the model provider is overloaded'), {
          name: 'AI_APICallError',
          isRetryable: true,
          url: 'https://injected.invalid/v1/messages',
        })
      case 'rate-limit':
        throw new EscalationHintError('rate_limited', { retryAfterMs: RATE_LIMIT_WAIT_MS, cause: 'limit' })
      case 'denied':
        throw new EscalationHintError('request_rejected', { cause: 'permission' })
      case 'unsupported':
        throw new EscalationHintError('unsupported_request', { cause: 'intent' })
      case 'guardrail':
        return abort('Injected fault: guardrail trip')
      case 'crash':
        throw new Error('Injected fault: boom')
    }
    return messages
  },
}

// GET /settings/fault → { fault }   PUT /settings/fault with { fault } sets it.
export const faultRoutes = [
  registerApiRoute('/settings/fault', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => c.json({ fault }),
  }),
  registerApiRoute('/settings/fault', {
    method: 'PUT',
    requiresAuth: false,
    handler: async c => {
      const body = await c.req.json().catch(() => null)
      if (!FAULTS.includes(body?.fault)) return c.json({ error: `fault must be one of ${FAULTS.join(', ')}` }, 400)
      fault = body.fault
      return c.json({ fault })
    },
  }),
]

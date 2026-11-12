import type { InputProcessor } from '@mastra/core/processors'
import { registerApiRoute } from '@mastra/core/server'

// An artificial wait before the agent starts on a message, to see how the others cope with a
// slow agent. Its A2A task stays `working` for the whole wait. Starts at RESPONSE_DELAY_MS
// (default 0) and is changed from the UI; kept in memory, so a restart resets it.
const MAX_DELAY_MS = 120_000
let delayMs = Number(process.env.RESPONSE_DELAY_MS ?? 0)

export const responseDelay: InputProcessor = {
  id: 'response-delay',
  processInput: async ({ messages, abortSignal }) => {
    if (delayMs > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delayMs)
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    return messages
  },
}

// GET /settings/delay → { delayMs }   PUT /settings/delay with { delayMs } sets it.
export const delayRoutes = [
  registerApiRoute('/settings/delay', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => c.json({ delayMs }),
  }),
  registerApiRoute('/settings/delay', {
    method: 'PUT',
    requiresAuth: false,
    handler: async c => {
      const body = await c.req.json().catch(() => null)
      const value = body?.delayMs
      if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
        return c.json({ error: `delayMs must be a whole number from 0 to ${MAX_DELAY_MS}` }, 400)
      }
      delayMs = value
      return c.json({ delayMs })
    },
  }),
]

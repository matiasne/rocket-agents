import { registerApiRoute } from '@mastra/core/server'
import { isEnabled, setEnabled, specialistIds, specialists, type SpecialistId } from './specialists'

// Lets the UI switch specialists on and off:
//   GET /specialists           every specialist and whether it is enabled
//   PUT /specialists/:id       body { enabled: boolean }
const list = () => specialists.map(({ id }) => ({ id, enabled: isEnabled(id) }))

export const specialistRoutes = [
  registerApiRoute('/specialists', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => c.json({ specialists: list() }),
  }),
  registerApiRoute('/specialists/:id', {
    method: 'PUT',
    requiresAuth: false,
    handler: async c => {
      const id = c.req.param('id') as SpecialistId
      if (!specialistIds.includes(id)) return c.json({ error: `Unknown specialist "${id}"` }, 404)
      const body = await c.req.json().catch(() => null)
      if (typeof body?.enabled !== 'boolean') return c.json({ error: 'Body must be { "enabled": boolean }' }, 400)
      setEnabled(id, body.enabled)
      return c.json({ specialists: list() })
    },
  }),
]

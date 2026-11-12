import { Mastra } from '@mastra/core/mastra'
import { delayRoutes } from '../../../shared/delay'
import { createObservability } from '../../../shared/observability'
import { routerAgent } from './agents/router-agent'
import { loanRouterMcp, setRequestAuth } from './mcp'
import { poppyRoutes } from './poppy'
import { specialistRoutes } from './specialist-routes'
import { a2aWebhook } from './tools/delegate'

// Router server. Its agent is exposed over A2A at:
//   card:     /api/.well-known/router/agent-card.json
//   endpoint: /api/a2a/router
// Specialists set to `push` report finished tasks back to the webhook route.
// A borrower's personal agent reaches it over the Personal Agent Protocol (see poppy.ts):
//   discovery:     /.well-known/poppy.json
//   conversations: /poppy/conversations
// A borrower's assistant reaches it over the Model Context Protocol (see mcp.ts):
//   endpoint: /api/mcp/router/mcp
// The UI switches specialists on and off at /specialists (see specialist-routes.ts),
// and sets this agent's own response delay at /settings/delay (every server has one).
export const mastra = new Mastra({
  agents: { routerAgent },
  observability: createObservability('router'),
  mcpServers: { router: loanRouterMcp },
  server: { port: Number(process.env.PORT ?? 4111), apiRoutes: [a2aWebhook, ...poppyRoutes, ...specialistRoutes, ...delayRoutes], mcpOptions: { setRequestAuth } },
})

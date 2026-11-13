// Model Context Protocol (MCP) front door: how a borrower's assistant (any MCP client)
// talks to this company. Mastra serves it over Streamable HTTP at /api/mcp/router/mcp.
//
// Implemented: one tool, `ask_loan_router`, that runs the router agent with the same standing
// as the PAP front door (see poppy.ts). The borrower's approval of a credit pull is asked
// with an MCP input request: the tool suspends, the client shows the terms, and the tool
// runs again with the answer.
// A slow call (a credit pull takes ~6s) continues as an MCP task (SEP-2663) for clients that
// declare the extension: they get a task handle and poll it, and the approval becomes the task's
// `input_required`. Every delegation reports progress while the call is still a live request.
// Not implemented: authorization, resources, prompts.
//
// DEMO ONLY: the borrower is whoever the `X-Borrower-Id` header says, NOT verified, and the
// endpoint has no authorization. Operations and tasks live in memory.
import type { IncomingMessage } from 'node:http'
import type { Mastra } from '@mastra/core/mastra'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { MCPServer } from '@mastra/mcp'
import { z } from 'zod'
import { escalationOf } from './escalation/router'
import { creditPullRequest, getOperation, newId, operationStatus, type PoppyContext } from './poppy'

// Reports each delegation to the client. A no-op unless it sent a progress token, and once the
// call has become a task (task runs get no `context.mcp`). A lost notification never fails the call.
function reportProgress(context: { mcp?: { progress?: (params: { progress: number; message?: string }) => Promise<void> } }) {
  let step = 0
  return (message: string) => context.mcp?.progress?.({ progress: ++step, message }).catch(() => {}) ?? Promise.resolve()
}

async function runRouter(mastra: Mastra, text: string, poppy: PoppyContext) {
  const requestContext = new RequestContext()
  requestContext.set('poppy', poppy)
  try {
    const result = await mastra.getAgent('masterAgent').generate(text, { requestContext })
    return result.text
  } catch (error) {
    // A turn the router could not answer: its fixed prose, with the link to carry on by hand.
    return escalationOf(error).text
  }
}

const askLoanRouter = createTool({
  id: 'ask_loan_router',
  description:
    "Sends the borrower's message about their mortgage loan application to the lender's router agent and returns its reply. The router hands each step (loan intake, borrower details, income, assets, liabilities, properties, credit) to a specialist agent. A credit pull first asks the borrower to approve its exact terms.",
  inputSchema: z.object({
    message: z.string().describe('What the borrower wants done, with the loan id and every value needed. The router does not remember earlier messages.'),
    conversationId: z.string().optional().describe('The conversationId returned by an earlier call, to continue the same conversation'),
  }),
  outputSchema: z.object({ reply: z.string(), conversationId: z.string() }),
  // Ids only: the terms the borrower approves stay on this server, as they do with PAP.
  suspendSchema: z.object({
    phase: z.literal('credit-pull-approval'),
    message: z.string(),
    conversationId: z.string(),
    operation_id: z.string(),
    revision: z.string(),
  }),
  resumeSchema: z.object({ approve: z.boolean().describe('Approve this credit pull (a hard inquiry)') }),
  execute: async ({ message, conversationId = newId('mcp') }, context) => {
    const mastra = context.mastra as Mastra

    // Second round: the borrower answered the input request.
    if (context.resumeData) {
      const { operation_id, revision } = context.suspendPayload!
      conversationId = context.suspendPayload!.conversationId
      if (!context.resumeData.approve) return { reply: 'You did not approve the credit pull, so your credit was not pulled.', conversationId }
      // An approval covers one revision of one operation, while it has not expired.
      const record = getOperation(operation_id)
      if (!record || record.conversationId !== conversationId || record.operation.revision !== revision || Date.parse(record.operation.expires_at) <= Date.now()) {
        return { reply: 'That approval no longer matches a pending credit pull. Ask for the credit pull again.', conversationId }
      }
      const approved = { ...record.operation, approver: 'user' as const, approved_at: Math.floor(Date.now() / 1000) }
      const reply = await runRouter(mastra, creditPullRequest(record.operation, record.loanOfficerApproved), { conversationId, operations: true, approved, progress: reportProgress(context) })
      // Report what the credit server actually did with the operation.
      const status = await operationStatus(operation_id)
      return { reply: status ? `${reply}\n\nOperation ${status.operation_id}: ${status.status}` : reply, conversationId }
    }

    const poppy: PoppyContext = { conversationId, operations: true, progress: reportProgress(context) }
    const reply = await runRouter(mastra, message, poppy)
    if (!poppy.asked) return { reply, conversationId }
    const { operation_id, revision, summary } = poppy.asked
    // A 2025-era client (see `legacy` below) cannot be sent an input request: its call ends as an error here.
    await context.suspend!({ phase: 'credit-pull-approval', message: summary, conversationId, operation_id, revision })
  },
})

export const loanRouterMcp = new MCPServer({
  id: 'router',
  name: 'Mastra × A2A demo lender',
  version: '1.0.0',
  description: "Front door for a borrower's assistant to work on the borrower's mortgage loan application.",
  instructions:
    'Use ask_loan_router for anything about the mortgage loan application. Pass the conversationId from the previous reply, and restate the loan id in every message: the router does not remember earlier messages.',
  tools: { ask_loan_router: askLoanRouter },
  // Answers within 2s stay synchronous; slower ones continue as a task. Clients without the extension always get a direct answer.
  tasks: { tools: { ask_loan_router: { mode: 'auto', syncWindowMs: 2000 } } },
  // Unset = a key per process, so a pending approval cannot be answered after a restart.
  requestState: { key: process.env.MCP_REQUEST_STATE_KEY },
  // 2025-era clients can call the tool, but cannot be asked for the borrower's approval, so no credit pull for them.
  legacy: 'stateless',
})

// Reads the borrower's id from a header. NOT verified: see the note at the top of this file.
// The id is the principal a pending approval is bound to.
export function setRequestAuth(req: IncomingMessage) {
  const header = req.headers['x-borrower-id']
  const borrower = (Array.isArray(header) ? header[0] : header) || 'anonymous'
  Object.assign(req, { auth: { token: borrower, clientId: borrower, scopes: [], extra: { sub: borrower } } })
}

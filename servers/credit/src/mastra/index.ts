import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { registerApiRoute } from '@mastra/core/server'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes, responseDelay } from '../../../shared/delay'
import { MODEL } from '../../../shared/model'

// Mock data: one credit result per loan, in memory. `~` in the paths below is /loans/{loanId}.
const resultsByLoan = new Map<string, ReturnType<typeof mockCreditResult>>()

const mockCreditResult = (loanId: string) => ({
  loanId,
  pulledAt: new Date().toISOString(),
  creditScore: 742,
  tradelines: [
    { creditor: 'Summit Auto Finance', type: 'auto', balance: 18400, monthlyPayment: 410 },
    { creditor: 'Northbank Visa', type: 'credit-card', balance: 2300, monthlyPayment: 75 },
    { creditor: 'EduLoan Servicing', type: 'student', balance: 11250, monthlyPayment: 160 },
  ],
})

// The borrower's approval of a credit pull: a PAP operation (exact terms) plus who approved it.
// The router's PAP or MCP front door collects it and sends it in the `X-Poppy-Approval` header, so it
// reaches the tool through the request context and never through text the model writes.
type BorrowerApproval = {
  operation_id: string
  revision: string
  terms: { action: string; loanId: string }
  expires_at: string
  approver: 'user' | 'agent'
}

// Pulls by operation: an approved operation is performed at most once, and a repeat gets the first result.
const pullsByOperation = new Map<string, { status: 'performing' | 'performed'; result: Promise<ReturnType<typeof mockCreditResult>> }>()

// Mock of POST ~/credit. A commit: it needs the borrower's approval and the loan officer's,
// and it is slow, so the task stays in `working` long enough to watch.
const pullCredit = createTool({
  id: 'pull-credit',
  description: "Orders a credit pull for a loan. Slow: takes several seconds. The borrower's approval is checked by the tool itself.",
  inputSchema: z.object({
    loanId: z.string(),
    loanOfficerApproval: z.boolean().describe('True only if the request says the loan officer approved the credit pull'),
  }),
  execute: async ({ loanId, loanOfficerApproval }, context) => {
    const approval = context.requestContext?.get('poppyApproval') as BorrowerApproval | undefined
    if (approval?.terms.action !== 'credit-pull' || approval.terms.loanId !== loanId) {
      return { error: `approval_required: credit not pulled. The borrower has not approved a credit pull for loan ${loanId}.` }
    }
    const earlier = pullsByOperation.get(approval.operation_id)
    if (earlier) return earlier.result
    if (Date.parse(approval.expires_at) <= Date.now()) return { error: "approval_required: credit not pulled. The borrower's approval has expired." }
    if (!loanOfficerApproval) return { error: 'Credit not pulled. Missing: loan officer approval.' }
    const pull = {
      status: 'performing' as 'performing' | 'performed',
      result: new Promise(resolve => setTimeout(resolve, 6000)).then(() => {
        resultsByLoan.set(loanId, mockCreditResult(loanId))
        pull.status = 'performed'
        return resultsByLoan.get(loanId)!
      }),
    }
    pullsByOperation.set(approval.operation_id, pull)
    return pull.result
  },
})

// What happened to an approved operation. The router's PAP and MCP front doors report it to the borrower's agent.
const operationStatus = registerApiRoute('/operations/:id', {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const pull = pullsByOperation.get(c.req.param('id') ?? '')
    return pull ? c.json({ operation_id: c.req.param('id'), status: pull.status }) : c.json({ error: 'not_found' }, 404)
  },
})

// Mock of GET ~/credit-results
const getCreditResults = createTool({
  id: 'get-credit-results',
  description: 'Reads the results of the last credit pull for a loan.',
  inputSchema: z.object({ loanId: z.string() }),
  execute: async ({ loanId }) => resultsByLoan.get(loanId) ?? { error: `No credit has been pulled for loan ${loanId}` },
})

const creditAgent = new Agent({
  id: 'credit',
  name: 'Credit',
  description: 'Pulls credit for a loan and reads the results.',
  instructions:
    'You pull credit for a mortgage loan and report the results. Always use your tools, and require a loanId. A credit pull is a commit. It needs the borrower’s approval, which the pull tool checks on its own: you cannot supply it, so when the tool answers approval_required, report that and stop. It also needs the loan officer’s approval: only state it when the request explicitly does, and never assume it. Report the credit score and every tradeline in full, because the liabilities specialist needs them.',
  model: MODEL,
  inputProcessors: [responseDelay],
  tools: { pullCredit, getCreditResults },
})

export const mastra = new Mastra({
  agents: { creditAgent },
  observability: createObservability('credit'),
  server: {
    port: Number(process.env.PORT ?? 4121),
    apiRoutes: [operationStatus, ...delayRoutes],
    middleware: [
      async (c, next) => {
        const header = c.req.header('X-Poppy-Approval')
        if (header) c.get('requestContext').set('poppyApproval', JSON.parse(Buffer.from(header, 'base64url').toString()))
        await next()
      },
    ],
  },
})

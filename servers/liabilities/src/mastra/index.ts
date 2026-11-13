import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes } from '../../../shared/delay'
import { createSpecialistAgent } from '../../../shared/escalation-runtime'
import { faultRoutes } from '../../../shared/fault'
import { MODEL } from '../../../shared/model'

const liabilityInput = z.object({
  liabilityId: z.string().optional().describe('Set to update an existing liability; leave out to add a new one'),
  creditor: z.string(),
  type: z.string().describe('For example mortgage, auto, credit-card, student'),
  balance: z.number().nonnegative(),
  monthlyPayment: z.number().nonnegative(),
  source: z.enum(['credit-pull', 'borrower']),
  confirmedByBorrower: z.boolean().describe('True only if the request says the borrower confirmed it'),
})
type Liability = z.infer<typeof liabilityInput> & { liabilityId: string }

// Mock data: liabilities per loan, in memory. `~` in the paths below is /loans/{loanId}.
const liabilitiesByLoan = new Map<string, Liability[]>()
let nextLiabilityNumber = 1

const liabilitiesOf = (loanId: string) => liabilitiesByLoan.get(loanId) ?? liabilitiesByLoan.set(loanId, []).get(loanId)!

const summary = (loanId: string) => {
  const liabilities = liabilitiesOf(loanId)
  return {
    liabilities,
    totalMonthlyPayment: liabilities.reduce((sum, l) => sum + l.monthlyPayment, 0),
    awaitingBorrowerConfirmation: liabilities.filter(l => !l.confirmedByBorrower).map(l => l.liabilityId),
  }
}

// Mock of PUT ~/liabilities (bulk upsert)
const upsertLiabilities = createTool({
  id: 'upsert-liabilities',
  description: 'Adds or updates several liabilities on a loan in one call.',
  inputSchema: z.object({ loanId: z.string(), liabilities: z.array(liabilityInput).min(1) }),
  execute: async ({ loanId, liabilities }) => {
    const existing = liabilitiesOf(loanId)
    for (const liability of liabilities) {
      const current = existing.find(l => l.liabilityId === liability.liabilityId)
      if (current) Object.assign(current, liability)
      else existing.push({ ...liability, liabilityId: `LIA-${nextLiabilityNumber++}` })
    }
    return summary(loanId)
  },
})

// Mock of GET ~/liabilities
const listLiabilities = createTool({
  id: 'list-liabilities',
  description: 'Lists the liabilities on a loan, with the monthly total and which ones the borrower has not confirmed.',
  inputSchema: z.object({ loanId: z.string() }),
  execute: async ({ loanId }) => summary(loanId),
})

const liabilitiesAgent = createSpecialistAgent({
  id: 'liabilities',
  name: 'Liabilities',
  description: 'The liabilities on a loan, populated from the credit pull and confirmed by the borrower.',
  instructions:
    'You manage the liabilities on a mortgage loan. Always use your tools, and require a loanId. Liabilities usually arrive as tradelines from a credit pull: save them with source "credit-pull" and unconfirmed. Mark one confirmed only when the request says the borrower confirmed it. Send all changes in one upsert call. Never estimate a balance or payment that was not given.',
  model: MODEL,
  tools: { upsertLiabilities, listLiabilities },
})

export const mastra = new Mastra({
  agents: { liabilitiesAgent },
  observability: createObservability('liabilities'),
  server: { port: Number(process.env.PORT ?? 4118), apiRoutes: [...delayRoutes, ...faultRoutes] },
})

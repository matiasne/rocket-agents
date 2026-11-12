import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes, responseDelay } from '../../../shared/delay'
import { MODEL } from '../../../shared/model'

type Employment = { employmentId: string; employer: string; position?: string; startDate?: string; monthlyIncome: number }
type Income = { incomeId: string; type: string; monthlyAmount: number }

// Mock data: per loan and borrower, in memory. `~` in the paths below is /loans/{loanId}.
const recordsByBorrower = new Map<string, { employments: Employment[]; incomes: Income[] }>()
let nextId = 1

const recordsOf = (loanId: string, borrowerId: string) => {
  const key = `${loanId}/${borrowerId}`
  return recordsByBorrower.get(key) ?? recordsByBorrower.set(key, { employments: [], incomes: [] }).get(key)!
}

const borrowerRef = z.object({ loanId: z.string(), borrowerId: z.string() })

// Mock of POST ~/borrowers/{borrowerId}/employments
const addEmployment = createTool({
  id: 'add-employment',
  description: 'Adds a job, with its monthly income, for a borrower.',
  inputSchema: borrowerRef.extend({
    employer: z.string(),
    position: z.string().optional(),
    startDate: z.string().optional().describe('YYYY-MM-DD'),
    monthlyIncome: z.number().nonnegative(),
  }),
  execute: async ({ loanId, borrowerId, ...job }) => {
    const employment = { employmentId: `EMP-${nextId++}`, ...job }
    recordsOf(loanId, borrowerId).employments.push(employment)
    return employment
  },
})

// Mock of POST ~/borrowers/{borrowerId}/incomes
const addIncome = createTool({
  id: 'add-income',
  description: 'Adds a non-employment income source for a borrower (for example pension, alimony, dividends).',
  inputSchema: borrowerRef.extend({ type: z.string(), monthlyAmount: z.number().nonnegative() }),
  execute: async ({ loanId, borrowerId, type, monthlyAmount }) => {
    if (/rent/i.test(type)) return { error: 'Rental income is not entered here. It comes from the owned-properties specialist.' }
    const income = { incomeId: `INC-${nextId++}`, type, monthlyAmount }
    recordsOf(loanId, borrowerId).incomes.push(income)
    return income
  },
})

// Mock of GET ~/borrowers/{borrowerId}/employments and /incomes
const listIncome = createTool({
  id: 'list-income',
  description: "Lists a borrower's employments and other incomes, with the monthly total.",
  inputSchema: borrowerRef,
  execute: async ({ loanId, borrowerId }) => {
    const { employments, incomes } = recordsOf(loanId, borrowerId)
    const totalMonthlyIncome = [...employments.map(e => e.monthlyIncome), ...incomes.map(i => i.monthlyAmount)].reduce((a, b) => a + b, 0)
    return { employments, incomes, totalMonthlyIncome }
  },
})

const incomeEmploymentAgent = new Agent({
  id: 'income-employment',
  name: 'Income and Employment',
  description: 'Employment and income for each borrower on a loan.',
  instructions:
    'You record employment and income for each borrower on a mortgage loan. Always use your tools, and require a loanId and borrowerId. Rental income does not belong here: it comes from the owned-properties specialist, so say so instead of entering it. Never estimate an amount that was not given.',
  model: MODEL,
  inputProcessors: [responseDelay],
  tools: { addEmployment, addIncome, listIncome },
})

export const mastra = new Mastra({
  agents: { incomeEmploymentAgent },
  observability: createObservability('income-employment'),
  server: { port: Number(process.env.PORT ?? 4116), apiRoutes: delayRoutes },
})

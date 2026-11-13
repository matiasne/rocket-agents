import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes } from '../../../shared/delay'
import { createSpecialistAgent } from '../../../shared/escalation-runtime'
import { faultRoutes } from '../../../shared/fault'
import { MODEL } from '../../../shared/model'

const loanTerms = z.object({
  purpose: z.enum(['purchase', 'refinance']).optional(),
  loanAmount: z.number().positive().optional(),
  productGroup: z.string().optional(),
})
type Loan = z.infer<typeof loanTerms> & { loanId: string; source: 'manual' | 'urla-import'; urlaFile?: string }

// Mock data: loans live in memory and are lost on restart.
const loans = new Map<string, Loan>()
let nextLoanNumber = 1001

function saveNewLoan(loan: Omit<Loan, 'loanId'>) {
  const loanId = `LN-${nextLoanNumber++}`
  loans.set(loanId, { loanId, ...loan })
  return loans.get(loanId)!
}

// Mock of POST /loans
const createLoan = createTool({
  id: 'create-loan',
  description: 'Creates an empty loan to be filled in entity by entity. Returns its loanId.',
  inputSchema: loanTerms,
  execute: async terms => saveNewLoan({ ...terms, source: 'manual' }),
})

// Mock of POST /urla
const importUrla = createTool({
  id: 'import-urla',
  description: 'Creates a loan from a URLA (Form 1003) file import. Returns its loanId.',
  inputSchema: z.object({ fileName: z.string() }),
  execute: async ({ fileName }) => ({
    ...saveNewLoan({ source: 'urla-import', urlaFile: fileName }),
    note: 'Mock import: the file is not parsed, so the other specialists start empty.',
  }),
})

// Mock of GET /loans/{loanId}
const getLoan = createTool({
  id: 'get-loan',
  description: 'Reads a loan.',
  inputSchema: z.object({ loanId: z.string() }),
  execute: async ({ loanId }) => loans.get(loanId) ?? { error: `Loan ${loanId} not found` },
})

// Mock of PUT /loans/{loanId}
const updateLoan = createTool({
  id: 'update-loan',
  description: "Updates a loan's core terms.",
  inputSchema: loanTerms.extend({ loanId: z.string() }),
  execute: async ({ loanId, ...terms }) => {
    const loan = loans.get(loanId)
    if (!loan) return { error: `Loan ${loanId} not found` }
    Object.assign(loan, terms)
    return loan
  },
})

const loanIntakeAgent = createSpecialistAgent({
  id: 'loan-intake',
  name: 'Loan Intake and URLA',
  description: 'Creates the loan, from a URLA file import or entity by entity, and keeps its core terms.',
  instructions:
    'You create mortgage loans and keep their core terms (purpose, amount, product group). Always use your tools. Create a loan from a file with import-urla when a file is named, otherwise with create-loan. Always state the loanId in your reply. You do not handle borrowers, income, assets, property or credit.',
  model: MODEL,
  tools: { createLoan, importUrla, getLoan, updateLoan },
})

export const mastra = new Mastra({
  agents: { loanIntakeAgent },
  observability: createObservability('loan-intake'),
  server: { port: Number(process.env.PORT ?? 4113), apiRoutes: [...delayRoutes, ...faultRoutes] },
})

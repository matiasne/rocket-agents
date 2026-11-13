import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes } from '../../../shared/delay'
import { createSpecialistAgent } from '../../../shared/escalation-runtime'
import { faultRoutes } from '../../../shared/fault'
import { MODEL } from '../../../shared/model'

type Borrower = {
  borrowerId: string
  firstName: string
  lastName: string
  email?: string
  primary: boolean
  active: boolean
  spouseBorrowerId?: string
}

// Mock data: borrowers per loan, in memory. `~` in the paths below is /loans/{loanId}.
const borrowersByLoan = new Map<string, Borrower[]>()
let nextBorrowerNumber = 1

const borrowersOf = (loanId: string) => borrowersByLoan.get(loanId) ?? borrowersByLoan.set(loanId, []).get(loanId)!
const findBorrower = (loanId: string, borrowerId: string) => borrowersOf(loanId).find(b => b.borrowerId === borrowerId)
const notFound = (borrowerId: string, loanId: string) => ({ error: `Borrower ${borrowerId} not found on loan ${loanId}` })

const borrowerRef = z.object({ loanId: z.string(), borrowerId: z.string() })

// Mock of POST ~/borrowers
const addBorrower = createTool({
  id: 'add-borrower',
  description: 'Adds a borrower or co-borrower to a loan. The first borrower becomes the primary.',
  inputSchema: z.object({ loanId: z.string(), firstName: z.string(), lastName: z.string(), email: z.string().optional() }),
  execute: async ({ loanId, ...details }) => {
    const borrowers = borrowersOf(loanId)
    const borrower = { borrowerId: `B-${nextBorrowerNumber++}`, ...details, primary: !borrowers.some(b => b.primary), active: true }
    borrowers.push(borrower)
    return borrower
  },
})

// Mock of GET ~/borrowers
const listBorrowers = createTool({
  id: 'list-borrowers',
  description: 'Lists the borrowers on a loan.',
  inputSchema: z.object({ loanId: z.string() }),
  execute: async ({ loanId }) => ({ borrowers: borrowersOf(loanId) }),
})

// Mock of PUT ~/borrowers/{borrowerId}/primary
const setPrimaryBorrower = createTool({
  id: 'set-primary-borrower',
  description: 'Makes a borrower the primary borrower of the loan.',
  inputSchema: borrowerRef,
  execute: async ({ loanId, borrowerId }) => {
    if (!findBorrower(loanId, borrowerId)) return notFound(borrowerId, loanId)
    for (const borrower of borrowersOf(loanId)) borrower.primary = borrower.borrowerId === borrowerId
    return { borrowers: borrowersOf(loanId) }
  },
})

// Mock of PUT ~/borrowers/{borrowerId}/spousal-relationship
const setSpousalRelationship = createTool({
  id: 'set-spousal-relationship',
  description: 'Records that two borrowers on the loan are spouses.',
  inputSchema: borrowerRef.extend({ spouseBorrowerId: z.string() }),
  execute: async ({ loanId, borrowerId, spouseBorrowerId }) => {
    const borrower = findBorrower(loanId, borrowerId)
    const spouse = findBorrower(loanId, spouseBorrowerId)
    if (!borrower) return notFound(borrowerId, loanId)
    if (!spouse) return notFound(spouseBorrowerId, loanId)
    borrower.spouseBorrowerId = spouseBorrowerId
    spouse.spouseBorrowerId = borrowerId
    return { borrowers: [borrower, spouse] }
  },
})

// Mock of POST ~/borrowers/{borrowerId}/deactivation
const deactivateBorrower = createTool({
  id: 'deactivate-borrower',
  description: 'Deactivates a borrower, taking them off the application without deleting their data.',
  inputSchema: borrowerRef,
  execute: async ({ loanId, borrowerId }) => {
    const borrower = findBorrower(loanId, borrowerId)
    if (!borrower) return notFound(borrowerId, loanId)
    if (borrower.primary) return { error: 'The primary borrower cannot be deactivated. Set another primary first.' }
    borrower.active = false
    return borrower
  },
})

const borrowerAgent = createSpecialistAgent({
  id: 'borrower',
  name: 'Borrower',
  description: 'The borrowers and co-borrowers on a loan.',
  instructions:
    'You manage the borrowers and co-borrowers on a mortgage loan. Always use your tools, and require a loanId. Always state each borrowerId in your reply, because other specialists need it. You do not handle declarations, income or credit.',
  model: MODEL,
  tools: { addBorrower, listBorrowers, setPrimaryBorrower, setSpousalRelationship, deactivateBorrower },
})

export const mastra = new Mastra({
  agents: { borrowerAgent },
  observability: createObservability('borrower'),
  server: { port: Number(process.env.PORT ?? 4114), apiRoutes: [...delayRoutes, ...faultRoutes] },
})

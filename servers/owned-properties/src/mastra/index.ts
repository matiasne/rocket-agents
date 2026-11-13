import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes } from '../../../shared/delay'
import { createSpecialistAgent } from '../../../shared/escalation-runtime'
import { faultRoutes } from '../../../shared/fault'
import { MODEL } from '../../../shared/model'

const propertyInput = z.object({
  address: z.string(),
  marketValue: z.number().nonnegative(),
  mortgageBalance: z.number().nonnegative().default(0),
  monthlyMortgagePayment: z.number().nonnegative().default(0),
  monthlyRentalIncome: z.number().nonnegative().default(0),
})
type OwnedProperty = z.infer<typeof propertyInput> & { propertyId: string }

// Mock data: owned properties per loan, in memory. `~` in the paths below is /loans/{loanId}.
const propertiesByLoan = new Map<string, OwnedProperty[]>()
let nextPropertyNumber = 1

const propertiesOf = (loanId: string) => propertiesByLoan.get(loanId) ?? propertiesByLoan.set(loanId, []).get(loanId)!

// Mock of POST ~/owned-properties
const addOwnedProperty = createTool({
  id: 'add-owned-property',
  description: 'Adds a property the borrowers already own, with its mortgage and rental income if any.',
  inputSchema: propertyInput.extend({ loanId: z.string() }),
  execute: async ({ loanId, ...details }) => {
    const property = { propertyId: `REO-${nextPropertyNumber++}`, ...details }
    propertiesOf(loanId).push(property)
    return property
  },
})

// Mock of GET ~/owned-properties
const listOwnedProperties = createTool({
  id: 'list-owned-properties',
  description: 'Lists the owned properties on a loan, with the rental income and mortgage liabilities they produce.',
  inputSchema: z.object({ loanId: z.string() }),
  execute: async ({ loanId }) => {
    const properties = propertiesOf(loanId)
    return {
      properties,
      // What the other specialists need from here.
      totalMonthlyRentalIncome: properties.reduce((sum, p) => sum + p.monthlyRentalIncome, 0),
      mortgageLiabilities: properties
        .filter(p => p.mortgageBalance > 0)
        .map(p => ({ propertyId: p.propertyId, balance: p.mortgageBalance, monthlyPayment: p.monthlyMortgagePayment })),
    }
  },
})

const ownedPropertiesAgent = createSpecialistAgent({
  id: 'owned-properties',
  name: 'Owned Properties (REO)',
  description: 'Real estate the borrowers already own. Feeds liabilities and rental income.',
  instructions:
    'You manage the real estate the borrowers already own (REO) on a mortgage loan. Always use your tools, and require a loanId. Rental income and mortgages on these properties are recorded here; report them in your reply so they can be passed on. Never estimate a value that was not given. The property being financed is not yours: it belongs to the subject-property specialist.',
  model: MODEL,
  tools: { addOwnedProperty, listOwnedProperties },
})

export const mastra = new Mastra({
  agents: { ownedPropertiesAgent },
  observability: createObservability('owned-properties'),
  server: { port: Number(process.env.PORT ?? 4119), apiRoutes: [...delayRoutes, ...faultRoutes] },
})

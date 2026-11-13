import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes } from '../../../shared/delay'
import { createSpecialistAgent } from '../../../shared/escalation-runtime'
import { faultRoutes } from '../../../shared/fault'
import { MODEL } from '../../../shared/model'

const propertyInput = z.object({
  address: z.string().optional(),
  propertyType: z.enum(['single-family', 'condo', 'townhouse', 'multi-unit']).optional(),
  occupancy: z.enum(['primary-residence', 'second-home', 'investment']).optional(),
  purchasePrice: z.number().positive().optional(),
})

// Mock data: one subject property per loan, in memory. `~` in the paths below is /loans/{loanId}.
const propertyByLoan = new Map<string, z.infer<typeof propertyInput>>()

// Mock of PUT ~/subject-property
const setSubjectProperty = createTool({
  id: 'set-subject-property',
  description: 'Sets or updates the property being financed. Merges with what is already recorded.',
  inputSchema: propertyInput.extend({ loanId: z.string() }),
  execute: async ({ loanId, ...details }) => {
    propertyByLoan.set(loanId, { ...propertyByLoan.get(loanId), ...details })
    return propertyByLoan.get(loanId)
  },
})

// Mock of GET ~/subject-property
const getSubjectProperty = createTool({
  id: 'get-subject-property',
  description: 'Reads the property being financed.',
  inputSchema: z.object({ loanId: z.string() }),
  execute: async ({ loanId }) => propertyByLoan.get(loanId) ?? { error: `No subject property on loan ${loanId} yet` },
})

// Mock of GET ~/subject-property/disclosures
const getDisclosures = createTool({
  id: 'get-disclosures',
  description: 'Lists the disclosures the subject property requires.',
  inputSchema: z.object({ loanId: z.string() }),
  execute: async ({ loanId }) => {
    const property = propertyByLoan.get(loanId)
    if (!property) return { error: `No subject property on loan ${loanId} yet` }
    return {
      disclosures: [
        'Lead-based paint disclosure',
        'Flood zone determination',
        ...(property.propertyType === 'condo' ? ['Condominium / HOA disclosure'] : []),
      ],
    }
  },
})

const subjectPropertyAgent = createSpecialistAgent({
  id: 'subject-property',
  name: 'Subject Property',
  description: 'The property being financed, and its disclosures.',
  instructions:
    'You manage the subject property of a mortgage loan: the property being financed. Always use your tools, and require a loanId. Valuation, insurance and taxes are not yours; they are handled later, in the third-party stage, so say so if asked. Properties the borrowers already own belong to the owned-properties specialist. Never guess a detail that was not given.',
  model: MODEL,
  tools: { setSubjectProperty, getSubjectProperty, getDisclosures },
})

export const mastra = new Mastra({
  agents: { subjectPropertyAgent },
  observability: createObservability('subject-property'),
  server: { port: Number(process.env.PORT ?? 4120), apiRoutes: [...delayRoutes, ...faultRoutes] },
})

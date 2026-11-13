import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes } from '../../../shared/delay'
import { createSpecialistAgent } from '../../../shared/escalation-runtime'
import { faultRoutes } from '../../../shared/fault'
import { MODEL } from '../../../shared/model'

// Mock data. Read-only: nothing here changes a loan.
const PRODUCT_GROUPS = [
  { id: 'conventional', name: 'Conventional', maxLtv: 97, minCreditScore: 620, baseRate: 6.625 },
  { id: 'fha', name: 'FHA', maxLtv: 96.5, minCreditScore: 580, baseRate: 6.25 },
  { id: 'va', name: 'VA', maxLtv: 100, minCreditScore: 580, baseRate: 6.125 },
  { id: 'jumbo', name: 'Jumbo', maxLtv: 80, minCreditScore: 700, baseRate: 6.875 },
]

// Mock of GET /loan-setup/product-groups
const listProductGroups = createTool({
  id: 'list-product-groups',
  description: 'Lists the product groups a loan can be set up with, and their limits.',
  inputSchema: z.object({}),
  execute: async () => ({ productGroups: PRODUCT_GROUPS }),
})

// Mock of POST /calculators/pricing
const priceScenario = createTool({
  id: 'price-scenario',
  description: 'Prices a loan scenario: which product groups it is eligible for, and at what rate.',
  inputSchema: z.object({
    loanAmount: z.number().positive(),
    propertyValue: z.number().positive(),
    creditScore: z.number().int().min(300).max(850),
  }),
  execute: async ({ loanAmount, propertyValue, creditScore }) => {
    const ltv = Math.round((loanAmount / propertyValue) * 1000) / 10
    return {
      ltv,
      products: PRODUCT_GROUPS.map(group => {
        const reasons = [
          ...(ltv > group.maxLtv ? [`LTV ${ltv}% is above the ${group.maxLtv}% limit`] : []),
          ...(creditScore < group.minCreditScore ? [`Credit score ${creditScore} is below ${group.minCreditScore}`] : []),
        ]
        // Simple mock adjustments: weaker credit and higher LTV cost more.
        const rate = group.baseRate + (creditScore < 700 ? 0.375 : creditScore < 760 ? 0.125 : 0) + (ltv > 80 ? 0.25 : 0)
        return reasons.length ? { product: group.name, eligible: false, reasons } : { product: group.name, eligible: true, rate }
      }),
    }
  },
})

const productEligibilityAgent = createSpecialistAgent({
  id: 'product-eligibility',
  name: 'Product Eligibility',
  description: 'Read-only pricing and product eligibility for a loan scenario.',
  instructions:
    'You answer product eligibility and pricing questions for a mortgage loan. Always use your tools; never guess rates or limits. You are read-only: you cannot change a loan. If the request lacks the loan amount, property value or credit score needed for pricing, say which is missing. Reply with the tool results, concisely.',
  model: MODEL,
  tools: { listProductGroups, priceScenario },
})

export const mastra = new Mastra({
  agents: { productEligibilityAgent },
  observability: createObservability('product-eligibility'),
  server: { port: Number(process.env.PORT ?? 4112), apiRoutes: [...delayRoutes, ...faultRoutes] },
})

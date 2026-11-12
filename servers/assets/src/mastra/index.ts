import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes, responseDelay } from '../../../shared/delay'
import { MODEL } from '../../../shared/model'

type Asset = { assetId: string; type: string; institution?: string; value: number; removed: boolean }

// Mock data: assets per loan, in memory. `~` in the paths below is /loans/{loanId}.
const assetsByLoan = new Map<string, Asset[]>()
let nextAssetNumber = 1

const assetsOf = (loanId: string) => assetsByLoan.get(loanId) ?? assetsByLoan.set(loanId, []).get(loanId)!

const assetRef = z.object({ loanId: z.string(), assetId: z.string() })

function setRemoved(loanId: string, assetId: string, removed: boolean) {
  const asset = assetsOf(loanId).find(a => a.assetId === assetId)
  if (!asset) return { error: `Asset ${assetId} not found on loan ${loanId}` }
  asset.removed = removed
  return asset
}

// Mock of POST ~/assets
const addAsset = createTool({
  id: 'add-asset',
  description: 'Adds an asset to a loan (for example checking, savings, retirement, gift funds).',
  inputSchema: z.object({ loanId: z.string(), type: z.string(), institution: z.string().optional(), value: z.number().nonnegative() }),
  execute: async ({ loanId, ...details }) => {
    const asset = { assetId: `AST-${nextAssetNumber++}`, ...details, removed: false }
    assetsOf(loanId).push(asset)
    return asset
  },
})

// Mock of GET ~/assets
const listAssets = createTool({
  id: 'list-assets',
  description: 'Lists the assets on a loan, with the total of those not removed.',
  inputSchema: z.object({ loanId: z.string() }),
  execute: async ({ loanId }) => {
    const assets = assetsOf(loanId)
    return { assets, totalValue: assets.filter(a => !a.removed).reduce((sum, a) => sum + a.value, 0) }
  },
})

// Mock of DELETE ~/assets/{assetId}
const removeAsset = createTool({
  id: 'remove-asset',
  description: 'Removes an asset from a loan. It can be restored later.',
  inputSchema: assetRef,
  execute: async ({ loanId, assetId }) => setRemoved(loanId, assetId, true),
})

// Mock of POST ~/assets/{assetId}/restore
const restoreAsset = createTool({
  id: 'restore-asset',
  description: 'Restores an asset that was removed.',
  inputSchema: assetRef,
  execute: async ({ loanId, assetId }) => setRemoved(loanId, assetId, false),
})

const assetsAgent = new Agent({
  id: 'assets',
  name: 'Assets',
  description: 'The assets on a loan.',
  instructions:
    'You manage the assets on a mortgage loan. Always use your tools, and require a loanId. Never estimate a value that was not given. State each assetId in your reply.',
  model: MODEL,
  inputProcessors: [responseDelay],
  tools: { addAsset, listAssets, removeAsset, restoreAsset },
})

export const mastra = new Mastra({
  agents: { assetsAgent },
  observability: createObservability('assets'),
  server: { port: Number(process.env.PORT ?? 4117), apiRoutes: delayRoutes },
})

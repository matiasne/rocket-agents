import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { createObservability } from '../../../shared/observability'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { delayRoutes, responseDelay } from '../../../shared/delay'
import { MODEL } from '../../../shared/model'

// The three sections, named after their endpoints under ~/borrowers/{borrowerId}/
// (`~` is /loans/{loanId}).
const SECTIONS = ['declaration', 'demographic-information', 'military-service'] as const
type Answers = Record<string, string | boolean>

// Mock data: answers per loan, borrower and section, in memory.
const answersByKey = new Map<string, Answers>()
const keyOf = (loanId: string, borrowerId: string, section: string) => `${loanId}/${borrowerId}/${section}`

// Mock of GET ~/borrowers/{borrowerId}/{section}
const getDeclarations = createTool({
  id: 'get-declarations',
  description: "Reads everything recorded so far for a borrower's declarations, demographic information and military service.",
  inputSchema: z.object({ loanId: z.string(), borrowerId: z.string() }),
  execute: async ({ loanId, borrowerId }) =>
    Object.fromEntries(SECTIONS.map(section => [section, answersByKey.get(keyOf(loanId, borrowerId, section)) ?? {}])),
})

// Mock of PUT ~/borrowers/{borrowerId}/{section}
const saveDeclarations = createTool({
  id: 'save-declarations',
  description: 'Saves answers the borrower gave for one section. Merges with what is already recorded.',
  inputSchema: z.object({
    loanId: z.string(),
    borrowerId: z.string(),
    section: z.enum(SECTIONS),
    answers: z.record(z.string(), z.union([z.string(), z.boolean()])).describe('Question → answer, exactly as the borrower gave it'),
    statedByBorrower: z.boolean().describe('True only if the request says these answers came from the borrower'),
  }),
  execute: async ({ loanId, borrowerId, section, answers, statedByBorrower }) => {
    if (!statedByBorrower) return { error: 'Not saved: declarations must be the borrower’s own answers.' }
    const key = keyOf(loanId, borrowerId, section)
    answersByKey.set(key, { ...answersByKey.get(key), ...answers })
    return { section, answers: answersByKey.get(key) }
  },
})

const declarationsAgent = new Agent({
  id: 'declarations',
  name: 'Declarations',
  description: "A borrower's declarations, demographic information and military service.",
  instructions:
    'You record a borrower’s declarations, demographic information and military service on a mortgage loan. These are legal statements: save only answers the request explicitly attributes to the borrower. Never infer, default or complete an answer; if something is missing or ambiguous, save nothing for it and say what the borrower still has to answer. Always use your tools, and require a loanId and borrowerId.',
  model: MODEL,
  inputProcessors: [responseDelay],
  tools: { getDeclarations, saveDeclarations },
})

export const mastra = new Mastra({
  agents: { declarationsAgent },
  observability: createObservability('declarations'),
  server: { port: Number(process.env.PORT ?? 4115), apiRoutes: delayRoutes },
})

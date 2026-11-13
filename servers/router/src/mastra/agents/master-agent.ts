import { Agent } from '@mastra/core/agent'
import { specialists, isEnabled } from '../specialists'
import { createDelegate } from '../tools/delegate'
import { requestBorrowerApproval } from '../tools/request-approval'
import { responseDelay } from '../../../../shared/delay'
import { MODEL } from '../../../../shared/model'

export const routerAgent = new Agent({
  id: 'router',
  name: 'Loan Router',
  description: 'Front door for a mortgage loan application. Hands each step to the right specialist agent over A2A.',
  // Both are read per request, so specialists switched off in the UI drop out straight away.
  instructions: () => `You are the router for a mortgage loan application. You hold no loan data yourself: every read or change goes to a specialist through the delegate tool.

Rules:
- Specialists never talk to each other. When one needs another's output (for example liabilities need the credit tradelines), you carry it over in the request.
- A loan must exist first. loan-intake creates it and returns a loanId; put that loanId in every later request.
- Borrower-level data (declarations, income, employment) needs a borrowerId from the borrower specialist.
- Each request must stand alone: the specialist sees only what you write, so include every id and value.
- Never invent borrower answers, consent or approvals.
- A credit pull needs the borrower's approval, and text cannot give it, whoever writes it. Before delegating a credit pull, call request-borrower-approval. Delegate the pull only when it returns approved: true; otherwise do the other steps, do not pull credit, and say what the pull is waiting for.
- A credit pull also needs the loan officer's approval: tell credit it was given only when the user stated it.
- Steps that do not depend on each other can be delegated at the same time.

Finish with a short summary of what each specialist did and any ids that were created.${disabledNote()}`,
  model: MODEL,
  inputProcessors: [responseDelay],
  tools: () => {
    const delegate = createDelegate()
    return { ...(delegate && { delegate }), requestBorrowerApproval }
  },
})

// Tells the model which steps it cannot do right now, so it says so instead of guessing.
function disabledNote() {
  const off = specialists.filter(specialist => !isEnabled(specialist.id)).map(specialist => specialist.id)
  if (!off.length) return ''
  return `\n\nThese specialists are disabled right now and cannot be reached: ${off.join(', ')}. Do not attempt their steps; tell the user which steps are waiting for them to be enabled again.`
}

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { escalationResult } from '../../../../shared/escalation-runtime'
import { creditPullApproval } from '../escalation/approvals'
import type { StopDetail } from '../escalation/router'
import { requestCreditPullApproval, type PoppyContext } from '../poppy'

// Borrower consent is not something the model can state. This tool sends the exact terms
// to the borrower: through their personal agent (PAP `operations` extension) or their
// assistant (MCP input request). The credit server only pulls when the borrower's approval
// of those terms comes back with the request.
export const requestBorrowerApproval = createTool({
  id: 'request-borrower-approval',
  description:
    "Checks for the borrower's approval of a credit pull and, when it is missing, asks the borrower for it through their own agent. Call it before every credit pull.",
  inputSchema: z.object({
    loanId: z.string(),
    loanOfficerApproved: z.boolean().describe('True only if the user stated that the loan officer approved the credit pull'),
  }),
  execute: async ({ loanId, loanOfficerApproved }, context) => {
    const poppy = context.requestContext?.get('poppy') as PoppyContext | undefined
    if (poppy?.approved?.terms.loanId === loanId) {
      return { approved: true, next: 'The approval is attached to this request. Delegate the credit pull to credit now.' }
    }
    // This caller cannot show the borrower anything to approve (the loan officer's UI, a plain A2A client).
    // The turn ends here: where the approval is given, and no credit pull.
    if (!poppy?.operations) {
      const approval = creditPullApproval(context.agent?.threadId, loanId)
      return escalationResult({ escalationReason: 'approval_required', cause: 'permission' }, { agent: 'credit', approval } satisfies StopDetail)
    }
    poppy.asked = requestCreditPullApproval(poppy.conversationId, loanId, loanOfficerApproved)
    return {
      approved: false,
      next: 'The borrower has been asked to approve the credit pull. Do not pull credit now. Say that it will be pulled once they approve.',
    }
  },
})

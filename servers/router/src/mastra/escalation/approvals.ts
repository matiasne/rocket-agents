import type { ApprovalRequest } from '../../../../shared/escalation'

const APPROVAL_TTL_MS = 10 * 60_000

// Approvals the router has said are needed, by conversation and loan: asking again within the
// time limit names the same approval. The id is issued here, never by a model. It identifies
// the request only: the borrower still approves through their own agent (see poppy.ts, mcp.ts).
// Kept in memory.
const issued = new Map<string, ApprovalRequest>()

export function creditPullApproval(conversation: string | undefined, loanId: string): ApprovalRequest {
  const key = `${conversation ?? ''} ${loanId}`
  const earlier = issued.get(key)
  if (earlier?.expiresAt && Date.parse(earlier.expiresAt) > Date.now()) return earlier
  const approval = {
    approvalId: crypto.randomUUID(),
    action: 'credit-pull',
    details: { loanId, inquiry: 'hard' },
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  }
  issued.set(key, approval)
  return approval
}

import { validateDestination, type EscalationDestination } from '../../../shared/escalation'

// Where the borrower's approval of a credit pull is given, for the two codes about it.
const CREDIT_AUTHORIZATION = {
  path: '/loans/credit/authorization',
  label: 'Credit authorization',
  instructions: 'Ask the borrower to approve the credit pull from their own assistant.',
}

// The specialist agents the router can hand work to. Each one runs on its own
// Mastra server and is reached only over A2A.
//
// `destination` is where a person can carry on by hand when the specialist cannot: a page of
// the loan portal, shown as a link when a turn ends as an escalation. Paths only; the router
// joins them to PORTAL_BASE_URL.
//
// Per specialist, two things can be set in `.env` (NAME = id in upper snake case):
//   <NAME>_URL            where its server lives        (default: http://localhost:<port>)
//   A2A_TRANSPORT_<NAME>  how the router waits for it   (default: A2A_TRANSPORT, else `stream`)
const SPECIALISTS = [
  { id: 'product-eligibility', port: 4112, does: 'Read-only pricing and product eligibility for a loan scenario.', destination: { default: { path: '/products', label: 'Products and eligibility' } } },
  { id: 'loan-intake', port: 4113, does: 'Creates the loan (blank or from a URLA file import) and reads or updates its core terms. Returns the loanId every other specialist needs.', destination: { default: { path: '/loans', label: 'Loan pipeline' } } },
  { id: 'borrower', port: 4114, does: 'Adds, lists and deactivates borrowers and co-borrowers, and sets the primary borrower and spousal relationships.', destination: { default: { path: '/loans/borrowers', label: 'Borrower details' } } },
  { id: 'declarations', port: 4115, does: "Records a borrower's declarations, demographic information and military service. Borrower answers only, never inferred.", destination: { default: { path: '/loans/declarations', label: 'Declarations' } } },
  { id: 'income-employment', port: 4116, does: 'Employment and income per borrower. Rental income is not entered here; it comes from owned properties.', destination: { default: { path: '/loans/income', label: 'Income and employment' } } },
  { id: 'assets', port: 4117, does: 'Assets per loan: add, list, remove and restore.', destination: { default: { path: '/loans/assets', label: 'Assets' } } },
  { id: 'liabilities', port: 4118, does: 'Liabilities per loan (bulk upsert). Normally populated from the credit pull, then confirmed by the borrower.', destination: { default: { path: '/loans/liabilities', label: 'Liabilities' } } },
  { id: 'owned-properties', port: 4119, does: 'Real estate the borrowers already own (REO). Feeds liabilities and rental income.', destination: { default: { path: '/loans/owned-properties', label: 'Owned properties' } } },
  { id: 'subject-property', port: 4120, does: 'The property being financed, and its disclosures.', destination: { default: { path: '/loans/property', label: 'Subject property' } } },
  { id: 'credit', port: 4121, does: "Pulls credit and reads the results. Slow. Needs the borrower's approval (request-borrower-approval) and the loan officer's approval.", destination: { default: { path: '/loans/credit', label: 'Credit' }, byReason: { approval_required: CREDIT_AUTHORIZATION, approval_denied: CREDIT_AUTHORIZATION } } },
] as const satisfies readonly { id: string; port: number; does: string; destination: EscalationDestination }[]

export type SpecialistId = (typeof SPECIALISTS)[number]['id']

// How the router waits for a specialist's answer:
//   stream  hold an SSE stream open (`message/stream`)
//   push    return at once and get a webhook call when the task settles (needs ROUTER_PUBLIC_URL)
//   poll    return at once and ask `tasks/get` every second
const TRANSPORTS = ['stream', 'push', 'poll'] as const
export type Transport = (typeof TRANSPORTS)[number]

function readTransport(name: string, fallback: Transport): Transport {
  const value = process.env[name]
  if (!value) return fallback
  if (!TRANSPORTS.includes(value as Transport)) throw new Error(`${name} must be one of ${TRANSPORTS.join(', ')}, got "${value}"`)
  return value as Transport
}

const defaultTransport = readTransport('A2A_TRANSPORT', 'stream')

export const specialists = SPECIALISTS.map(({ id, port, does, destination }) => {
  // A path that could leave the portal stops the server at start, not at the first escalation.
  validateDestination(destination)
  const envName = id.toUpperCase().replaceAll('-', '_')
  return {
    id,
    does,
    destination: destination as EscalationDestination,
    url: process.env[`${envName}_URL`] ?? `http://localhost:${port}`,
    transport: readTransport(`A2A_TRANSPORT_${envName}`, defaultTransport),
  }
})

export const specialistIds = SPECIALISTS.map(specialist => specialist.id) as [SpecialistId, ...SpecialistId[]]

// Specialists switched off from the UI. The router neither offers nor delegates to them.
// Kept in memory: a restart of the router enables every specialist again.
const disabled = new Set<SpecialistId>()

export const isEnabled = (id: SpecialistId) => !disabled.has(id)
export const enabledSpecialists = () => specialists.filter(specialist => isEnabled(specialist.id))

export function setEnabled(id: SpecialistId, enabled: boolean) {
  if (enabled) disabled.delete(id)
  else disabled.add(id)
}

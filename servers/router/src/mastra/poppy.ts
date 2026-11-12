// Personal Agent Protocol (PAP, "Poppy") front door: how a borrower's personal agent
// finds this company and talks to it. https://personalagentprotocol.org/docs/1.0/spec
//
// Implemented: discovery, conversations (create, messages, events, close) and the
// `operations` v3 extension, used for the borrower's approval of a credit pull.
// Not implemented: sign-in (`auth.disabled`), handoff, tasks, browser sessions.
//
// DEMO ONLY: the `Poppy-Session` JWT is decoded but its signature is NOT verified,
// so anyone can claim any user id. Conversations and operations live in memory.
import type { Mastra } from '@mastra/core/mastra'
import { RequestContext } from '@mastra/core/request-context'
import { registerApiRoute } from '@mastra/core/server'
import { specialists } from './specialists'

const PUBLIC_URL = (process.env.ROUTER_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4111}`).replace(/\/$/, '')
const CONVERSATIONS_PATH = '/poppy/conversations'
const OPERATION_TTL_MS = 10 * 60_000
const MAX_WAIT_SECONDS = 30
const CREDIT_URL = specialists.find(specialist => specialist.id === 'credit')!.url

export type Operation = {
  operation_id: string
  revision: string
  summary: string
  terms: { action: 'credit-pull'; loanId: string; inquiry: 'hard' }
  expires_at: string
}
type Approval = { operation_id: string; revision: string; approver: 'user' | 'agent'; approved_at?: number; input_type?: string }
type Message = {
  author: { type: 'agent' | 'human' }
  text?: string
  data?: Record<string, unknown>
  context?: Record<string, unknown>
  extensions?: { operations?: { operation?: Operation; approval?: Approval; declined?: object } }
}
type ConversationEvent = { id: string; type: 'message' | 'state'; created_at: string; message?: Message & { id: string; role: 'user' | 'company' }; closed?: boolean }
type Conversation = { id: string; owner: string; events: ConversationEvent[]; working: number; closed: boolean; waiters: Set<() => void> }

// What the router agent's tools see (request context key `poppy`) while they work on a message
// from the borrower's side: a PAP message, or a call through the MCP front door (see mcp.ts).
export type PoppyContext = {
  conversationId: string
  // The caller can show the borrower an operation to approve (PAP: it declared the operations extension).
  operations: boolean
  // Set by the `request-borrower-approval` tool when it asks. The MCP door reads it; PAP gets an event instead.
  asked?: Operation
  // Set only when the borrower's approval of this exact operation came with the request.
  approved?: Operation & { approver: Approval['approver']; approved_at?: number }
  // Set by the MCP door: reports each delegation to the client while it waits.
  progress?: (message: string) => Promise<void>
}

const conversations = new Map<string, Conversation>()
// One operation per conversation and loan, keyed by operation_id.
const operations = new Map<string, { operation: Operation; conversationId: string; loanOfficerApproved: boolean }>()
// Request ids already answered, so a retry gets the first response (keyed by user + request id).
const answered = new Map<string, { fingerprint: string; status: 201 | 202; body: object }>()

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`

function append(conversation: Conversation, event: Omit<ConversationEvent, 'id' | 'created_at'>) {
  conversation.events.push({ id: newId('evt'), created_at: new Date().toISOString(), ...event })
  notify(conversation)
}

function notify(conversation: Conversation) {
  for (const wake of conversation.waiters) wake()
}

const say = (conversation: Conversation, message: Omit<Message, 'author'>) =>
  append(conversation, { type: 'message', message: { id: newId('msg'), role: 'company', author: { type: 'agent' }, ...message } })

// Called by the router agent's `request-borrower-approval` tool: states the exact terms of
// the credit pull as an operation to approve. A PAP conversation gets it as a message;
// the MCP door (no PAP conversation) shows the returned operation to its caller itself.
export function requestCreditPullApproval(conversationId: string, loanId: string, loanOfficerApproved: boolean) {
  let record = [...operations.values()].find(
    candidate => candidate.conversationId === conversationId && candidate.operation.terms.loanId === loanId,
  )
  // Same action, new terms (here: a new expiry) = same operation_id, new revision.
  if (!record || Date.parse(record.operation.expires_at) <= Date.now()) {
    const operation: Operation = {
      operation_id: record?.operation.operation_id ?? newId('op'),
      revision: newId('rev'),
      summary: `Pull your credit report for loan **${loanId}**. This is a **hard inquiry** and can affect your credit score.`,
      terms: { action: 'credit-pull', loanId, inquiry: 'hard' },
      expires_at: new Date(Date.now() + OPERATION_TTL_MS).toISOString(),
    }
    record = { operation, conversationId, loanOfficerApproved }
    operations.set(operation.operation_id, record)
  }
  record.loanOfficerApproved = loanOfficerApproved
  const conversation = conversations.get(conversationId)
  if (conversation) {
    say(conversation, { text: 'Your approval is needed before your credit is pulled.', extensions: { operations: { operation: record.operation } } })
  }
  return record.operation
}

export const getOperation = (operationId: string) => operations.get(operationId)

// The request for an approved pull is rebuilt from the approved terms, so earlier steps are not repeated.
export const creditPullRequest = (operation: Operation, loanOfficerApproved: boolean) =>
  `Pull credit for loan ${operation.terms.loanId} and report the credit score and tradelines.${
    loanOfficerApproved ? ' The loan officer has approved the credit pull.' : ''
  }`

async function runRouter(mastra: Mastra, conversation: Conversation, text: string, poppy: PoppyContext) {
  conversation.working++
  notify(conversation)
  try {
    const requestContext = new RequestContext()
    requestContext.set('poppy', poppy)
    const result = await mastra.getAgent('routerAgent').generate(text, { requestContext })
    // After an approved run, report what the credit server actually did with the operation.
    const status = poppy.approved && (await operationStatus(poppy.approved.operation_id))
    say(conversation, { text: result.text, ...(status && { data: { operation: status } }) })
  } catch (error) {
    say(conversation, { text: `Something went wrong: ${error instanceof Error ? error.message : String(error)}` })
  } finally {
    conversation.working--
    notify(conversation)
  }
}

export async function operationStatus(operationId: string) {
  const res = await fetch(`${CREDIT_URL}/operations/${operationId}`).catch(() => undefined)
  return res?.ok ? ((await res.json()) as { operation_id: string; status: string }) : undefined
}

// An approval covers one revision of one operation. The message text approves nothing.
function handleApproval(mastra: Mastra, conversation: Conversation, approval: Approval, supportsOperations: boolean) {
  const record = operations.get(approval.operation_id)
  if (!record || record.conversationId !== conversation.id) {
    const declined = { operation_id: approval.operation_id, revision: approval.revision, reason: 'Unknown operation.' }
    return say(conversation, { text: 'That approval does not match any pending operation.', extensions: { operations: { declined } } })
  }
  const { operation, loanOfficerApproved } = record
  if (approval.revision !== operation.revision || Date.parse(operation.expires_at) <= Date.now()) {
    // Nothing is performed: the current terms go back to be approved again.
    requestCreditPullApproval(conversation.id, operation.terms.loanId, loanOfficerApproved)
    return
  }
  const text = creditPullRequest(operation, loanOfficerApproved)
  const approved = { ...operation, approver: approval.approver, approved_at: approval.approved_at }
  void runRouter(mastra, conversation, text, { conversationId: conversation.id, operations: supportsOperations, approved })
}

type RouteContext = Parameters<NonNullable<Parameters<typeof registerApiRoute>[1]['handler']>>[0]

// Reads the user id from the session JWT. NOT verified: see the note at the top of this file.
function sessionUser(c: RouteContext) {
  try {
    const payload = JSON.parse(Buffer.from((c.req.header('Poppy-Session') ?? '').split('.')[1], 'base64url').toString())
    return typeof payload.sub === 'string' && payload.sub ? (payload.sub as string) : undefined
  } catch {
    return undefined
  }
}

const invalidSession = (c: RouteContext) => c.json({ error: 'invalid_session' }, 401)

// POST a message: to a new conversation (201) or an existing one (202).
async function receive(c: RouteContext, conversationId?: string) {
  const user = sessionUser(c)
  if (!user) return invalidSession(c)
  const body = await c.req.json().catch(() => undefined)
  const message: Message | undefined = body?.message
  if (
    typeof body?.id !== 'string' ||
    !['agent', 'human'].includes(message?.author?.type ?? '') ||
    !(message?.text || message?.data || message?.context || message?.extensions)
  ) {
    return c.json({ error: 'invalid_request' }, 400)
  }

  const fingerprint = `${c.req.path} ${JSON.stringify(body)}`
  const earlier = answered.get(`${user} ${body.id}`)
  if (earlier) {
    return earlier.fingerprint === fingerprint ? c.json(earlier.body, earlier.status) : c.json({ error: 'request_id_conflict' }, 409)
  }

  let conversation = conversationId ? conversations.get(conversationId) : undefined
  if (conversationId && conversation?.owner !== user) return c.json({ error: 'conversation_not_found' }, 404)
  if (conversation?.closed) return c.json({ error: 'conversation_closed' }, 409)
  if (!conversation) {
    conversation = { id: newId('cnv'), owner: user, events: [], working: 0, closed: false, waiters: new Set() }
    conversations.set(conversation.id, conversation)
  }
  const status = conversationId ? 202 : 201
  const response = { conversation_id: conversation.id }
  answered.set(`${user} ${body.id}`, { fingerprint, status, body: response })

  // The request id becomes the message id.
  append(conversation, { type: 'message', message: { ...message!, id: body.id, role: 'user' } })
  const supportsOperations = /"operations"\s*;\s*v="3"/.test(c.req.header('Poppy-Extensions') ?? '')
  const mastra = c.get('mastra')
  const approval = message!.extensions?.operations?.approval
  // The company's reply arrives later, as events.
  if (approval) handleApproval(mastra, conversation, approval, supportsOperations)
  else if (message!.text) void runRouter(mastra, conversation, message!.text, { conversationId: conversation.id, operations: supportsOperations })
  return c.json(response, status)
}

const snapshot = (conversation: Conversation) => ({
  working: conversation.working > 0,
  handoff: 'none',
  responder: 'agent',
  closed: conversation.closed,
})

const discovery = registerApiRoute('/.well-known/poppy.json', {
  method: 'GET',
  requiresAuth: false,
  handler: async c =>
    c.json({
      protocol_version: '1.0',
      supported_versions: ['1.0'],
      organization: { name: 'Mastra × A2A demo lender', domain: new URL(PUBLIC_URL).host },
      // No sign-in: every conversation is a signed-out session.
      auth: { disabled: true },
      agent: { protocols: [{ type: 'poppy', endpoint: `${PUBLIC_URL}${CONVERSATIONS_PATH}`, access: 'session' }] },
      extensions: { operations: [{ version: '3' }] },
    }),
})

const createConversation = registerApiRoute(CONVERSATIONS_PATH, {
  method: 'POST',
  requiresAuth: false,
  handler: async c => receive(c),
})

const postMessage = registerApiRoute(`${CONVERSATIONS_PATH}/:id/messages`, {
  method: 'POST',
  requiresAuth: false,
  handler: async c => receive(c, c.req.param('id')),
})

// Events after `cursor`. Long-poll (`wait` seconds) by default, an SSE stream when asked for one.
const readEvents = registerApiRoute(`${CONVERSATIONS_PATH}/:id/events`, {
  method: 'GET',
  requiresAuth: false,
  handler: async c => {
    const user = sessionUser(c)
    if (!user) return invalidSession(c)
    const conversation = conversations.get(c.req.param('id') ?? '')
    if (conversation?.owner !== user) return c.json({ error: 'conversation_not_found' }, 404)

    const cursor = c.req.header('Last-Event-ID') ?? c.req.query('cursor')
    let position = cursor ? conversation.events.findIndex(event => event.id === cursor) + 1 : 0
    if (cursor && position === 0) return c.json({ error: 'invalid_cursor' }, 400)
    // Resolves on the next change to the conversation, or after `ms`.
    const changed = (ms: number) =>
      new Promise<void>(resolve => {
        const wake = () => {
          conversation.waiters.delete(wake)
          resolve()
        }
        conversation.waiters.add(wake)
        void sleep(ms).then(wake)
      })

    if (c.req.header('Accept')?.includes('text/event-stream')) {
      const encoder = new TextEncoder()
      let open = true
      const body = new ReadableStream({
        async start(controller) {
          let working: boolean | undefined
          while (open) {
            for (const event of conversation.events.slice(position)) {
              controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`))
            }
            position = conversation.events.length
            if (working !== conversation.working > 0) {
              working = conversation.working > 0
              controller.enqueue(encoder.encode(`event: working\ndata: ${JSON.stringify({ working })}\n\n`))
            }
            if (conversation.closed && !working) break
            await changed(15_000)
          }
          if (open) controller.close()
        },
        cancel() {
          open = false
        },
      })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' } })
    }

    const wait = Number(c.req.query('wait') ?? 0)
    if (!Number.isFinite(wait) || wait < 0) return c.json({ error: 'invalid_request' }, 400)
    const wasWorking = conversation.working > 0
    const deadline = Date.now() + Math.min(wait, MAX_WAIT_SECONDS) * 1000
    // Return on a new event, or when `working` flips, whichever comes first.
    while (conversation.events.length === position && conversation.working > 0 === wasWorking && Date.now() < deadline) {
      await changed(deadline - Date.now())
    }
    const events = conversation.events.slice(position)
    return c.json({
      conversation_id: conversation.id,
      events,
      cursor: events.at(-1)?.id ?? cursor ?? null,
      has_more: false,
      ...snapshot(conversation),
    })
  },
})

const closeConversation = registerApiRoute(`${CONVERSATIONS_PATH}/:id/close`, {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const user = sessionUser(c)
    if (!user) return invalidSession(c)
    const conversation = conversations.get(c.req.param('id') ?? '')
    if (conversation?.owner !== user) return c.json({ error: 'conversation_not_found' }, 404)
    if (!conversation.closed) {
      conversation.closed = true
      append(conversation, { type: 'state', closed: true })
    }
    return c.json({ conversation_id: conversation.id }, 202)
  },
})

export const poppyRoutes = [discovery, createConversation, postMessage, readEvents, closeConversation]

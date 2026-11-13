import { MastraClient } from '@mastra/client-js'
import type { Task } from '@mastra/core/a2a'
import { registerApiRoute } from '@mastra/core/server'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { EscalationHintError, parseEnvelope, readHint, type EscalationHint } from '../../../../shared/escalation'
import { escalationResult } from '../../../../shared/escalation-runtime'
import { decideRollup, newTurn, type Turn } from '../escalation/rollup'
import type { StopDetail } from '../escalation/router'
import type { PoppyContext } from '../poppy'
import { enabledSpecialists, isEnabled, specialists, type SpecialistId } from '../specialists'

// Base URL where the specialist servers can reach this server. Mastra refuses to
// deliver push notifications to localhost or private addresses, so this must be
// public (locally: a tunnel to port 4111). Unset = `push` falls back to polling.
const ROUTER_PUBLIC_URL = process.env.ROUTER_PUBLIC_URL?.replace(/\/$/, '')
const WEBHOOK_PATH = '/webhooks/a2a'
// Push delivery is not retried, so after this long we check on the task ourselves.
const WEBHOOK_TIMEOUT_MS = 120_000
// The states Mastra sends a push notification for.
const SETTLED_STATES = ['completed', 'failed', 'canceled', 'rejected', 'input-required', 'auth-required']

const clients = new Map(
  specialists.map(specialist => [specialist.id, new MastraClient({ baseUrl: specialist.url }).getA2A(specialist.id)]),
)

if (!ROUTER_PUBLIC_URL && specialists.some(specialist => specialist.transport === 'push')) {
  console.warn('ROUTER_PUBLIC_URL is not set: specialists configured for `push` will be polled instead.')
}

// Delegations waiting for their webhook, keyed by the secret token sent with each one.
const pending = new Map<string, (task: Task) => void>()

const sleep = (ms: number) => new Promise<undefined>(resolve => setTimeout(resolve, ms))

// A specialist that answered, but not with a task: the escalation it reported, or a defect.
function unwrapTask(response: object): Task {
  if ('error' in response && response.error) {
    const hint = hintIn((response.error as { message?: unknown }).message)
    if (!hint) console.warn(`Specialist error: ${JSON.stringify(response.error)}`)
    throw hintError(hint ?? { escalationReason: 'internal_error' })
  }
  const result = 'result' in response ? (response.result as Task | { kind: 'message' }) : undefined
  if (result?.kind !== 'task') throw new EscalationHintError('internal_error')
  return result
}

const hintError = ({ escalationReason, ...options }: EscalationHint) => new EscalationHintError(escalationReason as 'rate_limited', options as { retryAfterMs: number })

// The hint a specialist put in the text of a failed task or of an error.
function hintIn(text: unknown): EscalationHint | undefined {
  const envelope = parseEnvelope(text)
  if (envelope?.kind === 'hint') return envelope.hint
  // An agent that finalizes its own escalations (another router) sends the public form.
  if (envelope) return { escalationReason: envelope.escalation.reasonCode, ...(envelope.escalation.retryAfterMs !== undefined && { retryAfterMs: envelope.escalation.retryAfterMs }) }
  return undefined
}

// How a settled task ended: with a reply, or as an escalation. A task that failed without
// saying why is a defect; its text goes to the log and no further.
function outcomeOf(agent: string, task: Task): { reply: string } | { hint: EscalationHint } {
  if (task.status.state === 'completed') return { reply: taskText(task) }
  const hint = hintIn(taskText(task))
  if (!hint) console.warn(`${agent} task ended as ${task.status.state}: ${taskText(task)}`)
  return { hint: hint ?? { escalationReason: 'internal_error' } }
}

// The turn each run of the router is on, by its request context (one per message received).
const turns = new WeakMap<object, Turn>()

function turnOf(requestContext: object | undefined) {
  if (!requestContext) return newTurn()
  return turns.get(requestContext) ?? turns.set(requestContext, newTurn()).get(requestContext)!
}

function taskText(task: Task) {
  const parts = [...(task.artifacts ?? []).flatMap(artifact => artifact.parts), ...(task.status.message?.parts ?? [])]
  return parts.flatMap(part => (part.kind === 'text' ? [part.text] : [])).join('\n')
}

// A specialist server calls this when a delegated task settles (A2A push notification).
// The body is the full task; the token proves the call is for one of our delegations.
export const a2aWebhook = registerApiRoute(WEBHOOK_PATH, {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const resolve = pending.get(c.req.header('X-A2A-Notification-Token') ?? '')
    if (!resolve) return c.json({ error: 'Unknown notification token' }, 401)
    resolve(await c.req.json())
    return c.body(null, 204)
  },
})

// Built per request from the specialists enabled at that moment, so the model is only
// offered the ones it may use. Undefined when every specialist is disabled.
export function createDelegate() {
  const available = enabledSpecialists()
  if (!available.length) return undefined
  return createTool({
    id: 'delegate',
    description: `Sends a request to one specialist agent and returns its reply. Specialists:\n${available
      .map(specialist => `- ${specialist.id}: ${specialist.does}`)
      .join('\n')}`,
    inputSchema: z.object({
      agent: z.enum(available.map(specialist => specialist.id) as [SpecialistId, ...SpecialistId[]]),
      request: z
        .string()
        .describe('Self-contained instruction for the specialist, with the loan id and every value it needs. It cannot see the conversation.'),
    }),
    execute: async ({ agent, request }, context) => {
      const detail: StopDetail = { agent }
      // It may have been disabled while the router was already working on the message.
      if (!isEnabled(agent)) return escalationResult({ escalationReason: 'service_unavailable', cause: 'dependency' }, detail)
      const { transport, url } = specialists.find(specialist => specialist.id === agent)!
      const poppy = context.requestContext?.get('poppy') as PoppyContext | undefined
      // The borrower's approval of a credit pull (given over PAP or MCP) travels with the request, outside the text the model writes.
      const a2a =
        agent === 'credit' && poppy?.approved
          ? new MastraClient({
              baseUrl: url,
              headers: { 'X-Poppy-Approval': Buffer.from(JSON.stringify(poppy.approved)).toString('base64url') },
            }).getA2A(agent)
          : clients.get(agent)!
      const turn = turnOf(context.requestContext)

      // One task on the specialist, followed until it settles.
      const attempt = async () => {
        const message = {
          kind: 'message' as const,
          role: 'user' as const,
          messageId: crypto.randomUUID(),
          // Same context as the router's own task, so the specialist's trace joins the same session.
          contextId: context.agent?.threadId ?? poppy?.conversationId,
          parts: [{ kind: 'text' as const, text: request }],
        }
        const token = crypto.randomUUID()
        const notified = new Promise<Task>(resolve => pending.set(token, resolve))

        try {
          let task: Task
          if (transport === 'stream') {
            // Follow the task's events until the specialist closes the stream, then read the result.
            let taskId: string | undefined
            for await (const event of a2a.sendMessageStream({ message })) {
              if ('taskId' in event && event.taskId) taskId = event.taskId
              else if ('status' in event && 'id' in event) taskId = event.id
            }
            if (!taskId) throw new EscalationHintError('internal_error')
            task = unwrapTask(await a2a.getTask({ id: taskId }))
          } else {
            const push = transport === 'push' && ROUTER_PUBLIC_URL
            // `blocking: false` returns as soon as the task exists, while it is still `working`.
            task = unwrapTask(
              await a2a.sendMessage({
                message,
                configuration: {
                  blocking: false,
                  ...(push && { pushNotificationConfig: { url: `${ROUTER_PUBLIC_URL}${WEBHOOK_PATH}`, token } }),
                },
              }),
            )
            // No stream and no polling: wait for the specialist's server to call the webhook.
            if (push) task = (await Promise.race([notified, sleep(WEBHOOK_TIMEOUT_MS)])) ?? task
          }

          // `poll`, and the fallback when a stream or webhook ended early.
          while (!SETTLED_STATES.includes(task.status.state)) {
            await sleep(1000)
            task = unwrapTask(await a2a.getTask({ id: task.id }))
          }

          await poppy?.progress?.(`${agent}: ${task.status.state}`)
          return outcomeOf(agent, task)
        } catch (error) {
          // Anything else thrown on the way is the specialist's server not answering.
          const hint = readHint(error)
          if (!hint) console.warn(`${agent} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
          return { hint: hint ?? ({ escalationReason: 'service_unavailable', cause: 'dependency' } as EscalationHint) }
        } finally {
          pending.delete(token)
        }
      }

      await poppy?.progress?.(`Asking ${agent}…`)
      for (;;) {
        const outcome = await attempt()
        if ('reply' in outcome) return outcome
        const decision = decideRollup(
          outcome.hint,
          agent,
          turn,
          enabledSpecialists().map(specialist => specialist.id),
        )
        if (decision === 'retry') await poppy?.progress?.(`Asking ${agent} again…`)
        // The model picks the specialist that does handle it; the user never sees this one's refusal.
        else if (decision === 'reroute') return { reply: `${agent} does not handle this request. Delegate it to the specialist that does.` }
        // Ends the turn: the router's escalation gate stops the run on this result.
        else return escalationResult(outcome.hint, detail)
      }
    },
  })
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { ReadableStream } from 'node:stream/web'
import { Agent } from '@mastra/core/agent'
import type { OutputProcessor } from '@mastra/core/processors'
import type { RequestContext } from '@mastra/core/request-context'
import { responseDelay } from './delay'
import { classifyFault, encodeEnvelope, readHint, type Envelope, type EscalationHint } from './escalation'
import { faultInjector } from './fault'

// How an agent on a Mastra server ends a turn as an escalation.
//
// Mastra's A2A handler knows three endings: completed, suspended, and "the run threw", which it
// reports as a failed task carrying the error message. So every escalation leaves the agent as
// a thrown error whose message is an envelope (see escalation/envelope.ts):
//   a tool throws EscalationHintError   → `escalatingTool` turns it into a marked result
//   the marked result                   → `escalationGate` stops the run: no further model step
//   a stopped run, a fault, a step cap  → `withEscalation` throws the envelope
// A tool cannot stop the run by throwing: Mastra hands a thrown tool error back to the model.

const SENTINEL = '__escalation'

type Stop = { hint: EscalationHint; detail?: unknown }

// A tool result that ends the turn. `detail` is for the agent's own `finalize`; it never leaves the process.
export const escalationResult = (hint: EscalationHint, detail?: unknown) => ({ [SENTINEL]: { hint, detail } as Stop })

function stopOf(value: unknown): Stop | undefined {
  if (typeof value !== 'object' || value === null || !(SENTINEL in value)) return undefined
  const stop = (value as Record<string, unknown>)[SENTINEL] as Stop | undefined
  return stop?.hint ? stop : undefined
}

type Executable = { execute?: (...args: any[]) => unknown }

// Lets a tool end the turn by throwing an EscalationHintError. Other errors still go back to the model.
export function escalatingTool<T extends Executable>(tool: T): T {
  const execute = tool.execute
  if (!execute) return tool
  tool.execute = async (...args: unknown[]) => {
    try {
      return await execute.apply(tool, args)
    } catch (error) {
      const hint = readHint(error)
      if (!hint) throw error
      return escalationResult(hint)
    }
  }
  return tool
}

export const escalationGate: OutputProcessor = {
  id: 'escalation-gate',
  processToolResult: ({ result, abort }) => {
    const stop = stopOf(result)
    if (stop) abort('escalation', { metadata: stop })
  },
}

export type Run = { requestContext?: RequestContext; thread?: string }

export type EscalationOptions = {
  // The most model steps one run may take. Reaching it ends the turn as agent_steps_exhausted.
  maxSteps: number
  // Checked before the model is called. A hint ends the turn at once.
  beforeRun?: (run: Run) => EscalationHint | undefined
  // What the task fails with. Default: the hint as it is, for the router to roll up.
  finalize?: (stop: Stop, run: Run) => Envelope
  // Called once per run with how it ended.
  onSettled?: (run: Run, escalated: EscalationHint | undefined) => void
}

type Output = {
  error?: unknown
  tripwire?: { reason: string; metadata?: unknown }
  finishReason?: unknown
  fullStream: AsyncIterable<{ type?: string; payload?: { error?: unknown } }>
}

const SUSPENSION_CHUNKS = ['tool-call-suspended', 'tool-call-approval']

// Some agent methods call others (an approval resumes through `resumeStream`). Only the outermost call is guarded.
const guarded = new AsyncLocalStorage<true>()

// Guards the four methods Mastra's handlers call on an agent, so that every way a run can end
// without an answer becomes one thrown envelope.
export function withEscalation<A extends Agent<any, any, any, any>>(agent: A, options: EscalationOptions): A {
  const runOf = (callOptions: unknown): Run => {
    const { requestContext, memory } = (callOptions ?? {}) as { requestContext?: RequestContext; memory?: { thread?: unknown } }
    return { requestContext, ...(typeof memory?.thread === 'string' && { thread: memory.thread }) }
  }

  const fail = (stop: Stop, run: Run, fault?: string) => {
    // The fault text stays here, in the log. The caller gets the code.
    console.warn(JSON.stringify({ event: 'escalation', agent: agent.id, reasonCode: stop.hint.escalationReason, cause: stop.hint.cause, fault }))
    options.onSettled?.(run, stop.hint)
    return new Error(encodeEnvelope(options.finalize?.(stop, run) ?? { kind: 'hint', hint: stop.hint }))
  }

  const failFromFault = (error: unknown, run: Run) => {
    const { reasonCode, retryAfterMs, cause, fault } = classifyFault(error)
    return fail({ hint: { escalationReason: reasonCode, ...(retryAfterMs !== undefined && { retryAfterMs }), ...(cause && { cause }) } }, run, fault)
  }

  // A run that returned normally but did not answer.
  const stopIn = (tripwire: Output['tripwire'], finishReason: unknown): Stop | undefined => {
    // Stopped by a processor: by the gate with a hint, or by a guardrail without one.
    if (tripwire) return stopOf({ [SENTINEL]: tripwire.metadata }) ?? { hint: { escalationReason: 'unsupported_request', cause: 'guardrail' } }
    // The model still wanted to call tools when the step cap cut it off.
    if (finishReason === 'tool-calls') return { hint: { escalationReason: 'agent_steps_exhausted' } }
    return undefined
  }

  const start = (run: Run) => {
    const early = options.beforeRun?.(run)
    if (early) throw fail({ hint: early }, run)
  }

  async function* watch(output: Output, run: Run) {
    let suspended = false
    let streamError: unknown
    try {
      for await (const chunk of output.fullStream) {
        if (SUSPENSION_CHUNKS.includes(chunk.type ?? '')) suspended = true
        if (chunk.type === 'error') streamError = chunk.payload?.error ?? chunk.payload
        yield chunk
      }
    } catch (error) {
      throw failFromFault(error, run)
    }
    const error = output.error ?? streamError
    if (error) throw failFromFault(error, run)
    const stop = suspended ? undefined : stopIn(output.tripwire, await output.finishReason)
    if (stop) throw fail(stop, run)
    options.onSettled?.(run, undefined)
  }

  const guard = (method: 'generate' | 'resumeGenerate' | 'stream' | 'resumeStream') => {
    const original = (agent[method] as (...args: unknown[]) => Promise<Output>).bind(agent)
    const streaming = method === 'stream' || method === 'resumeStream'
    ;(agent as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      if (guarded.getStore()) return original(...args)
      const run = runOf(args[1])
      start(run)
      let output: Output
      try {
        output = await guarded.run(true, () => original(...args))
      } catch (error) {
        throw failFromFault(error, run)
      }
      if (!streaming) {
        const stop = output.finishReason === 'suspended' ? undefined : stopIn(output.tripwire, output.finishReason)
        if (stop) throw fail(stop, run)
        options.onSettled?.(run, undefined)
        return output
      }
      // Everything but the chunk stream is read from the real output; its getters use private fields.
      let chunks: ReadableStream | undefined
      return new Proxy(output, {
        get(target, property) {
          if (property === 'fullStream') return (chunks ??= ReadableStream.from(watch(target, run)))
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
  }

  guard('generate')
  guard('resumeGenerate')
  guard('stream')
  guard('resumeStream')
  return agent
}

type AgentConfig = ConstructorParameters<typeof Agent>[0]

// A specialist: the response delay and fault switch on the way in, the gate on its tools, and
// a guarded run. `tools` must be a plain record so each one can be wrapped.
export function createSpecialistAgent(config: AgentConfig & { tools: Record<string, Executable> }, { maxSteps = 8 } = {}) {
  for (const tool of Object.values(config.tools)) escalatingTool(tool)
  const agent = new Agent({
    ...config,
    inputProcessors: [responseDelay, faultInjector],
    outputProcessors: [escalationGate],
    defaultOptions: { maxSteps },
  })
  return withEscalation(agent, { maxSteps })
}

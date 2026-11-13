import type { EscalationHint } from '../../../../shared/escalation'

// What the router does when a specialist ends a delegation as an escalation. The router is on
// the inside, so it reads the hint's cause, and what it retries here is never a caller's retry.
//   retry     ask the same specialist again
//   reroute   tell the model, so it can pick the specialist that does handle it
//   escalate  end the turn with this code
export type RollupDecision = 'retry' | 'reroute' | 'escalate'

// How many times one turn may find a specialist unavailable before giving up.
export const MAX_UNAVAILABLE_PER_TURN = 3

// One turn of the router: everything it delegates for one message.
export type Turn = { unavailable: number; rerouted: boolean; tried: Set<string> }

export const newTurn = (): Turn => ({ unavailable: 0, rerouted: false, tried: new Set() })

// Decides, and records the decision on the turn. `agents` are the specialists that can be reached now.
export function decideRollup(hint: EscalationHint, agent: string, turn: Turn, agents: readonly string[]): RollupDecision {
  turn.tried.add(agent)
  switch (hint.escalationReason) {
    case 'service_unavailable':
      return ++turn.unavailable < MAX_UNAVAILABLE_PER_TURN ? 'retry' : 'escalate'
    case 'unsupported_request': {
      // The specialist says the request is not its to handle: a misroute. One second try per turn,
      // and only when there is a specialist left that has not been asked.
      const misroute = hint.cause === 'intent' || hint.cause === 'rule'
      if (!misroute || turn.rerouted || agents.every(other => turn.tried.has(other))) return 'escalate'
      turn.rerouted = true
      return 'reroute'
    }
    // Everything else ends the turn at once. `rate_limited` above all: the caller was told to wait.
    default:
      return 'escalate'
  }
}

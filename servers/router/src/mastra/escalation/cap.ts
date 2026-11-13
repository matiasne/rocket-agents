import { ESCALATION_POLICY, type EscalationHint } from '../../../../shared/escalation'

// A caller can keep sending messages to a conversation after every escalation. This stops it:
// once a conversation has ended `max` turns in a row as an escalation, its next turns end
// before anything is routed. A turn that completes, or that only waits for a person to act
// (an approval), resets the count; a rate-limited turn counts, since the caller was told to wait.
// Kept in memory, per conversation.
export function createEscalationCap(max: number) {
  const consecutive = new Map<string, number>()
  return {
    reached: (conversation: string) => (consecutive.get(conversation) ?? 0) >= max,
    settle(conversation: string, escalated: EscalationHint | undefined) {
      if (!escalated || ESCALATION_POLICY[escalated.escalationReason].failureClass === 'caller-action') consecutive.delete(conversation)
      // The turn the cap itself ended is not counted again.
      else if (escalated.escalationReason !== 'escalation_limit_reached') consecutive.set(conversation, (consecutive.get(conversation) ?? 0) + 1)
    },
  }
}

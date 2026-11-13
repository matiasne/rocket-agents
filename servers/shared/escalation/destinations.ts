import type { EscalationReason } from './policy'

// Where a person can carry on when the agents cannot: a page of the portal, and optionally
// what to do there. Declared in code per specialist; a model never picks or writes one.
export type DestinationRef = { path: string; label: string; instructions?: string }

export type EscalationDestination<State = unknown> = {
  default?: DestinationRef
  byReason?: Partial<Record<EscalationReason, DestinationRef>>
  resolve?: (reason: EscalationReason, state: State) => DestinationRef | undefined
}

export type Destination = { url: string; label: string; instructions?: string }

export const PLATFORM_DEFAULT: DestinationRef = { path: '/', label: 'Loan portal' }

// A path must stay on the portal's own host: `//host`, a scheme, `..` or a backslash
// (which URL parsing reads as a slash) could all send the user somewhere else.
export function validateDestinationPath(path: string) {
  if (!path.startsWith('/') || path.includes('//') || path.includes('..') || path.includes('\\') || path.includes(':')) {
    throw new Error(`Escalation destination path must be a plain absolute path, got "${path}"`)
  }
}

export function validateDestination(config: EscalationDestination | undefined) {
  for (const ref of [config?.default, ...Object.values(config?.byReason ?? {})]) {
    if (ref) validateDestinationPath(ref.path)
  }
}

// Order: resolve() → byReason → default → the platform default.
export function resolveDestination<State>(
  config: EscalationDestination<State> | undefined,
  reason: EscalationReason,
  state: State,
  portalBaseUrl: string,
): Destination {
  const ref = config?.resolve?.(reason, state) ?? config?.byReason?.[reason] ?? config?.default ?? PLATFORM_DEFAULT
  validateDestinationPath(ref.path)
  return {
    url: new URL(ref.path, portalBaseUrl).toString(),
    label: ref.label,
    ...(ref.instructions && { instructions: ref.instructions }),
  }
}

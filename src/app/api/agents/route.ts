import { agents, master } from '@/lib/mastra-client'

// Discovery: fetch each agent's A2A agent card from its own server.
// A server that is down is listed without a card, so the others still show.
// `enabled` comes from the router, which is the one that delegates (null for the router itself,
// or while the router is unreachable). `delayMs` is the agent's own response delay (null while
// its server is unreachable), and `fault` the fault it is set to inject (null likewise).
export async function GET() {
  const setting = <T,>(url: string, name: string, read: (data: any) => T | null) =>
    fetch(`${url}/settings/${name}`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(read)
      .catch(() => null)
  const [results, switches, delays, faults] = await Promise.all([
    Promise.allSettled(agents.map(({ id, client }) => client.getA2A(id).getAgentCard())),
    fetch(`${master.url}/specialists`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null) as Promise<{ specialists: { id: string; enabled: boolean }[] } | null>,
    Promise.all(agents.map(({ url }) => setting(url, 'delay', data => (typeof data?.delayMs === 'number' ? (data.delayMs as number) : null)))),
    Promise.all(agents.map(({ url }) => setting(url, 'fault', data => (typeof data?.fault === 'string' ? (data.fault as string) : null)))),
  ])
  return Response.json({
    agents: agents.map(({ id }, index) => {
      const result = results[index]
      const enabled = switches?.specialists.find(specialist => specialist.id === id)?.enabled ?? null
      return { id, card: result.status === 'fulfilled' ? result.value : null, enabled, delayMs: delays[index], fault: faults[index] }
    }),
  })
}

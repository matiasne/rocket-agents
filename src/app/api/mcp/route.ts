import { MCP_TOOLS_URL, MCP_URL } from '@/lib/mcp'

// The MCP front door: its endpoint and the tools it publishes. `tools` is null while the router is unreachable.
export async function GET() {
  const tools = await fetch(MCP_TOOLS_URL, { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then(body => (Array.isArray(body?.tools) ? body.tools.map((tool: { name: string }) => tool.name) : null))
    .catch(() => null)
  return Response.json({ url: MCP_URL, tools })
}

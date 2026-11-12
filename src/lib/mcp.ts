import { router } from '@/lib/mastra-client'

// The router's MCP front door (Streamable HTTP), for a borrower's assistant. The page shows how to connect to it.
export const MCP_URL = `${router.url}/api/mcp/router/mcp`
// Mastra's plain JSON listing of the same server's tools.
export const MCP_TOOLS_URL = `${router.url}/api/mcp/router/tools`

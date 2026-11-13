import { MastraClient } from '@mastra/client-js'

// One Mastra server per agent. Same ids, ports and env names as
// servers/router/src/mastra/specialists.ts: <ID>_URL overrides where a server lives.
const PORTS = {
  master: 4111,
  'product-eligibility': 4112,
  'loan-intake': 4113,
  borrower: 4114,
  declarations: 4115,
  'income-employment': 4116,
  assets: 4117,
  liabilities: 4118,
  'owned-properties': 4119,
  'subject-property': 4120,
  credit: 4121,
}

const agents = Object.entries(PORTS).map(([id, port]) => {
  const url = process.env[`${id.toUpperCase().replaceAll('-', '_')}_URL`] ?? `http://localhost:${port}`
  return { id, url, client: new MastraClient({ baseUrl: url }) }
})

export const [master, ...specialists] = agents
export { agents }

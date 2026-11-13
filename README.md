# Mastra × A2A — loan agents on separate servers

A mortgage-loan example built with [Mastra](https://mastra.ai/docs): a router agent and ten specialist
agents, each in **its own Mastra server**, talking over the
[A2A protocol](https://a2a-protocol.org/latest/topics/what-is-a2a/). A Next.js UI shows the tasks as
they happen.

```
Browser ──SSE──▶ Next.js :3030 ──A2A message/stream──▶ Router :4111
                                                          │  stream, push or poll (per specialist)
                                                          ▼
Browser ◀─poll── Next.js :3030 ──A2A ListTasks──────▶ 10 specialist servers :4112–:4121
```

Hand-offs go through the router, never sideways: specialists do not know about each other. When one
needs another's output (liabilities need the credit tradelines), the router carries it.

| Server | Port | Owns | Mock endpoints |
| --- | --- | --- | --- |
| `router` | 4111 | Routing only, no loan data | |
| `product-eligibility` | 4112 | Pricing, product groups (read-only) | `POST /calculators/pricing`, `GET /loan-setup/product-groups` |
| `loan-intake` | 4113 | Creates the loan, URLA import | `POST /urla`, `POST /loans`, `GET/PUT /loans/{id}` |
| `borrower` | 4114 | Borrowers and co-borrowers | `~/borrowers`, `/primary`, `/spousal-relationship`, `/deactivation` |
| `declarations` | 4115 | Borrower's own answers, never inferred | `~/borrowers/{id}/declaration`, `/demographic-information`, `/military-service` |
| `income-employment` | 4116 | Per borrower; rental income comes from REO | `~/borrowers/{id}/employments`, `/incomes` |
| `assets` | 4117 | Per loan | `~/assets`, `/assets/{id}`, `/restore` |
| `liabilities` | 4118 | From the credit pull, borrower confirms | `~/liabilities` (bulk upsert) |
| `owned-properties` | 4119 | REO; feeds liabilities and rental income | `~/owned-properties` |
| `subject-property` | 4120 | The property being financed | `~/subject-property`, `/disclosures` |
| `credit` | 4121 | Needs the borrower's approval (PAP operation or MCP input request) and LO approval; slow (~6s) | `POST ~/credit`, `GET ~/credit-results` |

`~` is `/loans/{loanId}`. The tools are mocks: each server keeps its data in memory, so nothing calls a
real API and restarting a server clears its data and tasks.

## Run it

Requires Node 22.13+ (`nvm use`) and pnpm.

```sh
pnpm install
cp .env.example .env      # add ANTHROPIC_API_KEY (or set MODEL + another provider key)
pnpm dev
```

`pnpm dev` starts the 11 Mastra servers and the UI (12 processes; the first start takes a while). To
run one server alone: `pnpm server:credit`, `pnpm server:router`, and so on.

- UI: http://localhost:3030
- Each server has its own Studio and API at its port, e.g. http://localhost:4111

## Run it in Docker

Each Mastra server in its own container, plus one for the UI and one for the Bifrost LLM gateway
(13 containers, see `docker-compose.yml`). Requires Docker only, and the same `.env`.

```sh
scripts/docker.sh              # build, start, wait until every container is healthy
scripts/docker.sh logs credit  # follow one service's logs (no name = all)
scripts/docker.sh rebuild credit
scripts/docker.sh down
```

The ports are the same as with `pnpm dev`, so stop one before starting the other. The differences:

- The containers run production builds (`mastra build`, `next build`): no Studio and no hot reload.
  Rebuild a service after changing its code.
- Servers reach each other by service name. Compose sets every `<ID>_URL`, so the UI shows addresses
  like `http://router:4111`; from your machine the same server is `http://localhost:4111`.
- `push` is polled: a service name resolves to a private address, which Mastra refuses (see below).
  Set `ROUTER_PUBLIC_URL` in `.env` to a public URL of the router to use it.
- Every server sends its LLM calls through the Bifrost gateway (see "LLM gateway" below).

## Configuration (`.env`)

**Transport** — how the router waits for a specialist's answer:

| Value | What the router does |
| --- | --- |
| `stream` | `message/stream`: holds an SSE connection open until the task ends |
| `push` | Non-blocking `message/send` with a webhook; the specialist calls the router back |
| `poll` | Non-blocking `message/send`, then `tasks/get` once a second |

`A2A_TRANSPORT` sets it for all specialists (default `stream`). `A2A_TRANSPORT_<ID>` overrides one,
with the id in upper snake case: `A2A_TRANSPORT_CREDIT=push`, `A2A_TRANSPORT_LOAN_INTAKE=poll`.

**Where servers live** — `<ID>_URL`, e.g. `CREDIT_URL=https://credit.example.com`. The router and the
UI both read it, so a specialist can move to another host without code changes. `MASTER_URL` does the
same for the router (UI only).

**Tracing** — set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (and `LANGFUSE_BASE_URL` if you are not on
`cloud.langfuse.com`) to send every agent run to [Langfuse](https://langfuse.com): LLM calls with tokens,
tool calls, inputs and outputs. Each server reports under its own id. The UI sends one A2A `contextId`
per page load and the router passes it on to the specialists, so Langfuse groups the router's trace and
the specialists' traces into one session. Without the keys tracing is off.

**LLM gateway** — set `BIFROST_URL` to send every agent's LLM calls through
[Bifrost](https://github.com/maximhq/bifrost) instead of straight to the provider. Bifrost then holds the
provider keys, and it is the one place to log, limit or reroute LLM traffic for all 11 servers. Without
`BIFROST_URL` the servers call the provider directly.

```sh
pnpm bifrost     # starts only the gateway (Docker), on http://localhost:8080
# in .env: BIFROST_URL=http://localhost:8080
pnpm dev
```

- The gateway reads `ANTHROPIC_API_KEY` from `.env` (`docker/bifrost/config.json`). To use another
  provider, add its key there and set `MODEL`, e.g. `MODEL=openai/gpt-...`.
- `servers/shared/model.ts` builds the model every agent uses. With `BIFROST_URL` set it points at
  Bifrost's OpenAI-compatible endpoint (`/v1`), so Anthropic-only request options are not passed along.
- The gateway takes requests without a key and is published on `127.0.0.1` only. To require one, remove
  `enforce_auth_on_inference` from the config, create a virtual key in Bifrost and set `BIFROST_VIRTUAL_KEY`.
- Bifrost's dashboard (http://localhost:8080) needs `BIFROST_SETUP_TOKEN` in `.env` to create its first
  admin account.
- In Docker, compose sets `BIFROST_URL` for every server, so the containers always use the gateway.

### `push` needs a public URL

Mastra refuses to deliver push notifications to `localhost` or private addresses, and does not log the
refusal. So `push` only works when the specialists can reach the router at a public URL, given in
`ROUTER_PUBLIC_URL`. Locally, `pnpm dev:push` does this for you: it opens an
[ngrok](https://ngrok.com) tunnel to the router, sets `ROUTER_PUBLIC_URL` and runs `pnpm dev`.

The tunnel exposes the whole router API, which has no auth, so close it when you are done.

Without `ROUTER_PUBLIC_URL`, specialists set to `push` are polled instead. If a webhook never arrives,
the router also falls back to polling after two minutes.

## The borrower's side: Personal Agent Protocol

A2A is how the lender's own agents talk to each other. The
[Personal Agent Protocol](https://personalagentprotocol.org/docs/introduction) (PAP, draft 1.0) covers
the hop in front of them: a borrower's personal agent talking to the company. The router is the
front door; the specialists stay behind it.

```
Borrower's agent ──PAP──▶ Router :4111 /poppy/conversations
  1. "pull my credit"            → the router agent calls request-borrower-approval
  2. ◀ operation {operation_id, revision, summary, terms, expires_at}
  3. borrower taps Approve       → message with extensions.operations.approval
  4. router checks it against the stored operation and runs the agent again
  5. delegate ──A2A + X-Poppy-Approval──▶ Credit :4121 → pull-credit checks the terms, pulls once
```

Borrower consent is therefore not something the model can state. The router agent can ask for it, but
the credit tool only pulls when the approved terms (`action: credit-pull`, the same loan id, not
expired) arrive with the request, outside the text the model writes. Asking as the loan officer and
writing "the borrower consented" is refused. The loan officer's own approval is still a value the
model sets from the text.

In the UI, switch "who is asking" to **Borrower's agent**: the page then plays the personal agent. The
approval card shows the operation, and the PAP steps open to the JSON that went over the wire. The
"Personal Agent Protocol" entry in the sidebar shows the discovery document.

| Implemented | |
| --- | --- |
| Discovery | `GET /.well-known/poppy.json` |
| Conversations | `POST /poppy/conversations`, `POST …/{id}/messages`, `GET …/{id}/events` (long-poll or SSE), `POST …/{id}/close` |
| `operations` v3 | Operation, approval, revision check, expiry, at most once per `operation_id` |
| Operation status | `GET /operations/{id}` on the credit server (not part of PAP; the router uses it to report `performed`) |

Not implemented: sign-in (`auth.disabled: true`), handoff, tasks, browser sessions, `text-delta`
streaming, other extensions.

**The session is not verified.** The front door requires a `Poppy-Session` JWT and reads `sub` from it
without checking the signature, so anyone can claim any borrower id. This is a demo of the message
flow, not of PAP's security. The credit server likewise trusts the router for the approval header.

## The borrower's side, again: Model Context Protocol

The router has a second front door for the borrower: an [MCP](https://modelcontextprotocol.io) server,
so any MCP client can be the borrower's assistant. It publishes one tool, `ask_loan_router`, which
runs the router agent with the same standing as a PAP conversation.

```
Borrower's assistant ──MCP──▶ Router :4111 /api/mcp/router/mcp
  1. tools/call ask_loan_router "pull my credit" → the router agent calls request-borrower-approval
  2. ◀ input_required: a form with the operation's summary and one field, `approve`
  3. borrower approves             → the client repeats the call with the answer
  4. router checks it against the stored operation and runs the agent again
  5. delegate ──A2A + X-Poppy-Approval──▶ Credit :4121 → pull-credit checks the terms, pulls once
```

Steps 4 and 5 are the PAP ones: both doors share the operation registry in `poppy.ts`. The "Model Context
Protocol" entry in the sidebar shows how to connect.

```bash
claude mcp add --transport http loan-router http://localhost:4111/api/mcp/router/mcp --header "X-Borrower-Id: borrower-1"
```

The server speaks MCP 2026-07-28 (`@mastra/mcp` 2.x), where a tool asks for input by ending the call
as `input_required`. Clients on an older protocol version can still call the tool (`legacy:
'stateless'`), but cannot be asked, so for them a credit pull ends as a tool error and nothing is
pulled. The router agent has no memory: send the loan id with every message.

A call that takes longer than 2s (a credit pull takes ~6s) continues as an [MCP task](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)
(experimental) for clients that declare the extension: they get a task handle at once, poll it, and
answer the approval with `tasks/update`. Clients that don't declare it get a direct answer, as before.
While the call is still a live request, each delegation is reported as a progress notification
to clients that sent a progress token. Tasks live in memory.

Not implemented: authorization, resources, prompts. **The borrower is not verified:** the
`X-Borrower-Id` header is taken at its word and the endpoint is open, like the A2A and PAP ones.
Set `MCP_REQUEST_STATE_KEY` to keep a pending approval answerable across a router restart.

## When a turn cannot be answered: escalations

A turn that ends without an answer ends as an **escalation**: a reason code, a class, a retry hint,
a link to carry on by hand, and one fixed sentence. The fault itself (stack, provider message) stays
in the server log.

| Reason code | When |
| --- | --- |
| `service_unavailable` | A model call failed, or a specialist is disabled or unreachable |
| `rate_limited` | A limiter turned the caller away (only the fault switch produces it here) |
| `unsupported_request` | Outside what the agent does (rental income), or a guardrail stopped the run |
| `request_rejected` | A rule or permission said no (a declaration not stated by the borrower) |
| `approval_required`, `approval_denied` | A credit pull without the borrower's approval, or with an expired one |
| `agent_steps_exhausted` | The agent hit its step cap (router 20, specialists 8) |
| `escalation_limit_reached` | `MAX_CONSECUTIVE_ESCALATIONS` turns in a row escalated in one conversation |
| `internal_error` | Anything else |

**On the wire.** Mastra's A2A handler can only end a task as completed, input-required or failed, so
an escalation is a `failed` task whose text is `Handler failed: [[escalation:v2]]{json}`. A specialist
sends a hint (code, wait, cause); the router sends the public fields and the sentence. A blocking
`message/send` returns the same text as a JSON-RPC error instead of a failed task. The PAP door posts
the sentence with the fields in `data.escalation`; the MCP door returns the sentence.

**The router's rules.** `service_unavailable` is retried up to 3 times in a turn, `rate_limited`
never. `unsupported_request` lets the router try one other specialist. After
`MAX_CONSECUTIVE_ESCALATIONS` (default 3) escalated turns in a row, the conversation's next turns end
at once with `escalation_limit_reached`, without a model call; an answered turn resets the count.
Counts live in memory.

**Try it.** Open an agent's settings (the gear) and pick a fault under *Inject a fault*: `outage`,
`rate-limit`, `denied`, `unsupported`, `guardrail` or `crash`. Each goes down the path a real fault
of its kind would. The links point at `PORTAL_BASE_URL` (default `http://localhost:3030`) and are
illustrative: this demo has no such pages.

`pnpm test` runs the unit tests of the contract and of the router's rules.

## What to look at

| File | What it shows |
| --- | --- |
| `servers/router/src/mastra/specialists.ts` | The registry: ids, ports, and the env settings above |
| `servers/router/src/mastra/tools/delegate.ts` | The one hand-off tool: stream, push (with its webhook route) or poll |
| `servers/router/src/mastra/agents/router-agent.ts` | The routing rules |
| `servers/router/src/mastra/poppy.ts` | The PAP front door: discovery, conversations, operations |
| `servers/router/src/mastra/mcp.ts` | The MCP front door: one tool, the approval as an input request |
| `servers/router/src/mastra/tools/request-approval.ts` | Asking the borrower to approve a credit pull |
| `servers/credit/src/mastra/index.ts` | `pull-credit` checking the approval in code |
| `servers/<id>/src/mastra/index.ts` | A specialist: mock tools, one agent, one server (exposed over A2A automatically) |
| `servers/shared/observability.ts` | The Langfuse exporter every server uses |
| `servers/shared/escalation/` | The escalation contract: codes, classification, destinations, prose, the envelope |
| `servers/shared/escalation-runtime.ts` | How an agent ends a turn as an escalation |
| `servers/shared/fault.ts` | The fault switch |
| `servers/router/src/mastra/escalation/` | The router's retry, reroute and cap rules |
| `src/app/api/tasks/route.ts` | The router's task relayed to the browser as SSE |
| `src/app/api/specialist-tasks/route.ts` | Polling every specialist with `getA2AV1().listTasks()` |
| `src/app/api/agents/route.ts` | Discovery through agent cards |
| `src/app/api/poppy/` | The Next server acting as the borrower's personal agent |

To add a specialist: add it to `specialists.ts` and to `src/lib/mastra-client.ts`, create
`servers/<id>`, add a `server:<id>` script in `package.json`, and add a service (and its `<ID>_URL`)
in `docker-compose.yml`.

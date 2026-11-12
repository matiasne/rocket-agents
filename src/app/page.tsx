'use client'

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// `detail` is the raw JSON behind the entry, shown when the entry is opened.
type LogEntry = { at: number; label: string; detail?: unknown }

// One chat session: its own thread of turns and its own A2A `contextId`, which the router
// uses as its memory thread, so sessions do not share context.
type Session = { id: string; contextId: string; title?: string }

type RouterTask = {
  localId: string
  sessionId: string
  prompt: string
  startedAt: number
  taskId?: string
  state: string
  answer: string
  log: LogEntry[]
}

type SpecialistTask = {
  id: string
  contextId?: string
  agent: string
  status?: { state?: string; timestamp?: string }
  history?: { parts?: { text?: string }[] }[]
  artifacts?: { parts?: { text?: string }[] }[]
}

type AgentCard = {
  description?: string
  url: string
  version?: string
  protocolVersion?: string
  provider?: { organization?: string }
  capabilities?: { streaming?: boolean; pushNotifications?: boolean }
  defaultInputModes?: string[]
  defaultOutputModes?: string[]
  skills?: { id: string; name: string; description?: string }[]
}
// One hand-off shown in the sidebar: a dot travelling between the router and a
// specialist, plus a short note under the specialist saying why.
type Signal = {
  key: number
  agent: string
  kind: 'request' | 'response'
  text: string
  failed: boolean
  top: number
  left: number
  dy: number
  // Viewport position of the floating reason bubble, beside the specialist's row.
  noteTop: number
  noteLeft: number
  delay: number
}
const SIGNAL_MS = 5000

// `card` is null while the agent's server is unreachable. `enabled` says whether the router
// may delegate to it: null for the router itself, or while the router is unreachable.
// `delayMs` is the wait the agent's server adds before it starts on a message (null while unreachable).
type AgentInfo = { id: string; card: AgentCard | null; enabled: boolean | null; delayMs: number | null }

// Personal Agent Protocol (PAP): the company's discovery document, /.well-known/poppy.json.
type PoppyDocument = {
  protocol_version?: string
  organization?: { name?: string; domain?: string }
  auth?: { disabled?: boolean }
  agent?: { protocols?: { type: string; endpoint: string; access?: string }[] }
  extensions?: Record<string, { version: string }[]>
}
type Discovery = { url: string; document: PoppyDocument | null }
// Model Context Protocol (MCP): the router's endpoint and the tools it publishes there.
type McpDoor = { url: string; tools: string[] | null }

// PAP `operations` extension: exact terms the company wants approved before it acts.
type Operation = {
  operation_id: string
  revision: string
  summary?: string
  terms: Record<string, unknown>
  expires_at: string
}

// One PAP conversation between the borrower's personal agent (this page) and the company.
type PapConversation = {
  localId: string
  sessionId: string
  prompt: string
  startedAt: number
  conversationId?: string
  working: boolean
  error?: string
  answer: string
  log: LogEntry[]
  operation?: Operation
  // awaiting: the borrower has not answered. approved: approval sent. Then the company's
  // own status for the operation (`performed`), or `declined` when the borrower said no.
  operationState?: string
}

const TERMINAL = ['completed', 'failed', 'canceled', 'rejected']
// Who is asking decides the protocol: the loan officer's console speaks A2A to the router,
// the borrower's personal agent speaks PAP.
const SUGGESTIONS = {
  a2a: [
    'Which products fit a $400,000 loan on a $500,000 home with a 740 credit score?',
    'Start a $400,000 purchase loan and add borrowers Ana Perez and her spouse Luis Perez',
    'Create a loan for Sam Lee and pull credit. Sam consented and I, the loan officer, approve.',
  ],
  pap: [
    'Start a $300,000 purchase loan for me, Sam Lee, and pull my credit. The loan officer has approved the pull.',
    'Which products fit a $400,000 loan on a $500,000 home with a 740 credit score?',
  ],
}
type Mode = keyof typeof SUGGESTIONS

const taskState = (task: SpecialistTask) =>
  (task.status?.state ?? 'unknown').replace('TASK_STATE_', '').toLowerCase().replace('_', '-')

// "loan-intake" → "Loan Intake", initials "LI", and a stable colour per agent.
const displayName = (id: string) => id.replace(/(^|-)(\w)/g, (_, dash, letter) => (dash ? ' ' : '') + letter.toUpperCase())
const initials = (id: string) => id.split('-').map(word => word[0]).join('').toUpperCase()
const hue = (id: string) => [...id].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) % 360

function Avatar({ id, working }: { id: string; working?: boolean }) {
  return (
    <span className={`avatar${working ? ' working' : ''}`} style={{ background: `hsl(${hue(id)} 55% 45%)` }}>
      {initials(id)}
    </span>
  )
}

function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  return (
    // A click on the backdrop lands on the dialog element itself.
    <dialog ref={ref} onClose={onClose} onClick={event => event.target === ref.current && onClose()}>
      <div className="modal">{children}</div>
    </dialog>
  )
}

// The agent's response delay, in seconds. Saved on submit; the server answers with the value it kept.
function DelayField({ agent, onSave }: { agent: AgentInfo; onSave: (delayMs: number) => Promise<string | undefined> }) {
  const [seconds, setSeconds] = useState(String((agent.delayMs ?? 0) / 1000))
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(await onSave(Math.round(Number(seconds) * 1000)))
    setSaving(false)
  }
  return (
    <form className="delay-field" onSubmit={submit}>
      <input
        type="number"
        min={0}
        max={120}
        step={0.5}
        value={seconds}
        aria-label="Response delay in seconds"
        onChange={event => setSeconds(event.target.value)}
      />
      <span>seconds</span>
      <button type="submit" disabled={saving || Number(seconds) * 1000 === agent.delayMs}>
        Save
      </button>
      {error && <span className="delay-error">{error}</span>}
    </form>
  )
}

// An agent's settings, opened from the gear on its row. The router has no on/off switch:
// it is the one that delegates.
function SettingsModal({
  agent,
  onToggle,
  onDelayChange,
  onClose,
}: {
  agent: AgentInfo
  onToggle: (enabled: boolean) => void
  onDelayChange: (delayMs: number) => Promise<string | undefined>
  onClose: () => void
}) {
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <Avatar id={agent.id} />
        <div>
          <h2>{displayName(agent.id)} settings</h2>
          <code>{agent.id}</code>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {agent.enabled === null && agent.delayMs === null && <p className="offline-note">This agent's server is unreachable.</p>}
      {agent.enabled !== null && (
        <label className="setting">
          <span>
            <b>Enabled</b>
            <small>When off, the router does not delegate to this agent.</small>
          </span>
          <span className="switch">
            <input type="checkbox" role="switch" checked={agent.enabled} onChange={event => onToggle(event.target.checked)} />
            <span />
          </span>
        </label>
      )}
      {agent.delayMs !== null && (
        <div className="setting">
          <span>
            <b>Response delay</b>
            <small>How long the agent waits before it starts on a message.</small>
          </span>
          {/* Keyed by the saved value, so the field shows it again after a save. */}
          <DelayField key={agent.delayMs} agent={agent} onSave={onDelayChange} />
        </div>
      )}
    </Modal>
  )
}

const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

function AgentModal({ agent, working, onClose }: { agent: AgentInfo; working: boolean; onClose: () => void }) {
  const { id, card } = agent
  return (
    <Modal onClose={onClose}>
        <div className="modal-head">
          <Avatar id={id} working={working} />
          <div>
            <h2>{displayName(id)}</h2>
            <code>{id}</code>
          </div>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {!card && <p className="offline-note">This agent's server is unreachable.</p>}
        {card && (
          <>
            <dl>
              <dt>Status</dt>
              <dd>{agent.enabled === false ? 'Disabled: the router will not delegate to it' : working ? 'Working on a task' : 'Idle'}</dd>
              <dt>A2A endpoint</dt>
              <dd>
                <code>{card.url}</code>
              </dd>
              <dt>Streaming</dt>
              <dd>{card.capabilities?.streaming ? 'Yes' : 'No'}</dd>
              <dt>Push notifications</dt>
              <dd>{card.capabilities?.pushNotifications ? 'Yes' : 'No'}</dd>
              <dt>Input / output</dt>
              <dd>
                {card.defaultInputModes?.join(', ')} → {card.defaultOutputModes?.join(', ')}
              </dd>
              <dt>Version</dt>
              <dd>
                {card.version} · A2A {card.protocolVersion} · {card.provider?.organization}
              </dd>
            </dl>
            <h3>Instructions</h3>
            <p className="instructions">{card.description}</p>
            <h3>Tools</h3>
            <ul className="skills">
              {(card.skills ?? []).map(skill => (
                <li key={skill.id}>
                  <code>{skill.name}</code>
                  {skill.description}
                </li>
              ))}
            </ul>
          </>
        )}
    </Modal>
  )
}

function PoppyModal({ discovery, onClose }: { discovery: Discovery; onClose: () => void }) {
  const { url, document } = discovery
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <span className="avatar protocol">PAP</span>
        <div>
          <h2>Personal Agent Protocol</h2>
          <code>{url}</code>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {!document && <p className="offline-note">The router server is unreachable.</p>}
      {document && (
        <>
          <p className="instructions">
            How a borrower’s personal agent finds this company and talks to it. The router is the only agent it can
            reach; the specialists stay behind it, on A2A.
          </p>
          <h3>Discovery</h3>
          <dl>
            <dt>Company</dt>
            <dd>
              {document.organization?.name} · <code>{document.organization?.domain}</code>
            </dd>
            <dt>Protocol version</dt>
            <dd>{document.protocol_version}</dd>
            <dt>Conversations</dt>
            <dd>
              <code>{document.agent?.protocols?.[0]?.endpoint}</code>
            </dd>
            <dt>Sign-in</dt>
            <dd>{document.auth?.disabled ? 'Not offered (demo: the session is not verified)' : 'Offered'}</dd>
            <dt>Extensions</dt>
            <dd>
              {Object.entries(document.extensions ?? {})
                .map(([name, versions]) => `${name} v${versions.map(entry => entry.version).join(', v')}`)
                .join(' · ')}
            </dd>
          </dl>
          <h3>poppy.json</h3>
          <pre>{JSON.stringify(document, null, 2)}</pre>
        </>
      )}
    </Modal>
  )
}

function McpModal({ door, onClose }: { door: McpDoor; onClose: () => void }) {
  const { url, tools } = door
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <span className="avatar protocol">MCP</span>
        <div>
          <h2>Model Context Protocol</h2>
          <code>{url}</code>
        </div>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {!tools && <p className="offline-note">The router server is unreachable.</p>}
      <p className="instructions">
        How a borrower’s assistant (any MCP client) talks to this company. The router is the only agent it can
        reach; the specialists stay behind it, on A2A.
      </p>
      <h3>Connect</h3>
      <dl>
        <dt>Endpoint</dt>
        <dd>
          <code>{url}</code> · Streamable HTTP
        </dd>
        <dt>Borrower</dt>
        <dd>
          Header <code>X-Borrower-Id</code> (demo: not verified)
        </dd>
        <dt>Tools</dt>
        <dd>{tools?.length ? tools.map(tool => <code key={tool}>{tool} </code>) : '—'}</dd>
      </dl>
      <h3>Claude Code</h3>
      <pre>{`claude mcp add --transport http loan-router ${url} --header "X-Borrower-Id: borrower-1"`}</pre>
      <h3>Try it</h3>
      <p className="instructions">
        Ask your assistant: “Create a loan for Ana Diaz, then pull her credit. The loan officer approved the credit
        pull.” Before the pull, the client shows a form with the terms (a hard inquiry) and one field, approve.
        Credit is pulled only after you approve. Send the loan id with every message: the router does not remember
        earlier ones.
      </p>
      <h3>Client support</h3>
      <p className="instructions">
        The approval form needs a client that speaks MCP 2026-07-28. Older clients can still call the tool, but a
        credit pull ends as a tool error and nothing is pulled.
      </p>
    </Modal>
  )
}

// Operation summaries may use **strong** emphasis and nothing else.
const emphasis = (text: string) => text.split('**').map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part))

function Typing() {
  return (
    <span className="typing" aria-label="Working">
      <i />
      <i />
      <i />
    </span>
  )
}

function Timeline({ log, pending }: { log: LogEntry[]; pending?: string }) {
  return (
    <ol>
      {log.map((entry, index) => (
        <li key={index}>
          {entry.detail === undefined ? (
            <>
              <time>+{(entry.at / 1000).toFixed(1)}s</time> {entry.label}
            </>
          ) : (
            <details>
              <summary>
                <time>+{(entry.at / 1000).toFixed(1)}s</time> {entry.label}
              </summary>
              <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
            </details>
          )}
        </li>
      ))}
      {pending && <li className="pending">{pending}</li>}
    </ol>
  )
}

// The router answers in Markdown (GitHub flavour, for its tables); links open in a new tab.
function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: props => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

const partsText = (parts?: { text?: string }[]) => (parts ?? []).map(p => p.text ?? '').join('')

const newSession = (): Session => ({ id: crypto.randomUUID(), contextId: crypto.randomUUID() })
// A session is named after its first message.
const sessionTitle = (prompt: string) => (prompt.length > 32 ? `${prompt.slice(0, 32).trimEnd()}…` : prompt)

export default function Page() {
  const [input, setInput] = useState('')
  const [sessions, setSessions] = useState<Session[]>(() => [newSession()])
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0].id)
  const [tasks, setTasks] = useState<RouterTask[]>([])
  const [specialistTasks, setSpecialistTasks] = useState<SpecialistTask[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [openAgentId, setOpenAgentId] = useState<string>()
  const [settingsAgentId, setSettingsAgentId] = useState<string>()
  const [signals, setSignals] = useState<Signal[]>([])
  const [mode, setMode] = useState<Mode>('a2a')
  const [discovery, setDiscovery] = useState<Discovery>()
  const [poppyOpen, setPoppyOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [mcp, setMcp] = useState<McpDoor>()
  const [mcpOpen, setMcpOpen] = useState(false)
  const [conversations, setConversations] = useState<PapConversation[]>([])
  // The borrower's id at this company, chosen by their personal agent. One per page load.
  const [userId] = useState(() => `usr_${crypto.randomUUID()}`)
  const [now, setNow] = useState(() => Date.now())
  const counter = useRef(0)
  // Where each PAP conversation has been read up to (event id), by local id.
  const cursors = useRef(new Map<string, string>())
  const asideRef = useRef<HTMLElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  // Last seen state of every specialist task; null until the first poll, so
  // tasks that already existed on page load are not animated.
  const seen = useRef<Map<string, string> | null>(null)

  // Compares a poll with the previous one: a new task is a request from the
  // router to that specialist, a task reaching a final state is the response.
  function detectSignals(polled: SpecialistTask[]) {
    const previous = seen.current
    seen.current = new Map(polled.map(task => [`${task.agent}/${task.id}`, taskState(task)]))
    if (!previous) return

    const items = [...(asideRef.current?.querySelectorAll<HTMLElement>('.agent-item[data-agent]') ?? [])]
    const centre = (item: HTMLElement) => item.offsetTop + item.offsetHeight / 2
    const created: Signal[] = []
    const add = (task: SpecialistTask, kind: Signal['kind'], delay: number) => {
      const router = items[0]
      const specialist = items.find(item => item.dataset.agent === task.agent)
      if (!router || !specialist || router === specialist) return
      const [from, to] = kind === 'request' ? [router, specialist] : [specialist, router]
      const state = taskState(task)
      const row = specialist.getBoundingClientRect()
      const result = (task.artifacts ?? []).map(artifact => partsText(artifact.parts)).join('')
      created.push({
        key: counter.current++,
        agent: task.agent,
        kind,
        text: kind === 'request' ? partsText(task.history?.[0]?.parts) || 'delegated request' : result || state,
        failed: kind === 'response' && state !== 'completed',
        top: centre(from),
        // A lane down the right edge of the rows, clear of avatars and names.
        left: from.offsetLeft + from.offsetWidth - 12,
        dy: centre(to) - centre(from),
        noteTop: row.top + row.height / 2,
        noteLeft: row.right + 10,
        delay,
      })
    }

    for (const task of polled) {
      const before = previous.get(`${task.agent}/${task.id}`)
      const done = TERMINAL.includes(taskState(task))
      if (before === undefined) add(task, 'request', 0)
      // A task that finished between two polls gets both, one after the other.
      if (done && (before === undefined || !TERMINAL.includes(before))) add(task, 'response', before === undefined ? 1200 : 0)
    }
    if (!created.length) return
    setSignals(current => [...current, ...created])
    for (const signal of created) {
      setTimeout(() => setSignals(current => current.filter(other => other.key !== signal.key)), SIGNAL_MS + signal.delay)
    }
  }

  // Discovery: load every agent card, retrying while a server is still starting.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      fetch('/api/agents')
        .then(res => res.json())
        .then(data => {
          setAgents(data.agents)
          if (data.agents.some((agent: AgentInfo) => !agent.card)) timer = setTimeout(load, 2000)
        })
        .catch(() => {
          timer = setTimeout(load, 2000)
        })
    load()
    return () => clearTimeout(timer)
  }, [])

  // PAP discovery: the router's poppy.json, retried while the router is still starting.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      fetch('/api/poppy/discovery')
        .then(res => res.json())
        .then((data: Discovery) => {
          setDiscovery(data)
          if (!data.document) timer = setTimeout(load, 2000)
        })
        .catch(() => {
          timer = setTimeout(load, 2000)
        })
    load()
    return () => clearTimeout(timer)
  }, [])

  // The MCP front door, retried while the router is still starting.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      fetch('/api/mcp')
        .then(res => res.json())
        .then((data: McpDoor) => {
          setMcp(data)
          if (!data.tools) timer = setTimeout(load, 2000)
        })
        .catch(() => {
          timer = setTimeout(load, 2000)
        })
    load()
    return () => clearTimeout(timer)
  }, [])

  // A clock for the expiry countdown, running only while an approval is awaited.
  const awaitingApproval = conversations.some(conversation => conversation.operationState === 'awaiting')
  useEffect(() => {
    if (!awaitingApproval) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [awaitingApproval])

  // Async style 2: poll every specialist's task list.
  useEffect(() => {
    const poll = () =>
      fetch('/api/specialist-tasks')
        .then(res => res.json())
        .then(data => {
          setSpecialistTasks(data.tasks ?? [])
          if (data.tasks) detectSignals(data.tasks)
        })
        .catch(() => {})
    poll()
    const timer = setInterval(poll, 1000)
    return () => clearInterval(timer)
  }, [])

  // Keep the newest message in view as turns are added and replies stream in.
  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight })
  }, [tasks, conversations, activeSessionId])

  const patch = (localId: string, update: (task: RouterTask) => RouterTask) =>
    setTasks(current => current.map(task => (task.localId === localId ? update(task) : task)))

  // Async style 1: send a message and follow the task over an SSE stream.
  // Nothing here blocks the UI, so several tasks can be in flight at once.
  // Switches a specialist on or off on the router. Shown at once, put back if the router refuses.
  async function toggleAgent(id: string, enabled: boolean) {
    const set = (value: boolean | null) =>
      setAgents(current => current.map(agent => (agent.id === id ? { ...agent, enabled: value } : agent)))
    set(enabled)
    const res = await fetch(`/api/agents/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => null)
    if (!res?.ok) set(!enabled)
  }

  // Sets how long an agent's server waits before it starts on a message. Returns an error to show, if any.
  async function setAgentDelay(id: string, delayMs: number) {
    const res = await fetch(`/api/agents/${id}/delay`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs }),
    }).catch(() => null)
    const data = await res?.json().catch(() => null)
    if (!res?.ok) return data?.error ?? 'Could not reach the server'
    setAgents(current => current.map(agent => (agent.id === id ? { ...agent, delayMs: data.delayMs } : agent)))
  }

  async function submit(session: Session, prompt: string) {
    const localId = `local-${counter.current++}`
    const startedAt = Date.now()
    setTasks(current => [
      ...current,
      {
        localId,
        sessionId: session.id,
        prompt,
        startedAt,
        state: 'sending',
        answer: '',
        log: [{ at: 0, label: 'message/stream sent' }],
      },
    ])

    const log = (task: RouterTask, label: string): RouterTask => ({
      ...task,
      log: [...task.log, { at: Date.now() - startedAt, label }],
    })

    const handle = (event: any) => {
      // The first event is the Task itself (older servers omit `kind` on it).
      if (event.kind === 'task' || (!event.kind && event.status)) {
        patch(localId, task => log({ ...task, taskId: event.id, state: event.status.state }, `task created → ${event.status.state}`))
      } else if (event.kind === 'status-update') {
        const note = partsText(event.status.message?.parts)
        patch(localId, task =>
          log(
            { ...task, state: event.status.state, answer: event.status.state === 'failed' ? note : task.answer },
            `status → ${event.status.state}`,
          ),
        )
      } else if (event.kind === 'artifact-update') {
        const chunk = partsText(event.artifact.parts)
        patch(localId, task => {
          const next = { ...task, answer: event.append ? task.answer + chunk : chunk }
          return event.append ? next : log(next, 'first artifact chunk')
        })
      } else if (event.kind === 'error') {
        patch(localId, task => log({ ...task, state: 'failed', answer: event.message }, 'stream error'))
      }
    }

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prompt, contextId: session.contextId }),
      })
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        const frames = buffer.split('\n\n')
        buffer = frames.pop()!
        for (const frame of frames) {
          if (frame.startsWith('data: ')) handle(JSON.parse(frame.slice(6)))
        }
      }
      patch(localId, task => log(task, 'stream closed'))
    } catch (error) {
      patch(localId, task => log({ ...task, state: 'failed', answer: String(error) }, 'request failed'))
    }
  }

  const patchConversation = (localId: string, update: (conversation: PapConversation) => PapConversation) =>
    setConversations(current => current.map(conversation => (conversation.localId === localId ? update(conversation) : conversation)))

  // Sends one PAP message (text, or the approval of an operation) and returns the conversation id.
  async function sendPap(conversation: Pick<PapConversation, 'localId' | 'startedAt' | 'conversationId'>, message: object, label: string) {
    const { localId, startedAt } = conversation
    const res = await fetch('/api/poppy/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, conversationId: conversation.conversationId, ...message }),
    })
    const wire = await res.json()
    const failed = wire.status >= 400 || wire.status === 0
    const conversationId: string | undefined = wire.response?.conversation_id ?? conversation.conversationId
    patchConversation(localId, current => ({
      ...current,
      conversationId,
      working: !failed,
      error: failed ? (wire.response?.error ?? 'request failed') : undefined,
      log: [...current.log, { at: Date.now() - startedAt, label: `${label} → ${wire.status || 'no answer'}`, detail: wire }],
    }))
    return failed ? undefined : conversationId
  }

  // Async style 3: long-poll the conversation's events until the company stops working.
  async function follow(localId: string, startedAt: number, conversationId: string) {
    let working = true
    while (working) {
      const cursor = cursors.current.get(localId)
      const query = new URLSearchParams({ userId, conversationId, ...(cursor && { cursor }) })
      const out = await fetch(`/api/poppy/events?${query}`).then(res => res.json())
      if (out.error) {
        patchConversation(localId, current => ({ ...current, working: false, error: out.error }))
        return
      }
      if (out.cursor) cursors.current.set(localId, out.cursor)
      working = out.working
      const at = Date.now() - startedAt
      patchConversation(localId, current => {
        let next = { ...current, working: out.working }
        for (const event of out.events) {
          // Our own messages come back as events too; they are already in the log.
          if (event.type !== 'message' || event.message.role !== 'company') continue
          const { text, data, extensions } = event.message
          const operation: Operation | undefined = extensions?.operations?.operation
          const label = operation
            ? 'operation received: approval needed'
            : extensions?.operations?.declined
              ? 'approval declined by the company'
              : `company message${data?.operation ? ` · operation ${data.operation.status}` : ''}`
          next = { ...next, log: [...next.log, { at, label, detail: event }] }
          if (operation) next = { ...next, operation, operationState: 'awaiting' }
          else next = { ...next, answer: text ?? next.answer, operationState: data?.operation?.status ?? next.operationState }
        }
        return next
      })
    }
  }

  async function submitPap(session: Session, prompt: string) {
    const conversation = { localId: `pap-${counter.current++}`, sessionId: session.id, startedAt: Date.now() }
    setConversations(current => [{ ...conversation, prompt, working: true, answer: '', log: [] }, ...current])
    try {
      const conversationId = await sendPap(conversation, { text: prompt }, 'POST /poppy/conversations')
      if (conversationId) await follow(conversation.localId, conversation.startedAt, conversationId)
    } catch (error) {
      patchConversation(conversation.localId, current => ({ ...current, working: false, error: String(error) }))
    }
  }

  // The borrower's tap on Approve: an approval of exactly this revision of the operation.
  async function approve(conversation: PapConversation) {
    const { operation_id, revision } = conversation.operation!
    const approval = { operation_id, revision, approver: 'user', approved_at: Math.floor(Date.now() / 1000), input_type: 'tap' }
    patchConversation(conversation.localId, current => ({ ...current, operationState: 'approved' }))
    try {
      const conversationId = await sendPap(conversation, { approval }, 'POST …/messages (approval)')
      if (conversationId) await follow(conversation.localId, conversation.startedAt, conversationId)
    } catch (error) {
      patchConversation(conversation.localId, current => ({ ...current, working: false, error: String(error) }))
    }
  }

  const activeSession = sessions.find(session => session.id === activeSessionId) ?? sessions[0]

  function send(prompt: string) {
    const session = activeSession
    if (!session.title) setSessions(current => current.map(other => (other.id === session.id ? { ...other, title: sessionTitle(prompt) } : other)))
    return mode === 'pap' ? submitPap(session, prompt) : submit(session, prompt)
  }

  function startSession() {
    // An untouched session is reused rather than piling up empty tabs.
    const empty = sessions.find(session => !session.title)
    if (empty) return setActiveSessionId(empty.id)
    const session = newSession()
    setSessions(current => [...current, session])
    setActiveSessionId(session.id)
  }

  // Closing a session drops its turns from the page; anything still in flight finishes unseen.
  function closeSession(id: string) {
    const remaining = sessions.filter(session => session.id !== id)
    const next = remaining.length ? remaining : [newSession()]
    setSessions(next)
    setTasks(current => current.filter(task => task.sessionId !== id))
    setConversations(current => current.filter(conversation => conversation.sessionId !== id))
    // The tab to the left takes over, or the new first tab when the first one closes.
    if (id === activeSessionId) setActiveSessionId(next[Math.max(0, sessions.findIndex(session => session.id === id) - 1)].id)
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt) return
    setInput('')
    send(prompt)
  }

  // An agent is working while any of its tasks has not reached a final state.
  // The first agent is the router, whose tasks are the ones streamed to this page.
  const workingIds = new Set(specialistTasks.filter(task => !TERMINAL.includes(taskState(task))).map(task => task.agent))
  const busySessionIds = new Set([
    ...tasks.filter(task => !TERMINAL.includes(task.state)).map(task => task.sessionId),
    ...conversations.filter(conversation => conversation.working).map(conversation => conversation.sessionId),
  ])
  if (agents[0] && busySessionIds.size) workingIds.add(agents[0].id)
  const router = agents[0]
  // The active session's thread: loan-officer tasks and borrower conversations, oldest first.
  const turns = [
    ...tasks.filter(task => task.sessionId === activeSession.id).map(task => ({ startedAt: task.startedAt, task, conversation: undefined })),
    ...conversations
      .filter(conversation => conversation.sessionId === activeSession.id)
      .map(conversation => ({ startedAt: conversation.startedAt, task: undefined, conversation })),
  ].sort((a, b) => a.startedAt - b.startedAt)
  // The router passes its own context on to the specialists: the session's `contextId` for a
  // loan-officer turn, the PAP conversation id for a borrower turn. That ties a task to a session.
  const sessionContextIds = new Set([
    activeSession.contextId,
    ...conversations.filter(conversation => conversation.sessionId === activeSession.id).map(conversation => conversation.conversationId),
  ])
  const sessionTasks = specialistTasks.filter(task => sessionContextIds.has(task.contextId))
  const activeTaskCount = sessionTasks.filter(task => !TERMINAL.includes(taskState(task))).length
  const openAgent = agents.find(agent => agent.id === openAgentId)
  const settingsAgent = agents.find(agent => agent.id === settingsAgentId)

  return (
    <div className="layout">
      <aside ref={asideRef}>
        <h2>Front door</h2>
        <button type="button" className="agent-item" onClick={() => setPoppyOpen(true)}>
          <span className="avatar protocol">PAP</span>
          <span className="agent-name">Personal Agent Protocol</span>
          <span className="agent-status">{discovery?.document ? 'poppy.json published' : 'offline'}</span>
        </button>
        {/* No chat mode: an MCP client (the borrower's assistant) connects to this URL itself. */}
        <button type="button" className="agent-item" onClick={() => setMcpOpen(true)}>
          <span className="avatar protocol">MCP</span>
          <span className="agent-name">Model Context Protocol</span>
          <span className="agent-status">
            {mcp?.tools ? `${mcp.tools.length} ${mcp.tools.length === 1 ? 'tool' : 'tools'} published` : 'offline'}
          </span>
        </button>
        <h2>Agents</h2>
        {agents.map(agent => {
          const working = workingIds.has(agent.id)
          const disabled = agent.enabled === false
          return (
            <div key={agent.id} className={`agent-row${disabled ? ' disabled' : ''}`}>
              <button type="button" className="agent-item" data-agent={agent.id} onClick={() => setOpenAgentId(agent.id)}>
                <Avatar id={agent.id} working={working} />
                <span className="agent-name">{displayName(agent.id)}</span>
                <span className={`agent-status${working ? ' working' : ''}`}>
                  {disabled ? 'disabled' : !agent.card ? 'offline' : working ? 'working…' : 'idle'}
                  {!disabled && !!agent.delayMs && ` · ${agent.delayMs / 1000}s delay`}
                </span>
              </button>
              {(agent.enabled !== null || agent.delayMs !== null) && (
                <button
                  type="button"
                  className="settings-button"
                  aria-label={`${displayName(agent.id)} settings`}
                  title="Settings"
                  onClick={() => setSettingsAgentId(agent.id)}
                >
                  <GearIcon />
                </button>
              )}
            </div>
          )
        })}
        {signals.map(signal => {
          const tone = `${signal.kind}${signal.failed ? ' failed' : ''}`
          const animationDelay = `${signal.delay}ms`
          return (
            <span key={signal.key}>
              <span
                className={`track ${tone}`}
                style={{ top: Math.min(signal.top, signal.top + signal.dy), left: signal.left, height: Math.abs(signal.dy), animationDelay }}
              />
              <span
                className={`packet ${tone}`}
                style={{ top: signal.top, left: signal.left, '--dy': `${signal.dy}px`, animationDelay } as CSSProperties}
              />
              <span
                className={`signal-note ${tone}`}
                style={{ top: signal.noteTop, '--x': `${signal.noteLeft}px`, animationDelay } as CSSProperties}
              >
                <span>
                  <b>
                    {signal.kind === 'request'
                      ? `${displayName(agents[0].id)} asks ${displayName(signal.agent)}`
                      : `${displayName(signal.agent)} replies`}
                  </b>{' '}
                  {signal.text}
                </span>
              </span>
            </span>
          )
        })}
      </aside>
      {poppyOpen && discovery && <PoppyModal discovery={discovery} onClose={() => setPoppyOpen(false)} />}
      {mcpOpen && mcp && <McpModal door={mcp} onClose={() => setMcpOpen(false)} />}
      {openAgent && (
        <AgentModal agent={openAgent} working={workingIds.has(openAgent.id)} onClose={() => setOpenAgentId(undefined)} />
      )}
      {settingsAgent && (
        <SettingsModal
          agent={settingsAgent}
          onToggle={enabled => toggleAgent(settingsAgent.id, enabled)}
          onDelayChange={delayMs => setAgentDelay(settingsAgent.id, delayMs)}
          onClose={() => setSettingsAgentId(undefined)}
        />
      )}
    <main>
      <div className="workspace">
        <section className="chat">
          <div className="sessions" role="tablist" aria-label="Chat sessions">
            {sessions.map(session => (
              <span key={session.id} className="session-tab" aria-selected={session.id === activeSession.id}>
                <button type="button" role="tab" aria-selected={session.id === activeSession.id} onClick={() => setActiveSessionId(session.id)}>
                  {busySessionIds.has(session.id) && <i className="session-busy" aria-label="Working" />}
                  <span className="session-title">{session.title ?? 'New chat'}</span>
                </button>
                <button type="button" className="session-close" aria-label="Close session" onClick={() => closeSession(session.id)}>
                  ×
                </button>
              </span>
            ))}
            <button type="button" className="session-new" aria-label="New chat session" onClick={startSession}>
              +
            </button>
            <button type="button" className="drawer-toggle" aria-expanded={tasksOpen} onClick={() => setTasksOpen(open => !open)}>
              {activeTaskCount > 0 && <i className="session-busy" aria-label="Working" />}
              Specialist tasks <small>{sessionTasks.length}</small>
            </button>
          </div>
          <div className="messages" ref={messagesRef}>
            {turns.length === 0 && (
              <div className="chat-empty">
                <p>{mode === 'pap' ? 'Ask the lender something, as the borrower’s agent' : 'Ask the loan router something'}, or try one of these:</p>
                <div className="suggestions">
                  {SUGGESTIONS[mode].map(suggestion => (
                    <button key={suggestion} type="button" onClick={() => send(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map(({ task, conversation }) => {
              // Loan officer turn: an A2A task followed over an SSE stream (message/stream).
              if (task) {
                const running = !TERMINAL.includes(task.state)
                return (
                  <div key={task.localId} className="turn">
                    <span className="sender">Loan officer · A2A</span>
                    <div className="bubble user">{task.prompt}</div>
                    <div className="reply">
                      {router && <Avatar id={router.id} working={running} />}
                      <div className={`bubble router${task.state === 'failed' ? ' failed' : ''}`}>
                        {task.answer ? <Markdown text={task.answer} /> : <Typing />}
                        <details className="events">
                          <summary>
                            <span className={`badge ${task.state}`}>{task.state}</span> {task.log.length} A2A events
                          </summary>
                          {task.taskId && <code>task {task.taskId}</code>}
                          <Timeline log={task.log} pending={running ? 'waiting for next event…' : undefined} />
                        </details>
                      </div>
                    </div>
                  </div>
                )
              }

              // Borrower's agent turn: a PAP conversation, events by long-poll.
              const { operation } = conversation
              const secondsLeft = operation ? Math.round((Date.parse(operation.expires_at) - now) / 1000) : 0
              const operationState = conversation.operationState === 'awaiting' && secondsLeft <= 0 ? 'expired' : conversation.operationState
              const state = conversation.error ? 'failed' : conversation.working ? 'working' : operationState === 'awaiting' ? 'approval needed' : 'idle'
              const text = conversation.error ?? conversation.answer
              return (
                <div key={conversation.localId} className="turn">
                  <span className="sender">Borrower’s agent · PAP</span>
                  <div className="bubble user">{conversation.prompt}</div>
                  <div className="reply">
                    {router && <Avatar id={router.id} working={conversation.working} />}
                    <div className={`bubble router${conversation.error ? ' failed' : ''}`}>
                      {text ? <Markdown text={text} /> : !operation && <Typing />}
                      {operation && (
                        <div className={`approval ${operationState}`}>
                          <div className="row">
                            <strong>Approval requested</strong>
                            <span className="operation-state">
                              {operationState === 'awaiting'
                                ? `expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
                                : operationState === 'approved'
                                  ? 'approved · sent to the company'
                                  : operationState}
                            </span>
                          </div>
                          {operation.summary && <p>{emphasis(operation.summary)}</p>}
                          <dl>
                            {Object.entries(operation.terms).map(([key, value]) => (
                              <div key={key}>
                                <dt>{key}</dt>
                                <dd>{String(value)}</dd>
                              </div>
                            ))}
                          </dl>
                          <code>
                            {operation.operation_id} · {operation.revision}
                          </code>
                          {operationState === 'awaiting' && (
                            <div className="actions">
                              <button type="button" onClick={() => approve(conversation)}>
                                Approve
                              </button>
                              <button
                                type="button"
                                className="quiet"
                                onClick={() => patchConversation(conversation.localId, current => ({ ...current, operationState: 'declined' }))}
                              >
                                Decline
                              </button>
                            </div>
                          )}
                          {operationState === 'declined' && <p className="note">Nothing was sent: without an approval the company does not act.</p>}
                        </div>
                      )}
                      <details className="events">
                        <summary>
                          <span className={`badge ${state === 'idle' ? 'completed' : state}`}>{state}</span> {conversation.log.length} PAP steps
                        </summary>
                        {conversation.conversationId && <code>conversation {conversation.conversationId}</code>}
                        <Timeline log={conversation.log} pending={conversation.working ? 'company is working…' : undefined} />
                      </details>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="composer">
            <div className="mode" role="radiogroup" aria-label="Who is asking">
              <button type="button" role="radio" aria-checked={mode === 'a2a'} onClick={() => setMode('a2a')}>
                Loan officer <small>A2A</small>
              </button>
              <button type="button" role="radio" aria-checked={mode === 'pap'} onClick={() => setMode('pap')}>
                Borrower’s agent <small>PAP</small>
              </button>
            </div>
            <form onSubmit={onSubmit}>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={mode === 'pap' ? 'Message the lender, as the borrower’s agent…' : 'Message the loan router…'}
                autoFocus
              />
              <button type="submit" disabled={!input.trim()}>
                Send
              </button>
            </form>
          </div>
        </section>
      </div>
    </main>
      {/* Always mounted so it can slide; it does not block the chat while open. */}
      <section className={`drawer${tasksOpen ? ' open' : ''}`} aria-label="Specialist tasks" aria-hidden={!tasksOpen}>
        <div className="drawer-head">
          <h2>Specialist tasks</h2>
          <button type="button" className="close" onClick={() => setTasksOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
        <p className="hint">
          Router → specialists, for the chat session “{activeSession.title ?? 'New chat'}”. Each server is polled every second with A2A
          ListTasks.
        </p>
        {sessionTasks.length === 0 && <p className="empty">No delegated tasks in this session yet.</p>}
        {sessionTasks.map(task => {
          const state = taskState(task)
          const result = (task.artifacts ?? []).map(artifact => partsText(artifact.parts)).join('')
          return (
            <article key={`${task.agent}/${task.id}`}>
              <div className="row">
                <span className={`badge ${state}`}>{state}</span>
                <span className="agent">{task.agent}</span>
                <span className="prompt">{partsText(task.history?.[0]?.parts) || '(delegated request)'}</span>
              </div>
              <code>task {task.id}</code>
              {result && (
                <div className="answer">
                  <Markdown text={result} />
                </div>
              )}
            </article>
          )
        })}
      </section>
    </div>
  )
}

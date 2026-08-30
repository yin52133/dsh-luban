import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SessionId as DshSessionId,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type {
  AccountSessionRegistry,
  Actor,
  HostId,
  KeepaliveEvent,
  ManagedSession,
  SessionId,
  Task,
  TaskId,
} from 'dsh-luban-core'
import { LubanError, asActorId, asSessionId } from 'dsh-luban-core'
import type { SharedSessionRegistry } from './registry.js'
import type { SessionInputSink } from './types.js'

const MAX_TURN_OUTPUT_BYTES = 64 * 1024
const TRUNCATED_OUTPUT_MARKER = '\n[output truncated]\n'
const TRUNCATED_OUTPUT_MARKER_BYTES = Buffer.byteLength(TRUNCATED_OUTPUT_MARKER, 'utf8')
const REPLACEMENT_CHARACTER = '\uFFFD'

interface TurnOutputBuffer {
  readonly turn: number
  text: string
  bytes: number
  pendingHighSurrogate: string
  truncated: boolean
  at: number
}

export type DshSessionBridgeOptions = {
  readonly agents: AgentRegistry
  readonly registry: SharedSessionRegistry
  readonly host: HostId
} & (
  | { readonly accountSessions: AccountSessionRegistry; readonly owner?: Actor }
  | { readonly accountSessions?: undefined; readonly owner: Actor }
)

function trailingHighSurrogate(value: string): boolean {
  if (value.length === 0) return false
  const code = value.charCodeAt(value.length - 1)
  return code >= 0xd800 && code <= 0xdbff
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
): { readonly text: string; readonly bytes: number } {
  let bytes = 0
  let text = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maximumBytes) break
    text += character
    bytes += characterBytes
  }
  return { text, bytes }
}

function isShareableRoot(agents: AgentRegistry, agent: Agent): boolean {
  return agents.roots().includes(agent) && agent.session.header.origin !== 'subagent'
}

/** Inject operator text at the rc2 Agent inbox boundary. */
export class DshSessionInputSink implements SessionInputSink {
  readonly #agents: AgentRegistry

  public constructor(agents: AgentRegistry) {
    this.#agents = agents
  }

  public inject(id: SessionId, text: string): Promise<void> {
    const agent = this.#agents.get(DshSessionId(id))
    if (agent === undefined || !isShareableRoot(this.#agents, agent)) {
      throw new LubanError('E_NOT_FOUND', `DSH session ${id} is not a shareable live session`)
    }
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-luban-session-share' },
      }),
    )
    return Promise.resolve()
  }
}

/** Project live rc2 Agent and durable Session events into the shared registry. */
export class DshSessionBridge {
  readonly #agents: AgentRegistry
  readonly #registry: SharedSessionRegistry
  readonly #host: HostId
  readonly #owner: Actor | undefined
  readonly #accountSessions: AccountSessionRegistry | undefined
  readonly #managed = new Map<string, ManagedSession>()
  readonly #shared = new Map<SessionId, Agent>()
  readonly #registering = new Map<SessionId, Promise<void>>()
  readonly #turnOutput = new Map<SessionId, TurnOutputBuffer>()
  #disposed = false

  public constructor(options: DshSessionBridgeOptions) {
    this.#agents = options.agents
    this.#registry = options.registry
    this.#host = options.host
    this.#owner = options.owner
    this.#accountSessions = options.accountSessions
    if (this.#owner === undefined && this.#accountSessions === undefined) {
      throw new LubanError('E_INVALID_INPUT', 'A session owner resolver is required')
    }
  }

  public initialize(managed: readonly ManagedSession[]): void {
    for (const session of managed) this.#managed.set(session.id, session)
    for (const agent of this.#agents.roots()) this.agentCreated(agent)
  }

  public agentCreated(agent: Agent): void {
    if (this.#disposed) return
    if (!isShareableRoot(this.#agents, agent)) return
    const id = asSessionId(agent.id)
    if (this.#accountSessions !== undefined) {
      if (this.#shared.get(id) === agent) return
      const pending = this.#registering.get(id)
      if (pending !== undefined) {
        void pending.then((): void => this.agentCreated(agent))
        return
      }
      const operation = this.#accountSessions
        .ownerOf(id)
        .then((accountId): void => {
          if (this.#disposed || accountId === null || !isShareableRoot(this.#agents, agent)) return
          this.#registerAgent(agent, {
            kind: 'user',
            id: asActorId(accountId),
            accountId,
            displayName: accountId,
          })
        })
        .catch((error: unknown): void => {
          process.emitWarning(
            error instanceof Error ? error.message : 'Unable to resolve DSH session ownership',
            { code: 'LUBAN_SESSION_OWNER' },
          )
        })
        .finally((): void => {
          if (this.#registering.get(id) === operation) this.#registering.delete(id)
        })
      this.#registering.set(id, operation)
      return
    }
    const owner = this.#owner
    if (owner === undefined) return
    this.#registerAgent(agent, owner)
  }

  #registerAgent(agent: Agent, owner: Actor): void {
    if (this.#disposed || !isShareableRoot(this.#agents, agent)) return
    const id = asSessionId(agent.id)
    const managed = this.#managed.get(agent.id)
    const ownerTaskId =
      owner.accountId !== undefined && managed?.accountId === owner.accountId
        ? managed.ownerTaskId
        : undefined
    this.#registry.registerLocal({
      id,
      host: this.#host,
      ...(owner.accountId === undefined ? {} : { accountId: owner.accountId }),
      owner,
      ...(ownerTaskId === undefined ? {} : { ownerTaskId }),
      healthy: true,
      status: agent.status,
    })
    this.#shared.set(id, agent)
    this.#turnOutput.delete(id)
  }

  public agentDisposed(agent: Agent): void {
    const id = asSessionId(agent.id)
    if (this.#shared.get(id) !== agent) return
    this.#shared.delete(id)
    this.#flushTurnOutput(id)
    this.#registry.removeLocal(id)
  }

  public agentStatus(agent: Agent, status: string): void {
    const id = asSessionId(agent.id)
    if (this.#shared.get(id) !== agent) {
      this.agentCreated(agent)
      if (this.#shared.get(id) !== agent) return
    }
    if (this.#registry.getView(id) === undefined) this.agentCreated(agent)
    else this.#registry.updateLocal(id, { healthy: true, status })
  }

  public sessionEvent(session: Session, event: SessionEvent): void {
    const id = asSessionId(session.id)
    if (this.#shared.get(id)?.session !== session) return
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      this.#appendTurnOutput(id, event.data.turn, event.data.chunk.text, event.time)
      return
    }
    if (event.type === 'turn/end') this.#flushTurnOutput(id, event.data.turn, event.time)
  }

  public keepaliveEvent(event: KeepaliveEvent): void {
    if (event.type === 'started' || event.type === 'restored') {
      this.#managed.set(event.session.id, event.session)
      this.#updateTask(event.session)
      return
    }
    for (const item of event.report.sessions) {
      const candidates = item.id.startsWith('luban-')
        ? [item.id, item.id.slice('luban-'.length)]
        : [item.id]
      for (const candidate of candidates) {
        const id = asSessionId(candidate)
        const sharedAgent = this.#shared.get(id)
        if (sharedAgent !== undefined) {
          const current = this.#registry.getView(id)
          if (current === undefined) break
          const liveStatus = sharedAgent.status
          this.#registry.updateLocal(id, {
            healthy: item.alive,
            ...(item.alive
              ? liveStatus === current.status
                ? {}
                : { status: liveStatus }
              : { status: 'unhealthy' }),
          })
          break
        }
      }
    }
  }

  public async syncTasks(tasks: readonly Task[]): Promise<void> {
    if (this.#disposed) return
    await this.#refreshAccountOwnership()
    const links = new Map<SessionId, TaskId>()
    for (const task of tasks) {
      if (task.claim !== undefined && task.claim !== null) {
        const view = this.#registry.getView(task.claim.sessionId)
        if (task.accountId !== undefined && view?.accountId === task.accountId) {
          links.set(task.claim.sessionId, task.id)
        }
      }
    }
    for (const id of this.#shared.keys()) {
      this.#registry.setOwnerTask(id, links.get(id) ?? null)
    }
  }

  async #refreshAccountOwnership(): Promise<void> {
    if (this.#accountSessions === undefined) return
    const roots = this.#agents.roots()
    for (const agent of roots) this.agentCreated(agent)
    await Promise.all([...this.#registering.values()])
    // A lookup may have started just before M01 persisted the binding. Retry once after it settles.
    for (const agent of roots) this.agentCreated(agent)
    await Promise.all([...this.#registering.values()])
  }

  public dispose(): void {
    this.#disposed = true
    this.#registering.clear()
    this.#turnOutput.clear()
  }

  #appendTurnOutput(id: SessionId, turn: number, text: string, at: number): void {
    let buffer = this.#turnOutput.get(id)
    if (buffer !== undefined && buffer.turn !== turn) {
      this.#flushTurnOutput(id)
      buffer = undefined
    }
    if (buffer === undefined) {
      buffer = { turn, text: '', bytes: 0, pendingHighSurrogate: '', truncated: false, at }
      this.#turnOutput.set(id, buffer)
    }
    buffer.at = at
    if (buffer.truncated || text === '') return
    let complete = `${buffer.pendingHighSurrogate}${text}`
    buffer.pendingHighSurrogate = ''
    if (trailingHighSurrogate(complete)) {
      buffer.pendingHighSurrogate = complete.slice(-1)
      complete = complete.slice(0, -1)
    }
    const completeBytes = Buffer.byteLength(complete, 'utf8')
    if (buffer.bytes + completeBytes <= MAX_TURN_OUTPUT_BYTES) {
      buffer.text += complete
      buffer.bytes += completeBytes
      return
    }
    const available = Math.max(0, MAX_TURN_OUTPUT_BYTES - buffer.bytes)
    const retained = truncateUtf8(complete, available)
    buffer.text += retained.text
    buffer.bytes += retained.bytes
    this.#markTurnOutputTruncated(buffer)
  }

  #flushTurnOutput(id: SessionId, turn?: number, at?: number): void {
    const buffer = this.#turnOutput.get(id)
    if (buffer === undefined || (turn !== undefined && buffer.turn !== turn)) return
    this.#turnOutput.delete(id)
    if (!buffer.truncated && buffer.pendingHighSurrogate !== '') {
      const replacementBytes = Buffer.byteLength(REPLACEMENT_CHARACTER, 'utf8')
      if (buffer.bytes + replacementBytes <= MAX_TURN_OUTPUT_BYTES) {
        buffer.text += REPLACEMENT_CHARACTER
        buffer.bytes += replacementBytes
      } else {
        this.#markTurnOutputTruncated(buffer)
      }
    }
    const text = buffer.truncated ? `${buffer.text}${TRUNCATED_OUTPUT_MARKER}` : buffer.text
    if (text !== '') this.#registry.publishOutput(id, text, at ?? buffer.at)
  }

  #markTurnOutputTruncated(buffer: TurnOutputBuffer): void {
    const retained = truncateUtf8(
      buffer.text,
      MAX_TURN_OUTPUT_BYTES - TRUNCATED_OUTPUT_MARKER_BYTES,
    )
    buffer.text = retained.text
    buffer.bytes = retained.bytes
    buffer.pendingHighSurrogate = ''
    buffer.truncated = true
  }

  #updateTask(session: ManagedSession): void {
    if (session.accountId === undefined || session.ownerTaskId === undefined) return
    const candidates = session.id.startsWith('luban-')
      ? [session.id, session.id.slice('luban-'.length)]
      : [session.id]
    for (const candidate of candidates) {
      const sessionId = asSessionId(candidate)
      if (this.#registry.getView(sessionId)?.accountId === session.accountId) {
        this.#registry.setOwnerTask(sessionId, session.ownerTaskId)
        return
      }
    }
  }
}

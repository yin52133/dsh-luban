import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SessionId as DshSessionId,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type {
  Actor,
  HostId,
  KeepaliveEvent,
  ManagedSession,
  SessionId,
  Task,
  TaskId,
} from '@luban/core'
import { LubanError, asSessionId } from '@luban/core'
import type { SharedSessionRegistry } from './registry.js'
import type { SessionInputSink } from './types.js'

const MAX_TURN_OUTPUT_CHARS = 65_536
const TRUNCATED_OUTPUT_MARKER = '\n[output truncated]\n'

interface TurnOutputBuffer {
  readonly turn: number
  text: string
  truncated: boolean
  at: number
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
  readonly #owner: Actor
  readonly #managed = new Map<string, ManagedSession>()
  readonly #shared = new Map<SessionId, Agent>()
  readonly #turnOutput = new Map<SessionId, TurnOutputBuffer>()

  public constructor(options: {
    readonly agents: AgentRegistry
    readonly registry: SharedSessionRegistry
    readonly host: HostId
    readonly owner: Actor
  }) {
    this.#agents = options.agents
    this.#registry = options.registry
    this.#host = options.host
    this.#owner = options.owner
  }

  public initialize(managed: readonly ManagedSession[]): void {
    for (const session of managed) this.#managed.set(session.id, session)
    for (const agent of this.#agents.roots()) this.agentCreated(agent)
  }

  public agentCreated(agent: Agent): void {
    if (!isShareableRoot(this.#agents, agent)) return
    const id = asSessionId(agent.id)
    const managed = this.#managed.get(agent.id)
    this.#registry.registerLocal({
      id,
      host: this.#host,
      owner: this.#owner,
      ...(managed?.ownerTaskId === undefined ? {} : { ownerTaskId: managed.ownerTaskId }),
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
      this.#updateTask(event.session.id, event.session.ownerTaskId)
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

  public syncTasks(tasks: readonly Task[]): void {
    const links = new Map<SessionId, TaskId>()
    for (const task of tasks) {
      if (task.claim !== undefined && task.claim !== null) {
        links.set(task.claim.sessionId, task.id)
      }
    }
    for (const id of this.#shared.keys()) {
      this.#registry.setOwnerTask(id, links.get(id) ?? null)
    }
  }

  #appendTurnOutput(id: SessionId, turn: number, text: string, at: number): void {
    let buffer = this.#turnOutput.get(id)
    if (buffer !== undefined && buffer.turn !== turn) {
      this.#flushTurnOutput(id)
      buffer = undefined
    }
    if (buffer === undefined) {
      buffer = { turn, text: '', truncated: false, at }
      this.#turnOutput.set(id, buffer)
    }
    buffer.at = at
    if (buffer.truncated || text === '') return
    const remaining = MAX_TURN_OUTPUT_CHARS - buffer.text.length
    if (remaining > 0) buffer.text += text.slice(0, remaining)
    if (text.length > remaining) buffer.truncated = true
  }

  #flushTurnOutput(id: SessionId, turn?: number, at?: number): void {
    const buffer = this.#turnOutput.get(id)
    if (buffer === undefined || (turn !== undefined && buffer.turn !== turn)) return
    this.#turnOutput.delete(id)
    const text = buffer.truncated ? `${buffer.text}${TRUNCATED_OUTPUT_MARKER}` : buffer.text
    if (text !== '') this.#registry.publishOutput(id, text, at ?? buffer.at)
  }

  #updateTask(id: string, taskId: TaskId | undefined): void {
    if (taskId === undefined) return
    const candidates = id.startsWith('luban-') ? [id, id.slice('luban-'.length)] : [id]
    for (const candidate of candidates) {
      const sessionId = asSessionId(candidate)
      if (this.#shared.has(sessionId)) {
        this.#registry.setOwnerTask(sessionId, taskId)
        return
      }
    }
  }
}

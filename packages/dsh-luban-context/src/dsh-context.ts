import { resolve } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  Clock,
  CompactionSurfaceSnapshotIndex,
  ContextSegment,
  SessionRef,
  TelemetryAggregator,
} from 'dsh-luban-core'
import { LubanError, asSessionId, redactSecrets } from 'dsh-luban-core'
import { ContextArchiveRepository } from './archive.js'
import type { Config } from './config.js'
import type {
  CompactionContextFactory,
  CompactionEngineWithReplay,
  CompactionWorkspace,
} from './engine.js'
import type { ReadableCompactionContext } from './strategies.js'

interface SegmentSnapshot {
  readonly segment: ContextSegment
  readonly eventSeq: number
  readonly content: string
}

function stringifyEvent(session: Session, event: SessionEvent): string {
  const message = session.deriveEventMessage(event)
  return JSON.stringify(message ?? event.data, null, 2)
}

function segmentTopic(content: string): string | undefined {
  const compact = content.replace(/\s+/gu, ' ').trim()
  return compact === '' ? undefined : compact.slice(0, 120)
}

function segmentSnapshots(session: Session): readonly SegmentSnapshot[] {
  const bySequence = new Map(
    session.events.map((event): readonly [number, SessionEvent] => [event.seq, event]),
  )
  return session.surface.nodes.map((eventSeq, index): SegmentSnapshot => {
    const event = bySequence.get(eventSeq)
    if (event === undefined)
      throw new LubanError('E_IO', `Surface event ${String(eventSeq)} is missing`)
    const content = stringifyEvent(session, event)
    const topic = segmentTopic(content)
    return {
      segment: {
        startSeq: index,
        endSeq: index,
        estTokens: Math.max(1, Math.ceil(content.length / 4)),
        ...(topic === undefined ? {} : { topic }),
      },
      eventSeq,
      content,
    }
  })
}

export function sessionRefFromAgent(agent: Agent): SessionRef {
  return {
    id: asSessionId(agent.id),
    segments: segmentSnapshots(agent.session).map((snapshot): ContextSegment => snapshot.segment),
    atTurnBoundary: agent.status === 'idle',
  }
}

function importantLines(content: string): readonly string[] {
  const lines = content
    .split(/\r?\n/u)
    .map((line): string => line.trim())
    .filter(Boolean)
  const important = lines.filter((line): boolean =>
    /\b(?:decision|constraint|requirement|acceptance|must|should|todo|error)\b|(?:决定|约束|要求|验收|必须|错误)/iu.test(
      line,
    ),
  )
  return [...new Set([...lines.slice(0, 12), ...important, ...lines.slice(-8)])].slice(0, 80)
}

/** DSH session adapter: reads the live surface and replaces an old prefix with a cited summary node. */
export class DshCompactionContext implements ReadableCompactionContext {
  public readonly sessionId: ReturnType<typeof asSessionId>
  public readonly archiveDir: string
  readonly #session: Session
  readonly #snapshots: readonly SegmentSnapshot[]
  readonly #repository: ContextArchiveRepository
  readonly #touched = new Set<number>()

  public constructor(options: {
    readonly session: Session
    readonly snapshots: readonly SegmentSnapshot[]
    readonly repository: ContextArchiveRepository
    readonly archiveDir: string
  }) {
    this.#session = options.session
    this.#snapshots = options.snapshots
    this.#repository = options.repository
    this.sessionId = asSessionId(options.session.id)
    this.archiveDir = options.archiveDir
  }

  public read(segment: ContextSegment): Promise<string> {
    const selected = this.#selected(segment)
    for (const snapshot of selected) this.#touched.add(snapshot.eventSeq)
    return Promise.resolve(
      selected
        .map(
          (snapshot): string =>
            `## Surface message ${String(snapshot.segment.startSeq)} (event ${String(snapshot.eventSeq)})\n\n${snapshot.content}`,
        )
        .join('\n\n'),
    )
  }

  public async archive(segment: ContextSegment, content: string): Promise<string> {
    for (const snapshot of this.#selected(segment)) this.#touched.add(snapshot.eventSeq)
    return this.#repository.archive(segment, content)
  }

  public async summarize(segments: readonly ContextSegment[]): Promise<string> {
    const contents: string[] = []
    for (const segment of segments) contents.push(await this.read(segment))
    const lines = importantLines(contents.join('\n'))
    if (lines.length === 0) return 'Earlier context contained no textual content.'
    const summary = [
      'Compacted earlier context (preserve these decisions and constraints):',
      ...lines.map((line): string => `- ${line}`),
    ].join('\n')
    return redactSecrets(summary).slice(0, 12_000)
  }

  public inject(summary: string, archiveFiles: readonly string[]): Promise<void> {
    const surfaceNodes = this.#session.surface.nodes
    const selected = surfaceNodes.filter((sequence): boolean => this.#touched.has(sequence))
    if (selected.length === 0) return Promise.resolve()
    const positions = selected.map((sequence): number => surfaceNodes.indexOf(sequence))
    const firstPosition = Math.min(...positions)
    const lastPosition = Math.max(...positions)
    if (firstPosition !== 0 || lastPosition - firstPosition + 1 !== selected.length) {
      throw new LubanError(
        'E_INVALID_INPUT',
        'Compaction may replace only one contiguous old-context prefix',
      )
    }
    const index =
      archiveFiles.length === 0
        ? ''
        : `\n\nExact archived source (retrieve when detail is needed):\n${archiveFiles.map((file): string => `- ${file}`).join('\n')}`
    const content = redactSecrets(`${summary}${index}`)
    this.#session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: content }],
        source: { kind: 'plugin', plugin: 'dsh-luban-context' },
      }),
      {
        surfaceOp: { op: 'replace', start: selected[0] ?? 0, end: selected.at(-1) ?? 0 },
        sourceEventSeqs: selected,
      },
    )
    return Promise.resolve()
  }

  /** Capture the current model-visible surface using durable event sequence identities. */
  public snapshotSurface(): CompactionSurfaceSnapshotIndex {
    const snapshots = segmentSnapshots(this.#session)
    return {
      totalTokens: snapshots.reduce(
        (total, snapshot): number => total + snapshot.segment.estTokens,
        0,
      ),
      entries: snapshots.map((snapshot) => ({
        eventSeq: snapshot.eventSeq,
        segment: snapshot.segment,
      })),
    }
  }

  #selected(segment: ContextSegment): readonly SegmentSnapshot[] {
    const selected = this.#snapshots.filter(
      (snapshot): boolean =>
        snapshot.segment.startSeq >= segment.startSeq && snapshot.segment.endSeq <= segment.endSeq,
    )
    if (selected.length === 0) {
      throw new LubanError(
        'E_NOT_FOUND',
        `Context segment ${String(segment.startSeq)}-${String(segment.endSeq)} is unavailable`,
      )
    }
    return selected
  }
}

export class DshCompactionContextFactory implements CompactionContextFactory {
  readonly #agents: AgentRegistry
  readonly #config: Config
  readonly #clock: Clock

  public constructor(agents: AgentRegistry, config: Config, clock: Clock) {
    this.#agents = agents
    this.#config = config
    this.#clock = clock
  }

  public create(session: SessionRef): Promise<CompactionWorkspace> {
    const agent = this.#agents.get(SessionId(session.id))
    if (agent === undefined)
      throw new LubanError('E_NOT_FOUND', `Agent ${session.id} is not active`)
    if (agent.status !== 'idle')
      throw new LubanError('E_INVALID_TRANSITION', 'Compaction requires an idle turn boundary')
    const workspace = resolve(agent.session.header.cwd ?? process.cwd())
    const repository = new ContextArchiveRepository({
      workspace,
      archiveDir: this.#config.archiveDir,
      sessionId: session.id,
      clock: this.#clock,
    })
    const context = new DshCompactionContext({
      session: agent.session,
      snapshots: segmentSnapshots(agent.session),
      repository,
      archiveDir: resolve(workspace, this.#config.archiveDir),
    })
    return Promise.resolve({
      repository,
      context,
      snapshotSurface: (): CompactionSurfaceSnapshotIndex => context.snapshotSurface(),
    })
  }

  public open(sessionId: ReturnType<typeof asSessionId>): Promise<ContextArchiveRepository> {
    const agent = this.#agents.get(SessionId(sessionId))
    if (agent === undefined) throw new LubanError('E_NOT_FOUND', `Agent ${sessionId} is not active`)
    return Promise.resolve(
      new ContextArchiveRepository({
        workspace: resolve(agent.session.header.cwd ?? process.cwd()),
        archiveDir: this.#config.archiveDir,
        sessionId,
        clock: this.#clock,
      }),
    )
  }
}

export interface CompactionCoordinatorOptions {
  readonly engine: CompactionEngineWithReplay
  readonly telemetry: TelemetryAggregator
  readonly onError?: (error: unknown) => void
}

/** Schedule compaction as an agent maintenance task only after it becomes truly idle. */
export class DshCompactionCoordinator {
  readonly #engine: CompactionEngineWithReplay
  readonly #telemetry: TelemetryAggregator
  readonly #onError: (error: unknown) => void
  readonly #pending = new Set<Promise<void>>()
  readonly #lifecycle = new AbortController()

  public constructor(options: CompactionCoordinatorOptions) {
    this.#engine = options.engine
    this.#telemetry = options.telemetry
    this.#onError = options.onError ?? ((): void => undefined)
  }

  public onAgentStatus(agent: Agent, status: Agent['status']): void {
    if (this.#isDisposed() || status !== 'idle' || agent.session.surface.nodes.length < 2) return
    let maintenance: Promise<void>
    try {
      maintenance = Promise.resolve(
        agent.runMaintenance(async (): Promise<void> => {
          if (this.#isDisposed()) return
          const session = sessionRefFromAgent(agent)
          const telemetry = await this.#telemetry.snapshotFor(session.id)
          if (this.#isDisposed()) return
          await this.#engine.maybeCompact(session, telemetry)
        }),
      )
    } catch (error: unknown) {
      this.#reportError(error)
      return
    }
    const tracked = maintenance
      .catch((error: unknown): void => this.#reportError(error))
      .finally((): void => void this.#pending.delete(tracked))
    this.#pending.add(tracked)
  }

  public async dispose(): Promise<void> {
    this.#lifecycle.abort()
    await Promise.allSettled([...this.#pending])
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error)
    } catch {
      // Diagnostics must not escape an agent status listener or lifecycle disposer.
    }
  }

  #isDisposed(): boolean {
    return this.#lifecycle.signal.aborted
  }
}

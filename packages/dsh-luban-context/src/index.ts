import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AuthService, TelemetryAggregator } from 'dsh-luban-core'
import { LubanError, modulePrefix, systemClock } from 'dsh-luban-core'
import { Config as ConfigSchema, type Config as ContextConfig, parseConfig } from './config.js'
import {
  DshCompactionContextFactory,
  DshCompactionCoordinator,
  type PersistedSessionWorkspaceResolver,
} from './dsh-context.js'
import {
  DefaultCompactionEngine,
  type AccountCompactionDoneEvent,
  type CompactionEngineWithReplay,
} from './engine.js'
import { ContextHttpApi } from './http-api.js'
import {
  SummarizeStrategy,
  SummarizeVirtualFileStrategy,
  VirtualFileStrategy,
} from './strategies.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanCompaction: CompactionEngineWithReplay
  }

  interface Events {
    'luban.compaction.done'(payload: AccountCompactionDoneEvent): void
  }
}

export const name = 'luban-context'

interface SessionQueryWorkspaceSource {
  listSessions(): Promise<
    readonly {
      readonly header: { readonly id: unknown; readonly cwd?: string }
    }[]
  >
}

function persistedWorkspaceResolver(
  sessions: SessionQueryWorkspaceSource,
): PersistedSessionWorkspaceResolver {
  return async (sessionId) => {
    const record = (await sessions.listSessions()).find(
      (candidate): boolean => String(candidate.header.id) === String(sessionId),
    )
    if (record === undefined) return undefined
    return record.header.cwd === undefined ? {} : { cwd: record.header.cwd }
  }
}

export const inject = ['agents', 'webServer', 'lubanAuth', 'lubanTelemetry', 'sessionQuery']
export const provide = 'lubanCompaction'
export const Config = ConfigSchema
export type Config = ContextConfig
export { ContextArchiveRepository } from './archive.js'
export type { ArchiveIndexEntry } from './archive.js'
export { parseConfig } from './config.js'
export {
  DshCompactionContext,
  DshCompactionContextFactory,
  DshCompactionCoordinator,
  sessionRefFromAgent,
} from './dsh-context.js'
export type { PersistedSessionWorkspace, PersistedSessionWorkspaceResolver } from './dsh-context.js'
export { DefaultCompactionEngine } from './engine.js'
export type {
  AccountCompactionDoneEvent,
  CompactionCadence,
  CompactionContextFactory,
  CompactionEngineWithReplay,
  CompactionTaskScope,
  CompactionWorkspace,
} from './engine.js'
export { ContextHttpApi } from './http-api.js'
export {
  partitionRecent,
  SummarizeStrategy,
  SummarizeVirtualFileStrategy,
  VirtualFileStrategy,
} from './strategies.js'
export type { ReadableCompactionContext } from './strategies.js'

/** Mount built-in strategies, the turn-boundary coordinator, and authenticated replay routes. */
export function apply(ctx: Context, input: Partial<ContextConfig> = {}): void {
  const config = parseConfig(input)
  const auth = ctx.get('lubanAuth') as AuthService | undefined
  const telemetry = ctx.get('lubanTelemetry') as TelemetryAggregator | undefined
  const sessionQuery = ctx.get('sessionQuery') as SessionQueryWorkspaceSource | undefined
  if (auth === undefined || telemetry === undefined || sessionQuery === undefined) {
    throw new LubanError(
      'E_UNAVAILABLE',
      'lubanAuth, lubanTelemetry, and sessionQuery are required',
    )
  }
  const engine = new DefaultCompactionEngine({
    config,
    factory: new DshCompactionContextFactory(
      ctx.agents,
      config,
      systemClock,
      auth.accountSessions,
      persistedWorkspaceResolver(sessionQuery),
    ),
    accountSessions: auth.accountSessions,
    clock: systemClock,
    events: {
      emit: (_event, payload): void => ctx.emit('luban.compaction.done', payload),
    },
  })
  engine.register(new SummarizeStrategy())
  engine.register(new VirtualFileStrategy())
  engine.register(new SummarizeVirtualFileStrategy())
  engine.use(config.strategy, { taskScope: 'day' })
  engine.use(config.strategy, { taskScope: 'night' })
  const coordinator = new DshCompactionCoordinator({
    engine,
    telemetry,
    onError: (error): void =>
      ctx.logger.warn(
        `luban-context: ${error instanceof Error ? error.message : 'unknown compaction failure'}`,
      ),
  })
  const api = new ContextHttpApi(engine, auth)
  ctx.provide('lubanCompaction', engine)
  ctx.effect(() => {
    const unregisterRoute = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('context'),
      handler: api.handler,
    })
    const unregisterStatus = ctx.on('agent/status', ({ agent, status }): void => {
      coordinator.onAgentStatus(agent, status)
    })
    return async (): Promise<void> => {
      unregisterStatus()
      unregisterRoute()
      api.dispose()
      await coordinator.dispose()
    }
  }, 'luban-context: turn-boundary compaction and replay route lifecycle')
}

const plugin = Object.freeze({ name, inject, provide, Config, apply })
export default plugin

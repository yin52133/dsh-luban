import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AuthService, LubanEventMap, TelemetryAggregator } from '@luban/core'
import { LubanError, modulePrefix, systemClock } from '@luban/core'
import { Config as ConfigSchema, type Config as ContextConfig, parseConfig } from './config.js'
import { DshCompactionContextFactory, DshCompactionCoordinator } from './dsh-context.js'
import { DefaultCompactionEngine, type CompactionEngineWithReplay } from './engine.js'
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
    'luban.compaction.done'(payload: LubanEventMap['luban.compaction.done']): void
  }
}

export const name = 'luban-context'
export const inject = ['agents', 'webServer', 'lubanAuth', 'lubanTelemetry']
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
export { DefaultCompactionEngine } from './engine.js'
export type {
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
  if (auth === undefined || telemetry === undefined) {
    throw new LubanError('E_UNAVAILABLE', 'lubanAuth and lubanTelemetry are required')
  }
  const engine = new DefaultCompactionEngine({
    config,
    factory: new DshCompactionContextFactory(ctx.agents, config, systemClock),
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
    return (): void => {
      unregisterStatus()
      unregisterRoute()
    }
  }, 'luban-context: turn-boundary compaction and replay route lifecycle')
}

const plugin = Object.freeze({ name, inject, provide, Config, apply })
export default plugin

import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentClaimService, AuthService, NightScheduler, TaskStore } from '@luban/core'
import { modulePrefix, systemClock } from '@luban/core'
import { DefaultAgentClaimService } from './claim-service.js'
import {
  Config as ConfigSchema,
  type Config as TaskboardConfig,
  parseConfig,
  resolveStoreDirectory,
} from './config.js'
import { TaskboardHttpApi } from './http-api.js'
import { createLedgerStore } from './ledger.js'
import { DefaultNightScheduler, DshAgentNightExecutor } from './night-scheduler.js'
import { JsonTaskStore } from './task-store.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanAuth: AuthService
    lubanTaskStore: TaskStore
    lubanAgentClaim: AgentClaimService
    lubanNightScheduler: NightScheduler
  }
}

export const name = 'luban-taskboard'
export const inject = ['webServer', 'agents', 'tools', 'lubanAuth']
export const Config = ConfigSchema
export type Config = TaskboardConfig
export { DefaultAgentClaimService } from './claim-service.js'
export { parseConfig, resolveStoreDirectory } from './config.js'
export { TaskboardHttpApi, TaskEventStream } from './http-api.js'
export { createLedgerStore, decodeLedger, emptyLedger } from './ledger.js'
export type { SchedulerLedger, TaskAuditEntry, TaskLedger } from './ledger.js'
export { DefaultNightScheduler, DshAgentNightExecutor, isInWindow } from './night-scheduler.js'
export type { NightTaskExecutor, NightTaskExecutorRoute } from './night-scheduler.js'
export { JsonTaskStore } from './task-store.js'
export type { ImportReport, ImportTask } from './task-store.js'

function currentHostScope(config: TaskboardConfig['hostScope']): 'win' | 'ubuntu' {
  if (config === 'win' || config === 'ubuntu') return config
  if (config === 'any') return process.platform === 'win32' ? 'win' : 'ubuntu'
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'linux') return 'ubuntu'
  throw new Error(`dsh-luban-taskboard does not support ${process.platform}`)
}

function safeHostname(): string {
  const value = hostname()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .slice(0, 80)
  return value === '' ? 'local' : value
}

/** Mount durable services plus one authenticated REST/SSE route. */
export function apply(ctx: Context, input: Partial<TaskboardConfig> = {}): void {
  const config = parseConfig(input)
  const hostScope = currentHostScope(config.hostScope)
  const ledgerPath = join(resolveStoreDirectory(config.store.dir), `${safeHostname()}-ledger.json`)
  const store = new JsonTaskStore(createLedgerStore(ledgerPath, systemClock), systemClock)
  const claims = new DefaultAgentClaimService(store, hostScope, config.claim.requireAcceptance)
  const executor = new DshAgentNightExecutor(ctx.agents, config.night, systemClock)
  const scheduler = new DefaultNightScheduler({
    store,
    claims,
    executor,
    config: config.night,
    hostScope,
    clock: systemClock,
  })
  const api = new TaskboardHttpApi({ store, claims, scheduler, auth: ctx.lubanAuth })

  ctx.provide('lubanTaskStore', store)
  ctx.provide('lubanAgentClaim', claims)
  ctx.provide('lubanNightScheduler', scheduler)
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('taskboard'),
      handler: api.handler,
    })
    scheduler.start()
    return async (): Promise<void> => {
      unregister()
      api.dispose()
      await scheduler.dispose()
    }
  }, 'luban-taskboard: route, stream, and scheduler lifecycle')
}

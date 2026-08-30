import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  AgentClaimService,
  AuthService,
  BrowserAdapter,
  NightScheduler,
  TaskOutput,
  TaskStore,
} from 'dsh-luban-core'
import { BridgeProcess } from './bridge-process.js'
import { BrowserService } from './browser-service.js'
import { resolveConfig, type Config } from './config.js'
import { BrowserHttpApi } from './http-api.js'
import { BrowserTaskboardAutomation } from './taskboard-automation.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanBrowser: BrowserAdapter
    lubanTaskStore: TaskStore
    lubanAgentClaim: AgentClaimService
    lubanNightScheduler: NightScheduler
  }

  interface Events {
    'luban.browser.progress'(runId: string, step: number, screenshot: string | undefined): void
  }
}

export const name = 'luban-browser'
export const inject = ['webServer', 'lubanAuth']

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('luban-browser')
  const bridge = new BridgeProcess({
    config: resolved.bridge,
    log: (line): void => logger.warn(line),
  })
  const service = new BrowserService({ config: resolved, bridge })
  const auth = ctx.get('lubanAuth') as AuthService
  const api = new BrowserHttpApi(service, service, auth)

  ctx.provide('lubanBrowser', service)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/luban-browser', handler: api.handler }),
    'luban-browser: authenticated HTTP API',
  )
  ctx.effect(
    () =>
      service.subscribe((event): void => {
        const detail = event.event
        if (detail?.type === 'progress') {
          ctx.emit('luban.browser.progress', detail.runId, detail.step, undefined)
        } else if (detail?.type === 'screenshot') {
          ctx.emit('luban.browser.progress', detail.runId, event.job.progressStep, detail.path)
        }
      }),
    'luban-browser: progress event relay',
  )
  ctx.effect(() => (): void => api.close(), 'luban-browser: close HTTP streams')
  ctx.effect(
    () => async (): Promise<void> => service.close(),
    'luban-browser: stop queue and bridge',
  )

  if (resolved.taskboardAutoRun) {
    ctx.inject(
      ['lubanTaskStore', 'lubanAgentClaim', 'lubanNightScheduler'],
      (taskContext): (() => void) => {
        const store = taskContext.get('lubanTaskStore')
        const claims = taskContext.get('lubanAgentClaim')
        const scheduler = taskContext.get('lubanNightScheduler')
        if (store === undefined || claims === undefined || scheduler === undefined) {
          throw new Error('Browser taskboard automation services are unavailable')
        }
        const automation = new BrowserTaskboardAutomation(service, claims)
        const unregister = scheduler.registerTaskExecutor({
          id: 'luban-browser',
          matches: (task): boolean => task.tags.includes('browser'),
          executor: {
            execute: (task, sessionId): Promise<TaskOutput> =>
              automation.executeNightTask(task, sessionId),
          },
        })
        const unbind = automation.bind(store)
        return (): void => {
          unbind()
          unregister()
        }
      },
    )
  }
}

export { BridgeProcess } from './bridge-process.js'
export { BrowserService } from './browser-service.js'
export { resolveConfig } from './config.js'
export { BrowserError } from './errors.js'
export { BrowserHttpApi } from './http-api.js'
export { BrowserTaskboardAutomation } from './taskboard-automation.js'
export { TemplateRepository, renderTemplate } from './templates.js'
export type { Config } from './config.js'
export type * from './types.js'

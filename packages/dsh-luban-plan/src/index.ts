import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type { AuthService, TaskStore } from 'dsh-luban-core'
import { LubanError, asSessionId, modulePrefix, systemClock } from 'dsh-luban-core'
import { Config as ConfigSchema, type Config as PlanConfig, parseConfig } from './config.js'
import { DshPlanFeedbackSink } from './dsh-feedback.js'
import { PlanHttpApi } from './http-api.js'
import { PlanRepository } from './repository.js'
import { FilePlanService, type PlanServiceWithFeedback } from './service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanPlan: PlanServiceWithFeedback
  }
}

export const name = 'luban-plan'
export const inject = ['tools', 'agents', 'webServer', 'lubanAuth']
export const provide = 'lubanPlan'
export const Config = ConfigSchema
export type Config = PlanConfig
export { parseConfig } from './config.js'
export { DshPlanFeedbackSink } from './dsh-feedback.js'
export { ApprovalPlanGuard } from './guard.js'
export { PlanEventStream, PlanHttpApi } from './http-api.js'
export { normalizeSlug, PlanRepository } from './repository.js'
export type { StoredPlan } from './repository.js'
export { FilePlanService } from './service.js'
export type { PlanFeedbackEvent, PlanFeedbackSink, PlanServiceWithFeedback } from './service.js'
export {
  bundledTemplate,
  PLAN_SECTION_LABELS,
  renderPlanDocument,
  validateSections,
} from './template.js'

/** Mount the plan service, authenticated review API, and rc2 monotonic tool guard. */
export async function apply(ctx: Context, input: Partial<PlanConfig> = {}): Promise<void> {
  const config = parseConfig(input)
  const auth = ctx.get('lubanAuth') as AuthService | undefined
  if (auth === undefined) throw new LubanError('E_UNAVAILABLE', 'lubanAuth is unavailable')
  const service = new FilePlanService({
    repository: new PlanRepository(config.stateFile, config.plansDir, systemClock),
    accountSessions: auth.accountSessions,
    protectedTools: config.requireApprovalFor,
    exemptTools: config.autoApproveFor,
    taskStoreProvider: (): TaskStore | undefined =>
      ctx.get('lubanTaskStore') as TaskStore | undefined,
    sink: new DshPlanFeedbackSink(ctx.agents),
    onError: (error: unknown): void => ctx.logger.warn(error),
  })
  await service.initialize()
  const api = new PlanHttpApi(service, auth)
  ctx.provide('lubanPlan', service)
  ctx.effect(() => {
    const unregisterRoute = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('plan'),
      handler: api.handler,
    })
    const unregisterGuard = ctx.tools.guard((execution): string | undefined => {
      const sessionId = execution.agent === undefined ? undefined : asSessionId(execution.agent.id)
      const plan = sessionId === undefined ? null : service.currentForSession(sessionId)
      const result = service.guard().assertExecutable(execution.name, plan)
      return result.ok ? undefined : (result.reason ?? 'Luban plan approval is required')
    })
    return (): void => {
      unregisterGuard()
      unregisterRoute()
      api.dispose()
    }
  }, 'luban-plan: route and approval guard lifecycle')
}

const plugin = Object.freeze({ name, inject, provide, Config, apply })
export default plugin

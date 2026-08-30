import type { Plan, PlanGuard, PlanGuardResult } from 'dsh-luban-core'

const TOOL_CATEGORIES: Readonly<Record<string, readonly RegExp[]>> = Object.freeze({
  bash: [/shell/u, /bash/u, /command/u, /exec/u, /terminal/u, /^run_/u],
  edit: [/edit/u, /patch/u, /write/u, /create/u, /delete/u, /remove/u, /move/u, /rename/u],
  write: [/write/u, /create/u, /patch/u, /apply_patch/u],
})

function globPattern(value: string): RegExp {
  const escaped = value.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`, 'u')
}

function matches(tool: string, rule: string): boolean {
  const normalizedTool = tool.toLowerCase()
  const normalizedRule = rule.toLowerCase()
  if (normalizedTool === normalizedRule) return true
  if (normalizedRule.includes('*')) return globPattern(normalizedRule).test(normalizedTool)
  return (
    TOOL_CATEGORIES[normalizedRule]?.some((pattern): boolean => pattern.test(normalizedTool)) ??
    false
  )
}

/** Pure approval guard used both by the service and DSH's monotonic tool guard. */
export class ApprovalPlanGuard implements PlanGuard {
  readonly #protected: readonly string[]
  readonly #exempt: readonly string[]

  public constructor(protectedTools: readonly string[], exemptTools: readonly string[]) {
    this.#protected = protectedTools
    this.#exempt = exemptTools
  }

  public assertExecutable(tool: string, plan: Plan | null): PlanGuardResult {
    if (this.#exempt.some((rule): boolean => matches(tool, rule))) return { ok: true }
    if (!this.#protected.some((rule): boolean => matches(tool, rule))) return { ok: true }
    if (plan?.status === 'approved' || plan?.status === 'executing') return { ok: true }
    return {
      ok: false,
      reason:
        plan === null
          ? `Tool ${tool} requires an approved Luban plan for this session`
          : `Tool ${tool} is blocked while plan ${plan.id} is ${plan.status}`,
    }
  }
}

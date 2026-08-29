import type { Plan, PlanSections } from '@luban/core'
import { LubanError } from '@luban/core'

export const PLAN_SECTION_LABELS = Object.freeze({
  background: '1. Background / Requirement',
  impact: '2. Impact Scope',
  changes: '3. Change Locations',
  verification: '4. Verification',
} satisfies Readonly<Record<keyof PlanSections, string>>)

export function validateSections(sections: PlanSections): void {
  const missing = (Object.keys(PLAN_SECTION_LABELS) as (keyof PlanSections)[]).filter(
    (key): boolean => sections[key].trim() === '',
  )
  if (missing.length > 0) {
    throw new LubanError(
      'E_INVALID_INPUT',
      `Plan is missing required sections: ${missing.join(', ')}`,
      {
        details: { missing },
      },
    )
  }
}

function decisionLines(plan: Plan): string {
  if (plan.decisions.length === 0) return '_No decisions yet._'
  return plan.decisions
    .map((record): string => {
      const identity = record.by.displayName ?? record.by.id
      const comment = record.comment === undefined ? '' : ` — ${record.comment}`
      return `- ${new Date(record.at).toISOString()} · **${record.decision}** by ${identity}${comment}`
    })
    .join('\n')
}

/** Render the repository-owned, human-readable four-section plan document. */
export function renderPlanDocument(plan: Plan): string {
  return [
    `# Plan ${plan.id}`,
    '',
    `- Status: \`${plan.status}\``,
    `- Version: ${String(plan.version)}`,
    ...(plan.taskId === undefined ? [] : [`- Task: \`${plan.taskId}\``]),
    ...(plan.sessionId === undefined ? [] : [`- Session: \`${plan.sessionId}\``]),
    '',
    `## ${PLAN_SECTION_LABELS.background}`,
    '',
    plan.sections.background.trim(),
    '',
    `## ${PLAN_SECTION_LABELS.impact}`,
    '',
    plan.sections.impact.trim(),
    '',
    `## ${PLAN_SECTION_LABELS.changes}`,
    '',
    plan.sections.changes.trim(),
    '',
    `## ${PLAN_SECTION_LABELS.verification}`,
    '',
    plan.sections.verification.trim(),
    '',
    '## Approval History',
    '',
    decisionLines(plan),
    '',
  ].join('\n')
}

export function bundledTemplate(): string {
  return [
    '# Plan',
    '',
    `## ${PLAN_SECTION_LABELS.background}`,
    '',
    '<!-- Why is this change needed? -->',
    '',
    `## ${PLAN_SECTION_LABELS.impact}`,
    '',
    '<!-- Which modules, users, and risks are affected? -->',
    '',
    `## ${PLAN_SECTION_LABELS.changes}`,
    '',
    '<!-- List exact files or components to modify. -->',
    '',
    `## ${PLAN_SECTION_LABELS.verification}`,
    '',
    '<!-- List lint, typecheck, build, tests, and manual checks. -->',
    '',
  ].join('\n')
}

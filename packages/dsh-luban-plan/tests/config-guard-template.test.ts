import { describe, expect, it } from 'vitest'
import type { Plan } from 'dsh-luban-core'
import { asPlanId } from 'dsh-luban-core'
import { parseConfig } from '../src/config.js'
import { ApprovalPlanGuard } from '../src/guard.js'
import { bundledTemplate, renderPlanDocument, validateSections } from '../src/template.js'

const sections = {
  background: 'A requirement',
  impact: 'Packages A and B',
  changes: 'src/a.ts',
  verification: 'Run lint and tests',
} as const

const approved: Plan = {
  id: asPlanId('P-1'),
  status: 'approved',
  sections,
  filePath: 'docs/plans/x.md',
  decisions: [],
  version: 2,
}

describe('plan config, template, and guard', () => {
  it('uses a zero-dependency Standard Schema config and rejects workspace escapes', () => {
    const config = parseConfig({
      requireApprovalFor: ['write', 'write'],
      autoApproveFor: ['read_file'],
    })
    expect(config.requireApprovalFor).toEqual(['write'])
    expect(config.autoApproveFor).toEqual(['read_file'])
    expect(() => parseConfig({ plansDir: '../elsewhere' })).toThrow(/inside each workspace/u)
    expect(() => parseConfig({ plansDir: '.' })).toThrow(/inside each workspace/u)
  })

  it('requires and renders all four plan elements', () => {
    expect(() => validateSections({ ...sections, verification: ' ' })).toThrow(/verification/u)
    const document = renderPlanDocument({ ...approved, status: 'in-review' })
    expect(document).toContain('Background / Requirement')
    expect(document).toContain('Impact Scope')
    expect(document).toContain('Change Locations')
    expect(document).toContain('Verification')
    expect(bundledTemplate()).toContain('<!-- List lint, typecheck, build, tests')
  })

  it('blocks protected tool categories until approval and honors narrow exemptions', () => {
    const guard = new ApprovalPlanGuard(['edit', 'bash'], ['read_*'])
    expect(guard.assertExecutable('read_file', null)).toEqual({ ok: true })
    expect(guard.assertExecutable('apply_patch', null)).toMatchObject({ ok: false })
    expect(
      guard.assertExecutable('shell_command', { ...approved, status: 'rejected' }),
    ).toMatchObject({ ok: false })
    expect(guard.assertExecutable('shell_command', approved)).toEqual({ ok: true })
    expect(guard.assertExecutable('web_search', null)).toEqual({ ok: true })
  })
})

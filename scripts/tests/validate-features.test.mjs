import { describe, expect, it } from 'vitest'
import { formatMilestoneRollup, validateFeatureLedger } from '../validate-features.mjs'

const statusLegend = Object.freeze({
  todo: 'Not started',
  doing: 'In progress',
  review: 'Ready for acceptance',
  done: 'Accepted',
  blocked: 'Blocked',
  dropped: 'Dropped',
})

function feature(id, requirement, milestone, status) {
  return {
    id,
    requirement,
    milestone,
    status,
    updatedAt: '2026-08-30',
    notes: ['Direct evidence or an explicit unblock condition'],
  }
}

function validChecklist() {
  return {
    statusLegend: { ...statusLegend },
    requirements: [
      { id: 'R01', status: 'blocked' },
      { id: 'R02', status: 'dropped' },
      { id: 'R03', status: 'review' },
    ],
    milestones: [
      { id: 'MS1', featureIds: ['M01-F001', 'M01-F002', 'M01-F003'] },
      { id: 'MS2', featureIds: ['M02-F001'] },
      { id: 'MS3', featureIds: ['M03-F001', 'M03-F002'] },
    ],
    features: [
      feature('M01-F001', 'R01', 'MS1', 'done'),
      feature('M01-F002', 'R01', 'MS1', 'blocked'),
      feature('M01-F003', 'R01', 'MS1', 'dropped'),
      feature('M02-F001', 'R02', 'MS2', 'dropped'),
      feature('M03-F001', 'R03', 'MS3', 'done'),
      feature('M03-F002', 'R03', 'MS3', 'review'),
    ],
  }
}

describe('feature ledger status validation', () => {
  it('derives requirement and milestone statuses with the documented priority', () => {
    const result = validateFeatureLedger(validChecklist())

    expect(result.findings).toEqual([])
    expect(result.requirementRollups.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'R01', status: 'blocked' },
      { id: 'R02', status: 'dropped' },
      { id: 'R03', status: 'review' },
    ])
    expect(result.milestoneRollups.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'MS1', status: 'blocked' },
      { id: 'MS2', status: 'dropped' },
      { id: 'MS3', status: 'review' },
    ])
    expect(result.milestoneRollups[0]).toMatchObject({
      featureCount: 3,
      counts: { blocked: 1, done: 1, dropped: 1 },
    })
    expect(formatMilestoneRollup(result.milestoneRollups[0])).toContain(
      'Milestone MS1: status=blocked; features=3',
    )
  })

  it('requires feature and requirement statuses to be defined by a complete legend', () => {
    const checklist = validChecklist()
    delete checklist.statusLegend.todo
    checklist.features[0].status = 'invented'
    checklist.requirements[0].status = 'invented'

    const { findings } = validateFeatureLedger(checklist)

    expect(findings).toContain('statusLegend is missing required status "todo"')
    expect(findings).toContain('feature M01-F001 status "invented" is not defined in statusLegend')
    expect(findings).toContain('requirement R01 status "invented" is not defined in statusLegend')
  })

  it('rejects a requirement status that differs from its directly associated features', () => {
    const checklist = validChecklist()
    checklist.requirements[0].status = 'done'

    const { findings } = validateFeatureLedger(checklist)

    expect(findings).toContain(
      'requirement R01 status "done" does not match direct feature rollup "blocked" (priority: blocked > doing > todo > review > done; all dropped => dropped)',
    )
  })

  it('reports milestone membership errors in both directions and rejects persisted status', () => {
    const checklist = validChecklist()
    checklist.milestones[0].status = 'blocked'
    checklist.milestones[0].featureIds = ['M01-F001', 'M01-F001', 'M02-F001', 'M99-F999']

    const { findings } = validateFeatureLedger(checklist)

    expect(findings).toContain('milestone MS1 must not persist status; derive it from featureIds')
    expect(findings).toContain('milestone MS1 lists feature M01-F001 more than once')
    expect(findings).toContain(
      'milestone MS1 lists feature M02-F001, but that feature declares milestone "MS2"',
    )
    expect(findings).toContain('milestone MS1 featureIds references unknown feature M99-F999')
    expect(findings).toContain(
      'feature M01-F002 declares milestone "MS1" but is missing from that milestone\'s featureIds',
    )
  })

  it('fails clearly when a requirement or milestone has no directly associated features', () => {
    const checklist = validChecklist()
    checklist.requirements.push({ id: 'R04', status: 'todo' })
    checklist.milestones.push({ id: 'MS4', featureIds: [] })

    const { findings, milestoneRollups } = validateFeatureLedger(checklist)

    expect(findings).toContain(
      'requirement R04 has no directly associated features; status cannot be derived',
    )
    expect(findings).toContain('milestone MS4 has no featureIds; status cannot be derived')
    expect(milestoneRollups.at(-1)).toMatchObject({
      id: 'MS4',
      status: null,
      featureCount: 0,
    })
  })
})

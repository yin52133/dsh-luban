import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { asPlanId, asSessionId } from '@luban/core'
import { DshPlanFeedbackSink } from '../src/dsh-feedback.js'
import type { PlanFeedbackEvent } from '../src/service.js'

function event(decision?: 'approve' | 'reject'): PlanFeedbackEvent {
  return {
    type: 'luban.plan.feedback',
    planId: asPlanId('P-1'),
    sessionId: asSessionId('session-1'),
    status: decision === 'reject' ? 'rejected' : 'approved',
    ...(decision === undefined ? {} : { decision }),
    filePath: 'docs/plans/plan.md',
    version: 2,
    at: 1,
  }
}

describe('DshPlanFeedbackSink', () => {
  it('wakes an agent with structured decisions and passively injects status updates', () => {
    const followup = vi.fn<Agent['followup']>()
    const inject = vi.fn<Agent['inject']>()
    const agent = { followup, inject } as unknown as Agent
    const agents = { get: (): Agent => agent } as unknown as AgentRegistry
    const sink = new DshPlanFeedbackSink(agents)
    sink.deliver(event('reject'))
    sink.deliver(event())
    expect(followup).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(followup.mock.calls[0]?.[0])).toContain('luban.plan.feedback')
    expect(JSON.stringify(followup.mock.calls[0]?.[0])).toContain('rejected')
  })
})

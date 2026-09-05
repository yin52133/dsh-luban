import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AccountSessionRegistry } from '@yin52133/dsh-luban-core'
import { asAccountId, asActorId, asSessionId } from '@yin52133/dsh-luban-core'
import { describe, expect, it } from 'vitest'
import { DshPlanFeedbackSink } from '../src/dsh-feedback.js'
import { PlanRepository } from '../src/repository.js'
import { FilePlanService } from '../src/service.js'

function inboxBackedAgent(context: Context, session: Session): Agent {
  const inbox = new Inbox(session, {
    inserted: (): void => undefined,
    discarded: (): void => undefined,
    claimed: (): void => undefined,
  })
  return {
    id: session.id,
    options: { provider: 'test', model: 'test' },
    session,
    inbox,
    status: 'idle',
    ctx: context,
    cancel: (): void => undefined,
    whenIdle: (): Promise<void> => Promise.resolve(),
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
    send(message, target, _wakeup): void {
      inbox.append(target, message)
    },
    followup(message): void {
      inbox.append('next-turn', message)
    },
    steer(message): void {
      inbox.append('next-step', message)
    },
    inject(message): void {
      inbox.append('next-step', message)
    },
  }
}

describe('DshPlanFeedbackSink', () => {
  it('routes a real plan rejection into the identified DSH session inbox durably', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-plan-feedback-'))
    const context = new Context()
    const agentsFiber = context.plugin(AgentRegistry)
    await agentsFiber
    const targetSession = Session.create(SessionId('session-1'))
    const otherSession = Session.create(SessionId('session-2'))
    const targetAgent = inboxBackedAgent(context, targetSession)
    const otherAgent = inboxBackedAgent(context, otherSession)
    const unregisterTarget = context.agents.register(targetAgent)
    const unregisterOther = context.agents.register(otherAgent)

    try {
      const accountId = asAccountId('reviewer')
      const accountSessions: AccountSessionRegistry = {
        bind: (): Promise<void> => Promise.resolve(),
        ownerOf: (): Promise<typeof accountId> => Promise.resolve(accountId),
      }
      const sessionId = asSessionId(targetSession.id)
      const service = new FilePlanService({
        repository: new PlanRepository(join(directory, 'plans.json'), 'docs/plans', {
          now: (): number => 1,
        }),
        accountSessions,
        protectedTools: [],
        exemptTools: [],
        sink: new DshPlanFeedbackSink(context.agents),
      })
      await service.initialize()
      const submitted = await service.submit({
        accountId,
        workspace: directory,
        slug: 'feedback-proof',
        sessionId,
        sections: {
          background: 'Need a safe change',
          impact: 'One plugin',
          changes: 'src/index.ts',
          verification: 'Run package checks',
        },
      })
      const rejected = await service.decide(
        submitted.id,
        {
          decision: 'reject',
          comment: 'Add rollback verification',
          expectedVersion: submitted.version,
        },
        {
          kind: 'user',
          id: asActorId('reviewer'),
          accountId,
          displayName: 'Reviewer',
        },
      )

      expect(context.agents.get(targetSession.id)).toBe(targetAgent)
      expect(targetAgent.inbox.nextTurn).toHaveLength(1)
      expect(targetAgent.inbox.nextStep).toHaveLength(1)
      expect(otherAgent.inbox.hasPending).toBe(false)
      expect(otherSession.snapshotEvents()).toEqual([])

      const rejectionMessage = targetAgent.inbox.nextTurn[0]
      expect(rejectionMessage).toMatchObject({
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-luban-plan' },
      })
      const rejectionBlock = rejectionMessage?.content[0]
      if (rejectionBlock?.type !== 'text') throw new Error('rejection feedback was not text')
      expect(JSON.parse(rejectionBlock.text)).toMatchObject({
        type: 'luban.plan.feedback',
        planId: submitted.id,
        sessionId,
        status: 'rejected',
        decision: 'reject',
        comment: 'Add rollback verification',
        reviewer: {
          kind: 'user',
          id: 'reviewer',
          accountId: 'reviewer',
          displayName: 'Reviewer',
        },
        filePath: rejected.filePath,
        version: rejected.version,
      })

      const statusMessage = targetAgent.inbox.nextStep[0]
      expect(statusMessage).toMatchObject({
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-luban-plan' },
      })
      const statusBlock = statusMessage?.content[0]
      if (statusBlock?.type !== 'text') throw new Error('status feedback was not text')
      expect(JSON.parse(statusBlock.text)).toMatchObject({
        type: 'luban.plan.feedback',
        planId: submitted.id,
        sessionId,
        status: 'in-review',
        version: submitted.version,
      })
      expect(targetSession.snapshotEvents()).toEqual([
        expect.objectContaining({
          seq: 0,
          type: 'agent/inbox/spliced',
          data: {
            target: 'next-step',
            start: 0,
            inserted: [statusMessage],
          },
        }),
        expect.objectContaining({
          seq: 1,
          type: 'agent/inbox/spliced',
          data: {
            target: 'next-turn',
            start: 0,
            inserted: [rejectionMessage],
          },
        }),
      ])

      const replayedSession = Session.create(targetSession.id, targetSession.snapshotEvents())
      const replayedInbox = new Inbox(replayedSession, {
        inserted: (): void => undefined,
        discarded: (): void => undefined,
        claimed: (): void => undefined,
      })
      expect(replayedInbox.nextTurn).toEqual([rejectionMessage])
      expect(replayedInbox.nextStep).toEqual([statusMessage])
    } finally {
      unregisterOther()
      unregisterTarget()
      await agentsFiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

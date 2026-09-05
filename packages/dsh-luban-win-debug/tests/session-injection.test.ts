import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { AgentRegistry, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { asSessionId } from '@yin52133/dsh-luban-core'
import { describe, expect, it } from 'vitest'
import { SerialChannelAdapter } from '../src/serial.js'
import { DshSessionInjection } from '../src/session-injector.js'
import { DefaultWinDebugService } from '../src/service.js'
import {
  FakeCommandRunner,
  FakeSerialProvider,
  flush,
  memoryAccountSessions,
  TEST_ACCOUNT,
  testConfig,
} from './helpers.js'

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

describe('serial snippet session injection', (): void => {
  it('persists a redacted selection into only the identified DSH session inbox durably', async (): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'luban-win-debug-session-'))
    const context = new Context()
    const agentsFiber = context.plugin(AgentRegistry)
    await agentsFiber
    const targetSession = Session.create(SessionId('win-debug-target'))
    const otherSession = Session.create(SessionId('win-debug-other'))
    const targetAgent = inboxBackedAgent(context, targetSession)
    const otherAgent = inboxBackedAgent(context, otherSession)
    const unregisterTarget = context.agents.register(targetAgent)
    const unregisterOther = context.agents.register(otherAgent)
    const config = testConfig(root)
    const serialProvider = new FakeSerialProvider()
    const service = new DefaultWinDebugService(config, {
      adapters: [new SerialChannelAdapter(serialProvider)],
      commands: new FakeCommandRunner(),
      sessionInjection: new DshSessionInjection(context.agents),
      accountSessions: memoryAccountSessions([[TEST_ACCOUNT, asSessionId(targetSession.id)]]),
    })

    try {
      const channel = await service.open(TEST_ACCOUNT, 'serial:COM3')
      serialProvider.connections[0]?.emit(
        [
          'outside-before',
          'boot ok',
          'token=super-secret-value',
          'fatal: target halted',
          'outside-after',
          '',
        ].join('\n'),
      )
      await flush()
      const lines = service.lines(TEST_ACCOUNT, channel.id)
      const from = lines.find((line): boolean => line.text === 'boot ok')?.sequence
      const to = lines.find((line): boolean => line.text === 'fatal: target halted')?.sequence
      if (from === undefined || to === undefined) throw new Error('missing selected serial lines')

      const snippet = await service.captureAndInject(
        TEST_ACCOUNT,
        channel.id,
        { from, to },
        asSessionId(targetSession.id),
      )

      expect(dirname(dirname(snippet.path))).toBe(config.snippet.dir)
      expect(basename(snippet.path)).toMatch(/^serial-\d+-[0-9a-f-]+\.log$/u)
      expect(await readdir(dirname(snippet.path))).toEqual([basename(snippet.path)])
      expect(snippet.accountId).toBe(TEST_ACCOUNT)
      expect(await readFile(snippet.path, 'utf8')).toBe(`${snippet.content}\n`)
      expect(snippet.content).toContain('boot ok')
      expect(snippet.content).toContain('token=[REDACTED]')
      expect(snippet.content).toContain('fatal: target halted')
      expect(snippet.content).not.toContain('super-secret-value')
      expect(snippet.content).not.toContain('outside-before')
      expect(snippet.content).not.toContain('outside-after')
      expect(snippet.endpoint).toEqual({
        kind: 'serial',
        id: 'serial:COM3',
        label: 'COM3 · Fake Probe',
        params: { port: 'COM3', manufacturer: 'Fake Probe' },
      })

      expect(context.agents.get(targetSession.id)).toBe(targetAgent)
      expect(targetAgent.inbox.nextTurn).toHaveLength(1)
      expect(targetAgent.inbox.nextStep).toHaveLength(0)
      expect(otherAgent.inbox.hasPending).toBe(false)
      expect(otherSession.snapshotEvents()).toEqual([])

      const message = targetAgent.inbox.nextTurn[0]
      expect(message).toMatchObject({
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-luban-win-debug' },
      })
      const block = message?.content[0]
      if (block?.type !== 'text') throw new Error('debug snippet injection was not text')
      expect(block.text).toContain(`File: ${snippet.path}`)
      expect(block.text).toContain('Channel: serial · COM3 · Fake Probe')
      expect(block.text).toContain('Endpoint metadata: {"port":"COM3","manufacturer":"Fake Probe"}')
      expect(block.text).toContain(
        `Window: ${new Date(snippet.timeFrom).toISOString()} — ${new Date(snippet.timeTo).toISOString()}`,
      )
      expect(block.text).toContain('boot ok')
      expect(block.text).toContain('token=[REDACTED]')
      expect(block.text).toContain('fatal: target halted')
      expect(block.text).not.toContain('super-secret-value')
      expect(block.text).not.toContain('outside-before')
      expect(block.text).not.toContain('outside-after')

      expect(targetSession.snapshotEvents()).toEqual([
        expect.objectContaining({
          seq: 0,
          type: 'agent/inbox/spliced',
          data: {
            target: 'next-turn',
            start: 0,
            inserted: [message],
          },
        }),
      ])
      const replayedSession = Session.create(targetSession.id, targetSession.snapshotEvents())
      const replayedInbox = new Inbox(replayedSession, {
        inserted: (): void => undefined,
        discarded: (): void => undefined,
        claimed: (): void => undefined,
      })
      expect(replayedInbox.nextTurn).toEqual([message])
      expect(replayedInbox.nextStep).toEqual([])
    } finally {
      await service.dispose()
      unregisterOther()
      unregisterTarget()
      await agentsFiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
